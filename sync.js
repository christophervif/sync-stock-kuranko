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
 *  - PAUSA_LOTE_MS     : pausa entre lotes en ms (default 8000 = 8s)
 *  - DRY_RUN           : 'true' = solo simula, no escribe en WooCommerce (default false)
 */

const mysql = require('mysql2/promise');
const axios = require('axios');
const fs = require('fs');

// ─── Configuración ──────────────────────────────────────────────────────────
const PROD_URL = process.env.PROD_URL;
const PORTAL_URL = process.env.PORTAL_URL;
const WC_URL = (process.env.WC_URL || '').replace(/\/+$/, '');
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;
const LOTE_SIZE = parseInt(process.env.LOTE_SIZE || '100', 10);
const PAUSA_LOTE_MS = parseInt(process.env.PAUSA_LOTE_MS || '8000', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';

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
      cambiados.push({ ...p, stock, precio });
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
    const cambiados = filtrarCambiados(productos, memoria);
    console.log(`   ✓ ${cambiados.length} productos cambiaron (stock o precio).\n`);

    if (cambiados.length === 0) {
      console.log('   No hay cambios que sincronizar hoy. ✓');
    } else {
      // 4. Separar simples y variaciones
      const simples = cambiados.filter(p => p.product_type === 'simple');
      const variaciones = cambiados.filter(p => p.product_type === 'variation');
      console.log(`4) A sincronizar: ${simples.length} simples, ${variaciones.length} variaciones.\n`);

      let okTotal = 0, errTotal = 0;
      const sincronizados = [];

      // 4a. Productos simples → batch en /products/batch
      for (let i = 0; i < simples.length; i += LOTE_SIZE) {
        const lote = simples.slice(i, i + LOTE_SIZE);
        const nLote = Math.floor(i / LOTE_SIZE) + 1;
        console.log(`   Lote simples #${nLote}: ${lote.length} productos...`);
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

      // 4b. Variaciones → batch por producto padre en /products/{padre}/variations/batch
      if (variaciones.length) {
        if (simples.length) await pausa(PAUSA_LOTE_MS);
        const grupos = agruparVariacionesPorPadre(variaciones);
        const padres = Object.keys(grupos);
        console.log(`   Variaciones agrupadas en ${padres.length} productos padre...`);
        let idx = 0;
        for (const padre of padres) {
          const grupo = grupos[padre];
          // batch de variaciones de un padre (subdividir si supera el lote)
          for (let i = 0; i < grupo.length; i += LOTE_SIZE) {
            const lote = grupo.slice(i, i + LOTE_SIZE);
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

      // 5. Guardar memoria de los que se sincronizaron bien
      if (!DRY_RUN && sincronizados.length) {
        await guardarMemoria(portalPool, sincronizados);
      }

      console.log(`\n   RESULTADO: ${okTotal} sincronizados, ${errTotal} con error.`);
    }

    // 6. CSV de pendientes (productos sin woocommerce_id)
    console.log('\n5) Generando CSV de productos pendientes (sin woocommerce_id)...');
    const pendientes = await leerPendientesERP(prodPool);
    if (pendientes.length) {
      const cabecera = 'variation_id,sku,tipo,nombre_producto,variacion,precio_regular,stock\n';
      const filas = pendientes.map(p =>
        [p.variation_id, p.sku, p.product_type,
         `"${(p.nombre_producto || '').replace(/"/g, '""')}"`,
         `"${(p.variacion || '').replace(/"/g, '""')}"`,
         p.regular_price || '', p.stock].join(',')
      ).join('\n');
      const ruta = '/tmp/pendientes.csv';
      fs.writeFileSync(ruta, cabecera + filas);
      console.log(`   ✓ ${pendientes.length} productos pendientes. CSV en: ${ruta}`);
      console.log('   (Estos NO tienen woocommerce_id. Créalos manualmente en WooCommerce');
      console.log('    y luego importa sus IDs al ERP con tu herramienta de importación.)');
    } else {
      console.log('   ✓ No hay productos pendientes: todos tienen woocommerce_id.');
    }

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
