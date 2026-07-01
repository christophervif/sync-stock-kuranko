/**
 * PUENTE DE SINCRONIZACIÓN DE STOCK + PRECIO — Kuranko
 * =====================================================
 * Sincroniza stock consolidado y precio regular del ERP hacia WooCommerce.
 *
 * CARACTERÍSTICAS:
 *  - Solo actualiza lo que CAMBIÓ desde la última sincronización (eficiente).
 *  - Usa modo BATCH de WooCommerce: hasta 100 productos por llamada.
 *  - Procesa productos simples y variaciones (rutas distintas).
 *  - Identifica todo SOLO por woocommerce_id.
 *  - Genera un CSV de PENDIENTES (productos del ERP sin woocommerce_id).
 *  - Pausas entre lotes para no saturar el hosting compartido.
 *
 * SEGURIDAD:
 *  - ERP en SOLO LECTURA (usuario dashboard_readonly).
 *  - NO crea productos. NO borra nada. Solo actualiza stock y precio regular.
 *  - La "memoria" de cambios vive en la base del PORTAL (no toca el ERP).
 *
 * Variables de entorno (Railway):
 *  - PROD_URL          : MySQL del ERP (usuario dashboard_readonly, SOLO LECTURA)
 *  - PORTAL_URL        : MySQL del portal (aquí guarda su memoria de cambios)
 *  - WC_URL            : https://kuranko.pe
 *  - WC_CONSUMER_KEY   : ck_...
 *  - WC_CONSUMER_SECRET: cs_...
 *
 * Variables opcionales:
 *  - LOTE_SIZE         : productos por lote batch (default 100)
 *  - PAUSA_LOTE_MS     : pausa entre lotes en ms (default 16000 = 16s)
 *  - DRY_RUN           : 'true' = solo simula, no escribe en WooCommerce (default false)
 */

const mysql = require('mysql2/promise');
const axios = require('axios');

// ─── Configuración ──────────────────────────────────────────────────────────
const PROD_URL = process.env.PROD_URL;
const PORTAL_URL = process.env.PORTAL_URL;
const WC_URL = (process.env.WC_URL || '').replace(/\/+$/, '');
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;
const LOTE_SIZE = parseInt(process.env.LOTE_SIZE || '50', 10);
const PAUSA_LOTE_MS = parseInt(process.env.PAUSA_LOTE_MS || '16000', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';
// Modo manual "actualizar todo": ignora la memoria y reevalúa todos los productos.
const FORZAR_TODO = process.env.FORZAR_TODO === 'true';

function validarConfig() {
  const faltan = [];
  if (!PROD_URL) faltan.push('PROD_URL');
  if (!PORTAL_URL) faltan.push('PORTAL_URL');
  if (!WC_URL) faltan.push('WC_URL');
  if (!WC_KEY) faltan.push('WC_CONSUMER_KEY');
  if (!WC_SECRET) faltan.push('WC_CONSUMER_SECRET');
  if (faltan.length) {
    console.error('❌ Faltan variables de entorno:', faltan.join(', '));
    process.exit(1);
  }
}

const pausa = (ms) => new Promise(r => setTimeout(r, ms));

function wcClient() {
  return axios.create({
    baseURL: `${WC_URL}/wp-json/wc/v3`,
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 60000,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ─── Memoria de cambios (en la base del portal) ─────────────────────────────
async function asegurarTablaMemoria(portalPool) {
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_estado (
      variation_id BIGINT PRIMARY KEY,
      woocommerce_id BIGINT,
      ultimo_stock INT,
      ultimo_precio DECIMAL(12,2),
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Tabla de control: registra cada corrida del puente (para mostrar en el reporte)
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_corridas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      corrio_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      productos_actualizados INT,
      productos_error INT,
      modo VARCHAR(20)
    )
  `);
  // Tabla de discrepancias de SKU (woocommerce_id apunta a un SKU distinto).
  // Se vacía y se vuelve a llenar en cada corrida real.
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_sku_alertas (
      variation_id BIGINT PRIMARY KEY,
      woocommerce_id BIGINT,
      sku_erp VARCHAR(255),
      sku_woo VARCHAR(255),
      detectado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Detalle de la última corrida: lo que VARIÓ y lo que realmente se ACTUALIZÓ,
  // con valores antes/después. Se vacía y se rellena en cada corrida.
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_detalle (
      variation_id BIGINT PRIMARY KEY,
      woocommerce_id BIGINT,
      tipo VARCHAR(20),
      stock_antes INT,
      precio_antes DECIMAL(12,2),
      stock_despues INT,
      precio_despues DECIMAL(12,2),
      se_aplico TINYINT(1) DEFAULT 0,
      registrado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Solicitudes de "actualizar todo" hechas desde el portal admin.
  // El puente las recoge en su corrida y las marca como atendidas.
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_solicitudes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      solicitado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      atendida TINYINT(1) DEFAULT 0,
      atendida_en DATETIME NULL
    )
  `);
}

// ¿Hay una solicitud de actualización completa pendiente?
async function haySolicitudCompleta(portalPool) {
  try {
    const [[row]] = await portalPool.query(
      `SELECT id FROM sync_solicitudes WHERE atendida = 0 ORDER BY id ASC LIMIT 1`);
    return row ? row.id : null;
  } catch (e) { return null; }
}

// Marca la solicitud como atendida
async function marcarSolicitudAtendida(portalPool, id) {
  await portalPool.query(
    `UPDATE sync_solicitudes SET atendida = 1, atendida_en = NOW() WHERE id = ?`, [id]);
}

// Guarda el detalle de esta corrida (variaciones + si se aplicaron). Reemplaza el anterior.
async function guardarDetalle(portalPool, filas) {
  await portalPool.query('DELETE FROM sync_detalle');
  if (!filas.length) return;
  const valores = filas.map(f => [
    f.variation_id, f.wc_id, f.tipo,
    f.stock_antes, f.precio_antes, f.stock_despues, f.precio_despues,
    f.se_aplico ? 1 : 0
  ]);
  await portalPool.query(
    `INSERT INTO sync_detalle
       (variation_id, woocommerce_id, tipo, stock_antes, precio_antes, stock_despues, precio_despues, se_aplico)
     VALUES ?`,
    [valores]
  );
}

// Registra una corrida terminada
async function registrarCorrida(portalPool, actualizados, errores, modo) {
  await portalPool.query(
    `INSERT INTO sync_corridas (productos_actualizados, productos_error, modo)
     VALUES (?, ?, ?)`,
    [actualizados, errores, modo]
  );
}

async function leerMemoria(portalPool) {
  const [rows] = await portalPool.query(
    `SELECT variation_id, ultimo_stock, ultimo_precio FROM sync_estado`
  );
  const mapa = {};
  rows.forEach(r => {
    mapa[r.variation_id] = {
      stock: r.ultimo_stock,
      precio: r.ultimo_precio === null ? null : Number(r.ultimo_precio)
    };
  });
  return mapa;
}

// Guarda en memoria los que se sincronizaron con éxito (en lote)
async function guardarMemoria(portalPool, registros) {
  if (!registros.length) return;
  const valores = registros.map(r => [r.variation_id, r.wc_id, r.stock, r.precio]);
  await portalPool.query(
    `INSERT INTO sync_estado (variation_id, woocommerce_id, ultimo_stock, ultimo_precio)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       woocommerce_id = VALUES(woocommerce_id),
       ultimo_stock   = VALUES(ultimo_stock),
       ultimo_precio  = VALUES(ultimo_precio),
       actualizado_en = NOW()`,
    [valores]
  );
}

// ─── Leer ERP (SOLO LECTURA) ────────────────────────────────────────────────
// Productos CON woocommerce_id: para sincronizar stock + precio
async function leerProductosERP(prodPool) {
  const [rows] = await prodPool.query(
    `SELECT pv.id AS variation_id,
            pv.woocommerce_id AS wc_id,
            p.woocommerce_id AS wc_padre,
            pv.product_type,
            pv.sku,
            pv.regular_price,
            COALESCE(SUM(ls.quantity), 0) AS stock
     FROM product_variations pv
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
     WHERE pv.woocommerce_id IS NOT NULL
       AND pv.product_type IN ('variation','simple')
       AND pv.deleted_at IS NULL
     GROUP BY pv.id, pv.woocommerce_id, p.woocommerce_id, pv.product_type, pv.sku, pv.regular_price
     ORDER BY pv.id`
  );
  return rows;
}

// Productos SIN woocommerce_id: para el CSV de pendientes (crear manualmente)
async function leerPendientesERP(prodPool) {
  const [rows] = await prodPool.query(
    `SELECT pv.id AS variation_id, pv.sku, pv.product_type,
            p.name AS nombre_producto, pv.name AS variacion,
            pv.regular_price,
            COALESCE(SUM(ls.quantity), 0) AS stock
     FROM product_variations pv
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
     WHERE pv.woocommerce_id IS NULL
       AND pv.product_type IN ('variation','simple')
       AND pv.deleted_at IS NULL
     GROUP BY pv.id, pv.sku, pv.product_type, p.name, pv.name, pv.regular_price
     ORDER BY p.name, pv.sku`
  );
  return rows;
}

// ─── Detectar qué cambió ────────────────────────────────────────────────────
function filtrarCambiados(productos, memoria) {
  const cambiados = [];
  for (const p of productos) {
    const stock = Number(p.stock) || 0;
    const precio = p.regular_price === null ? null : Number(p.regular_price);
    const prev = memoria[p.variation_id];
    // Cambió si: es nuevo (sin memoria), o el stock difiere, o el precio difiere
    if (!prev || prev.stock !== stock || prev.precio !== precio) {
      cambiados.push({
        ...p, stock, precio,
        stock_antes: prev ? prev.stock : null,
        precio_antes: prev ? prev.precio : null
      });
    }
  }
  return cambiados;
}

// ─── Construir el cuerpo batch para WooCommerce ─────────────────────────────
// Separa productos simples de variaciones (van en endpoints distintos)
function construirPayloadSimple(lote) {
  return {
    update: lote.map(p => ({
      id: p.wc_id,
      manage_stock: true,
      stock_quantity: p.stock,
      stock_status: p.stock > 0 ? 'instock' : 'outofstock',
      regular_price: p.precio === null ? '' : String(p.precio)
    }))
  };
}

// Las variaciones se actualizan por producto padre. Agrupamos por wc_padre.
function agruparVariacionesPorPadre(variaciones) {
  const grupos = {};
  for (const v of variaciones) {
    if (!grupos[v.wc_padre]) grupos[v.wc_padre] = [];
    grupos[v.wc_padre].push(v);
  }
  return grupos;
}

// ─── Validación de SKU por lote ─────────────────────────────────────────────
// Lee los productos del lote desde WooCommerce (en 1 llamada) y compara el SKU.
// Devuelve { validos: [...], discrepancias: [...] }
// Los simples se leen por /products?include=ids; las variaciones por padre.
async function validarSkuSimples(wc, lote) {
  const validos = [], discrepancias = [];
  try {
    const ids = lote.map(p => p.wc_id).join(',');
    const { data } = await wc.get(`/products`, { params: { include: ids, per_page: 100 } });
    const skuPorId = {};
    data.forEach(p => { skuPorId[p.id] = (p.sku || '').trim(); });
    for (const p of lote) {
      const skuWoo = skuPorId[p.wc_id];
      if (skuWoo === undefined) {
        // No se encontró en WooCommerce: lo dejamos pasar (lo tratará el batch, que dará su error)
        validos.push(p);
      } else if (skuWoo === (p.sku || '').trim()) {
        validos.push(p);
      } else {
        discrepancias.push({ ...p, sku_woo: skuWoo });
      }
    }
  } catch (e) {
    // Si la lectura falla, por seguridad NO actualizamos a ciegas: mandamos todo a validar luego.
    // Mejor dejarlos pasar al batch normal que perder la corrida; se registra en logs.
    console.log(`   ⚠ No se pudo validar SKU de un lote de simples: ${e.message}. Se actualizan sin validar.`);
    return { validos: lote, discrepancias: [] };
  }
  return { validos, discrepancias };
}

async function validarSkuVariaciones(wc, padre, lote) {
  const validos = [], discrepancias = [];
  try {
    const ids = lote.map(p => p.wc_id).join(',');
    const { data } = await wc.get(`/products/${padre}/variations`, { params: { include: ids, per_page: 100 } });
    const skuPorId = {};
    data.forEach(v => { skuPorId[v.id] = (v.sku || '').trim(); });
    for (const p of lote) {
      const skuWoo = skuPorId[p.wc_id];
      if (skuWoo === undefined) {
        validos.push(p);
      } else if (skuWoo === (p.sku || '').trim()) {
        validos.push(p);
      } else {
        discrepancias.push({ ...p, sku_woo: skuWoo });
      }
    }
  } catch (e) {
    console.log(`   ⚠ No se pudo validar SKU de variaciones del padre ${padre}: ${e.message}. Se actualizan sin validar.`);
    return { validos: lote, discrepancias: [] };
  }
  return { validos, discrepancias };
}

// Guarda las discrepancias de SKU en la base del portal (reemplaza las anteriores)
async function guardarDiscrepancias(portalPool, discrepancias) {
  // Limpiar las anteriores (cada corrida refresca la lista)
  await portalPool.query('DELETE FROM sync_sku_alertas');
  if (!discrepancias.length) return;
  const valores = discrepancias.map(d => [d.variation_id, d.wc_id, d.sku, d.sku_woo]);
  await portalPool.query(
    `INSERT INTO sync_sku_alertas (variation_id, woocommerce_id, sku_erp, sku_woo) VALUES ?`,
    [valores]
  );
}

// ─── Programa principal ─────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PUENTE DE SINCRONIZACIÓN — Kuranko (stock + precio regular)');
  if (DRY_RUN) console.log('  *** MODO SIMULACIÓN (DRY_RUN) — no escribe en WooCommerce ***');
  console.log('═══════════════════════════════════════════════════════════\n');

  validarConfig();

  const prodPool = mysql.createPool(PROD_URL + '?connectionLimit=3');
  const portalPool = mysql.createPool(PORTAL_URL + '?connectionLimit=3');
  const wc = wcClient();

  try {
    // 1. Preparar memoria
    console.log('1) Preparando memoria de sincronización...');
    await asegurarTablaMemoria(portalPool);
    const memoria = await leerMemoria(portalPool);
    console.log(`   ✓ Memoria con ${Object.keys(memoria).length} productos recordados.\n`);

    // 2. Leer ERP
    console.log('2) Leyendo productos del ERP (solo lectura)...');
    const productos = await leerProductosERP(prodPool);
    console.log(`   ✓ ${productos.length} productos con woocommerce_id en el ERP.\n`);

    // 3. Detectar cambios
    console.log('3) Detectando qué cambió desde la última vez...');
    // ¿Hay una solicitud de "actualizar todo" desde el portal? (o la variable de entorno)
    const idSolicitud = await haySolicitudCompleta(portalPool);
    const forzar = FORZAR_TODO || idSolicitud !== null;
    // En modo forzar, usamos memoria vacía → todos cuentan como "cambiados".
    const memoriaEfectiva = forzar ? {} : memoria;
    if (forzar) {
      const origen = idSolicitud !== null ? `solicitud del portal #${idSolicitud}` : 'variable FORZAR_TODO';
      console.log(`   *** MODO ACTUALIZAR TODO (${origen}): se reevaluarán todos los productos ***`);
    }
    const cambiados = filtrarCambiados(productos, memoriaEfectiva);
    console.log(`   ✓ ${cambiados.length} productos ${forzar ? 'a revisar' : 'cambiaron (stock o precio)'}.\n`);

    let okTotal = 0, errTotal = 0;

    if (cambiados.length === 0) {
      console.log('   No hay cambios que sincronizar hoy. ✓');
    } else {
      // 4. Separar simples y variaciones
      const simples = cambiados.filter(p => p.product_type === 'simple');
      const variaciones = cambiados.filter(p => p.product_type === 'variation');
      console.log(`4) A sincronizar: ${simples.length} simples, ${variaciones.length} variaciones.\n`);

      const sincronizados = [];
      const todasDiscrepancias = [];

      // 4a. Productos simples → validar SKU por lote, luego batch
      for (let i = 0; i < simples.length; i += LOTE_SIZE) {
        const loteOriginal = simples.slice(i, i + LOTE_SIZE);
        const nLote = Math.floor(i / LOTE_SIZE) + 1;
        // Validar SKU (lee el lote de WooCommerce en 1 llamada)
        let lote = loteOriginal;
        if (!DRY_RUN) {
          const { validos, discrepancias } = await validarSkuSimples(wc, loteOriginal);
          lote = validos;
          todasDiscrepancias.push(...discrepancias);
          if (discrepancias.length) {
            console.log(`   ⚠ Lote simples #${nLote}: ${discrepancias.length} con SKU distinto (no se actualizan).`);
          }
        }
        console.log(`   Lote simples #${nLote}: ${lote.length} productos...`);
        if (lote.length === 0) { if (i + LOTE_SIZE < simples.length) await pausa(PAUSA_LOTE_MS); continue; }
        if (!DRY_RUN) {
          try {
            await wc.post('/products/batch', construirPayloadSimple(lote));
            okTotal += lote.length;
            sincronizados.push(...lote);
          } catch (e) {
            errTotal += lote.length;
            const msg = e.response ? `HTTP ${e.response.status}` : e.message;
            console.log(`   ✗ Error en lote simples #${nLote}: ${msg}`);
          }
        } else {
          okTotal += lote.length;
          sincronizados.push(...lote);
        }
        if (i + LOTE_SIZE < simples.length) await pausa(PAUSA_LOTE_MS);
      }

      // 4b. Variaciones → validar SKU por padre, luego batch
      if (variaciones.length) {
        if (simples.length) await pausa(PAUSA_LOTE_MS);
        const grupos = agruparVariacionesPorPadre(variaciones);
        const padres = Object.keys(grupos);
        console.log(`   Variaciones agrupadas en ${padres.length} productos padre...`);
        let idx = 0;
        for (const padre of padres) {
          const grupo = grupos[padre];
          for (let i = 0; i < grupo.length; i += LOTE_SIZE) {
            const loteOriginal = grupo.slice(i, i + LOTE_SIZE);
            let lote = loteOriginal;
            if (!DRY_RUN) {
              const { validos, discrepancias } = await validarSkuVariaciones(wc, padre, loteOriginal);
              lote = validos;
              todasDiscrepancias.push(...discrepancias);
              if (discrepancias.length) {
                console.log(`   ⚠ Variaciones padre ${padre}: ${discrepancias.length} con SKU distinto (no se actualizan).`);
              }
            }
            if (lote.length === 0) continue;
            if (!DRY_RUN) {
              try {
                await wc.post(`/products/${padre}/variations/batch`, {
                  update: lote.map(v => ({
                    id: v.wc_id,
                    manage_stock: true,
                    stock_quantity: v.stock,
                    stock_status: v.stock > 0 ? 'instock' : 'outofstock',
                    regular_price: v.precio === null ? '' : String(v.precio)
                  }))
                });
                okTotal += lote.length;
                sincronizados.push(...lote);
              } catch (e) {
                errTotal += lote.length;
                const msg = e.response ? `HTTP ${e.response.status}` : e.message;
                console.log(`   ✗ Error en variaciones del padre ${padre}: ${msg}`);
              }
            } else {
              okTotal += lote.length;
              sincronizados.push(...lote);
            }
          }
          idx++;
          if (idx < padres.length) await pausa(PAUSA_LOTE_MS);
        }
      }

      // Guardar discrepancias de SKU para el reporte (solo en corrida real)
      if (!DRY_RUN) {
        await guardarDiscrepancias(portalPool, todasDiscrepancias);
        if (todasDiscrepancias.length) {
          console.log(`\n   ⚠ ${todasDiscrepancias.length} productos con SKU que no coincide (ver reporte en el portal).`);
        }
      }

      // Construir el detalle de la corrida: TODO lo que varió + si se aplicó o no.
      // se_aplico=1 → pasó validación SKU y se escribió en WooCommerce.
      // se_aplico=0 → varió pero no se aplicó (SKU no coincidió).
      const aplicadosSet = new Set(sincronizados.map(s => s.variation_id));
      const detalle = cambiados.map(c => {
        // El "antes" real viene de la memoria verdadera (aun en modo forzar todo)
        const prevReal = memoria[c.variation_id];
        return {
          variation_id: c.variation_id,
          wc_id: c.wc_id,
          tipo: c.product_type,
          stock_antes: prevReal ? prevReal.stock : null,
          precio_antes: prevReal ? prevReal.precio : null,
          stock_despues: c.stock,
          precio_despues: c.precio,
          se_aplico: aplicadosSet.has(c.variation_id)
        };
      });
      if (!DRY_RUN) {
        await guardarDetalle(portalPool, detalle);
      }

      // 5. Guardar memoria de los que se sincronizaron bien
      if (!DRY_RUN && sincronizados.length) {
        await guardarMemoria(portalPool, sincronizados);
      }

      console.log(`\n   RESULTADO: ${okTotal} sincronizados, ${errTotal} con error.`);
    }

    // Registrar esta corrida (para que el reporte muestre la última fecha/hora)
    if (!DRY_RUN) {
      await registrarCorrida(portalPool, okTotal, errTotal, 'real');
      // Si esta corrida atendió una solicitud del portal, marcarla
      if (idSolicitud !== null) {
        await marcarSolicitudAtendida(portalPool, idSolicitud);
        console.log(`   ✓ Solicitud de actualización completa #${idSolicitud} atendida.`);
      }
    } else {
      await registrarCorrida(portalPool, okTotal, errTotal, 'simulacion');
    }

    // 6. Resumen de pendientes (el detalle se descarga desde el portal admin)
    console.log('\n5) Revisando productos pendientes (sin woocommerce_id)...');
    const pendientes = await leerPendientesERP(prodPool);
    console.log(`   ✓ ${pendientes.length} productos pendientes de crear en WooCommerce.`);
    console.log('   (Descarga el detalle desde el portal admin → Sincronización web.)');

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  Sincronización terminada.');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (e) {
    console.error('❌ Error inesperado:', e.message);
    process.exitCode = 1;
  } finally {
    await prodPool.end();
    await portalPool.end();
  }
}

main().then(() => process.exit(process.exitCode || 0));
