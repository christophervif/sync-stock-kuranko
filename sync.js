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
const { sincronizarCamposRicos } = require('./campos-sync');
// Activa/desactiva la fase de campos ricos (nombre, publicado, visibilidad, etc.)
const SYNC_CAMPOS = process.env.SYNC_CAMPOS !== 'false'; // por defecto activada

// ─── Configuración ──────────────────────────────────────────────────────────
const PROD_URL = process.env.PROD_URL;
const PORTAL_URL = process.env.PORTAL_URL;
const WC_URL = (process.env.WC_URL || '').replace(/\/+$/, '');
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;
const LOTE_SIZE = parseInt(process.env.LOTE_SIZE || '50', 10);
const PAUSA_LOTE_MS = parseInt(process.env.PAUSA_LOTE_MS || '16000', 10);
// Pausa corta entre cada escritura individual de campos ricos (producto padre,
// categorías, etiquetas). Suave, sin ráfagas. Ajustable si hace falta ir más lento.
const PAUSA_ITEM_MS = parseInt(process.env.PAUSA_ITEM_MS || '700', 10);
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

// Lee la respuesta de un /batch de WooCommerce y separa OK vs error POR ÍTEM.
// El batch responde con update[]; si un objeto trae .error, ese ítem NO se aplicó.
// Así un producto malo ya no arrastra a los demás del lote.
function separarBatch(data, lote) {
  const errById = {};
  const arr = (data && (data.update || data)) || [];
  (Array.isArray(arr) ? arr : []).forEach(u => {
    if (u && u.error) errById[u.id] = (u.error && u.error.message) || 'error';
  });
  const ok = [], fail = [];
  for (const p of lote) {
    if (errById[p.wc_id]) fail.push({ ...p, _err: errById[p.wc_id] });
    else ok.push(p);
  }
  return { ok, fail };
}

// ─── Memoria de cambios (en la base del portal) ─────────────────────────────
async function asegurarTablaMemoria(portalPool) {
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_estado (
      variation_id BIGINT PRIMARY KEY,
      woocommerce_id BIGINT,
      ultimo_stock INT,
      ultimo_precio DECIMAL(12,2),
      ultima_oferta DECIMAL(12,2),
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Por si la tabla ya existía sin la columna de oferta
  try {
    await portalPool.query(`ALTER TABLE sync_estado ADD COLUMN ultima_oferta DECIMAL(12,2)`);
  } catch (e) { /* la columna ya existe */ }
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
      motivo VARCHAR(80),
      detectado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Por si la tabla ya existía sin la columna de motivo
  try { await portalPool.query(`ALTER TABLE sync_sku_alertas ADD COLUMN motivo VARCHAR(80)`); } catch (e) {}
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
      oferta_antes DECIMAL(12,2),
      oferta_despues DECIMAL(12,2),
      se_aplico TINYINT(1) DEFAULT 0,
      registrado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Por si la tabla ya existía sin las columnas de oferta
  try { await portalPool.query(`ALTER TABLE sync_detalle ADD COLUMN oferta_antes DECIMAL(12,2)`); } catch (e) {}
  try { await portalPool.query(`ALTER TABLE sync_detalle ADD COLUMN oferta_despues DECIMAL(12,2)`); } catch (e) {}
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
  // Cola de SKUs específicos a forzar en la próxima corrida (pegados desde el portal).
  // Se SUMAN a los que variaron; se procesan aunque no hayan cambiado; se vacían al usarse.
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_cola_sku (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sku VARCHAR(255) NOT NULL,
      actualizar_oferta TINYINT(1) DEFAULT 0,
      agregado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      atendido TINYINT(1) DEFAULT 0,
      atendido_en DATETIME NULL
    )
  `);
  // Por si la tabla ya existía sin la columna nueva, la agrega (ignora error si ya está)
  try {
    await portalPool.query(`ALTER TABLE sync_cola_sku ADD COLUMN actualizar_oferta TINYINT(1) DEFAULT 0`);
  } catch (e) { /* la columna ya existe */ }
}

// Lee los SKUs pendientes en la cola manual (los que aún no se han atendido).
// Devuelve también si alguna tanda pidió actualizar el precio oferta.
async function leerColaSku(portalPool) {
  try {
    const [rows] = await portalPool.query(
      `SELECT DISTINCT sku, actualizar_oferta FROM sync_cola_sku WHERE atendido = 0`);
    const skus = rows.map(r => (r.sku || '').trim()).filter(Boolean);
    // Set de SKUs (en minúscula) cuya tanda pidió actualizar oferta
    const conOferta = new Set(
      rows.filter(r => r.actualizar_oferta === 1)
          .map(r => (r.sku || '').trim().toLowerCase()).filter(Boolean));
    return { skus, conOferta };
  } catch (e) { return { skus: [], conOferta: new Set() }; }
}

// Marca toda la cola pendiente como atendida
async function marcarColaAtendida(portalPool) {
  await portalPool.query(
    `UPDATE sync_cola_sku SET atendido = 1, atendido_en = NOW() WHERE atendido = 0`);
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
    f.oferta_antes === undefined ? null : f.oferta_antes,
    f.oferta_despues === undefined ? null : f.oferta_despues,
    f.se_aplico ? 1 : 0
  ]);
  await portalPool.query(
    `INSERT INTO sync_detalle
       (variation_id, woocommerce_id, tipo, stock_antes, precio_antes, stock_despues, precio_despues, oferta_antes, oferta_despues, se_aplico)
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
    `SELECT variation_id, ultimo_stock, ultimo_precio, ultima_oferta FROM sync_estado`
  );
  const mapa = {};
  rows.forEach(r => {
    mapa[r.variation_id] = {
      stock: r.ultimo_stock,
      precio: r.ultimo_precio === null ? null : Number(r.ultimo_precio),
      oferta: r.ultima_oferta === null ? null : Number(r.ultima_oferta)
    };
  });
  return mapa;
}

// Guarda en memoria los que se sincronizaron con éxito (en lote)
async function guardarMemoria(portalPool, registros) {
  if (!registros.length) return;
  // Solo los registros que actualizaron oferta traen un valor; los demás mandan
  // undefined y COALESCE conserva la oferta que ya estaba guardada.
  const valores = registros.map(r => [
    r.variation_id, r.wc_id, r.stock, r.precio,
    r._actualizar_oferta ? (r.oferta === undefined ? null : r.oferta) : null,
    r._actualizar_oferta ? 1 : 0   // bandera: ¿esta fila trae oferta nueva?
  ]);
  await portalPool.query(
    `INSERT INTO sync_estado (variation_id, woocommerce_id, ultimo_stock, ultimo_precio, ultima_oferta)
     VALUES ${valores.map(() => '(?,?,?,?,?)').join(',')}
     ON DUPLICATE KEY UPDATE
       woocommerce_id = VALUES(woocommerce_id),
       ultimo_stock   = VALUES(ultimo_stock),
       ultimo_precio  = VALUES(ultimo_precio),
       actualizado_en = NOW()`,
    valores.flatMap(v => v.slice(0, 5))
  );
  // Actualizar la oferta SOLO de los que la actualizaron (para no borrar la de los demás)
  const conOferta = registros.filter(r => r._actualizar_oferta);
  for (const r of conOferta) {
    await portalPool.query(
      `UPDATE sync_estado SET ultima_oferta = ? WHERE variation_id = ?`,
      [r.oferta === undefined ? null : r.oferta, r.variation_id]);
  }
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
            pv.sale_price,
            COALESCE(SUM(ls.quantity), 0) AS stock
     FROM product_variations pv
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
     WHERE pv.woocommerce_id IS NOT NULL
       AND pv.product_type IN ('variation','simple')
       AND pv.deleted_at IS NULL
     GROUP BY pv.id, pv.woocommerce_id, p.woocommerce_id, pv.product_type, pv.sku, pv.regular_price, pv.sale_price
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
    update: lote.map(p => {
      const item = {
        id: p.wc_id,
        manage_stock: true,
        stock_quantity: p.stock,
        stock_status: p.stock > 0 ? 'instock' : 'outofstock',
        regular_price: p.precio === null ? '' : String(p.precio)
      };
      // Solo los SKUs manuales cuya tanda pidió oferta actualizan sale_price.
      // Si el ERP no tiene oferta, se manda vacío (WooCommerce muestra el precio regular).
      if (p._actualizar_oferta) {
        item.sale_price = (p.oferta === null || p.oferta === undefined) ? '' : String(p.oferta);
      }
      return item;
    })
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
        discrepancias.push({ ...p, sku_woo: skuWoo, motivo: 'SKU no coincide' });
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
        discrepancias.push({ ...p, sku_woo: skuWoo, motivo: 'SKU no coincide' });
      }
    }
  } catch (e) {
    console.log(`   ⚠ No se pudo validar SKU de variaciones del padre ${padre}: ${e.message}. Se actualizan sin validar.`);
    return { validos: lote, discrepancias: [] };
  }
  return { validos, discrepancias };
}

// Traduce un error de escritura de WooCommerce a un motivo legible
function motivoEscritura(msg) {
  const m = String(msg || '');
  if (/invalid.?id|no v[aá]lido|not\s*found|404|does not exist|no existe|resource/i.test(m)) return 'ID no existe en la web';
  return 'Error al escribir: ' + m.slice(0, 100);
}

// Guarda las NO-sincronizadas (con su motivo) en la base del portal (reemplaza las anteriores).
// Motivos: 'SKU no coincide' | 'ID no existe en la web' | 'Error al escribir: …' | 'No existe en el ERP'
async function guardarDiscrepancias(portalPool, discrepancias) {
  await portalPool.query('DELETE FROM sync_sku_alertas'); // cada corrida refresca la lista
  if (!discrepancias.length) return;
  // variation_id es PK: para las filas sin variación real (0) usamos ids negativos únicos
  let neg = -1;
  const valores = discrepancias.map(d => {
    const vid = (d.variation_id && d.variation_id > 0) ? d.variation_id : (neg--);
    return [vid, d.wc_id || 0, d.sku || '', d.sku_woo || '', d.motivo || 'SKU no coincide'];
  });
  await portalPool.query(
    `INSERT INTO sync_sku_alertas (variation_id, woocommerce_id, sku_erp, sku_woo, motivo) VALUES ?`,
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

    // 3b. Sumar los SKUs de la cola manual (pegados desde el portal).
    // Se fuerzan aunque no hayan cambiado; se deduplican por variation_id.
    const cola = await leerColaSku(portalPool);
    const colaSku = cola.skus;
    let skusNoEncontrados = [];
    if (colaSku.length) {
      console.log(`3b) Cola manual: ${colaSku.length} SKU(s) para forzar.`);
      const setSku = new Set(colaSku.map(s => s.toLowerCase()));
      const yaIncluidos = new Set(cambiados.map(c => c.variation_id));
      // Buscar esos SKUs en el catálogo del ERP
      const forzadosPorSku = productos.filter(p =>
        setSku.has((p.sku || '').trim().toLowerCase()) && !yaIncluidos.has(p.variation_id));
      // Detectar cuáles SKUs pegados no existen en el ERP (para Alertas)
      const skusEncontrados = new Set(productos.map(p => (p.sku || '').trim().toLowerCase()));
      skusNoEncontrados = colaSku.filter(s => !skusEncontrados.has(s.toLowerCase()));
      // Agregar los forzados. Marca oferta si su tanda lo pidió.
      forzadosPorSku.forEach(p => {
        const skuLow = (p.sku || '').trim().toLowerCase();
        cambiados.push({
          ...p,
          stock: Number(p.stock) || 0,
          precio: p.regular_price === null ? null : Number(p.regular_price),
          oferta: p.sale_price === null ? null : Number(p.sale_price),
          stock_antes: memoria[p.variation_id] ? memoria[p.variation_id].stock : null,
          precio_antes: memoria[p.variation_id] ? memoria[p.variation_id].precio : null,
          _forzado_manual: true,
          _actualizar_oferta: cola.conOferta.has(skuLow)
        });
      });
      // También marcar los que YA estaban en cambiados pero están en una tanda con oferta
      cambiados.forEach(c => {
        const skuLow = (c.sku || '').trim().toLowerCase();
        if (cola.conOferta.has(skuLow)) {
          c._actualizar_oferta = true;
          c.oferta = c.sale_price === null || c.sale_price === undefined ? null : Number(c.sale_price);
        }
      });
      const nOferta = cambiados.filter(c => c._actualizar_oferta).length;
      console.log(`   ✓ ${forzadosPorSku.length} agregados desde la cola (${skusNoEncontrados.length} SKU no existen en el ERP). ${nOferta} con precio oferta.\n`);
    }

    let okTotal = 0, errTotal = 0;

    if (cambiados.length === 0) {
      console.log('   No hay cambios que sincronizar hoy. ✓');
      // Aun sin cambios, registrar en Alertas los SKUs de la cola que no existen en el ERP
      if (!DRY_RUN && skusNoEncontrados.length) {
        const alertas = skusNoEncontrados.map(sku => ({
          variation_id: 0, wc_id: 0, sku: sku, sku_woo: '', motivo: 'No existe en el ERP'
        }));
        await guardarDiscrepancias(portalPool, alertas);
        console.log(`   ⚠ ${skusNoEncontrados.length} SKU(s) de la cola no existen en el ERP (ver Alertas).`);
      }
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
            const { data } = await wc.post('/products/batch', construirPayloadSimple(lote));
            const { ok, fail } = separarBatch(data, lote);
            okTotal += ok.length; sincronizados.push(...ok);
            if (fail.length) {
              errTotal += fail.length;
              fail.forEach(f => {
                console.log(`   ✗ simple ${f.sku} (wc ${f.wc_id}): ${f._err}`);
                todasDiscrepancias.push({ variation_id: f.variation_id, wc_id: f.wc_id, sku: f.sku, sku_woo: '', motivo: motivoEscritura(f._err) });
              });
            }
          } catch (e) {
            errTotal += lote.length;
            const msg = e.response ? `HTTP ${e.response.status}` : e.message;
            console.log(`   ✗ Error en lote simples #${nLote}: ${msg}`);
            lote.forEach(p => todasDiscrepancias.push({ variation_id: p.variation_id, wc_id: p.wc_id, sku: p.sku, sku_woo: '', motivo: motivoEscritura(msg) }));
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
                const { data } = await wc.post(`/products/${padre}/variations/batch`, {
                  update: lote.map(v => {
                    const item = {
                      id: v.wc_id,
                      manage_stock: true,
                      stock_quantity: v.stock,
                      stock_status: v.stock > 0 ? 'instock' : 'outofstock',
                      regular_price: v.precio === null ? '' : String(v.precio)
                    };
                    if (v._actualizar_oferta) {
                      item.sale_price = (v.oferta === null || v.oferta === undefined) ? '' : String(v.oferta);
                    }
                    return item;
                  })
                });
                const { ok, fail } = separarBatch(data, lote);
                okTotal += ok.length; sincronizados.push(...ok);
                if (fail.length) {
                  errTotal += fail.length;
                  fail.forEach(f => {
                    console.log(`   ✗ variación ${f.sku} (wc ${f.wc_id}): ${f._err}`);
                    todasDiscrepancias.push({ variation_id: f.variation_id, wc_id: f.wc_id, sku: f.sku, sku_woo: '', motivo: motivoEscritura(f._err) });
                  });
                }
              } catch (e) {
                errTotal += lote.length;
                const msg = e.response ? `HTTP ${e.response.status}` : e.message;
                console.log(`   ✗ Error en variaciones del padre ${padre}: ${msg}`);
                lote.forEach(p => todasDiscrepancias.push({ variation_id: p.variation_id, wc_id: p.wc_id, sku: p.sku, sku_woo: '', motivo: motivoEscritura(msg) }));
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
        // Sumar los SKUs de la cola que NO existen en el ERP (para que se vean en Alertas)
        skusNoEncontrados.forEach(sku => {
          todasDiscrepancias.push({
            variation_id: 0, wc_id: 0, sku: sku, sku_woo: '', motivo: 'No existe en el ERP'
          });
        });
        await guardarDiscrepancias(portalPool, todasDiscrepancias);
        if (todasDiscrepancias.length) {
          console.log(`\n   ⚠ ${todasDiscrepancias.length} productos con SKU que no coincide o no existe (ver reporte en el portal).`);
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
          // Oferta: solo se registra para los que la actualizaron. "Antes" desde memoria.
          oferta_antes: c._actualizar_oferta ? (prevReal ? prevReal.oferta : null) : null,
          oferta_despues: c._actualizar_oferta ? (c.oferta === undefined ? null : c.oferta) : null,
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

    // Marcar la cola de SKUs manuales como atendida (haya habido cambios o no)
    if (!DRY_RUN && colaSku.length) {
      await marcarColaAtendida(portalPool);
      console.log(`   ✓ Cola de ${colaSku.length} SKU(s) manual(es) atendida.`);
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

    // 5b. FASE CAMPOS RICOS (aditiva): nombre, publicado, destacado, visibilidad,
    //     descripción corta, reservas, peso y dimensiones. Misma condición: solo
    //     productos en la web y solo lo que cambió vs la última corrida.
    if (SYNC_CAMPOS) {
      try {
        await sincronizarCamposRicos({
          prodPool, portalPool, wc, DRY_RUN,
          LOTE: LOTE_SIZE, PAUSA: PAUSA_LOTE_MS, PAUSA_ITEM: PAUSA_ITEM_MS
        });
      } catch (e) {
        console.error('   ✗ Error en la fase de campos ricos:', e.message);
      }
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
