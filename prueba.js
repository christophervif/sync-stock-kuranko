/**
 * PRUEBA DE SINCRONIZACIÓN DE STOCK — Kuranko
 * ============================================
 * Lee 20 productos del ERP (solo lectura) y actualiza su stock en WooCommerce.
 *
 * SEGURIDAD:
 *  - El ERP se lee con usuario READ-ONLY (solo SELECT, no puede modificar nada).
 *  - Solo procesa 20 productos (LIMIT 20), para validar sin riesgo.
 *  - Identifica cada producto ÚNICAMENTE por su woocommerce_id.
 *  - Pausas cortas entre llamadas para no saturar el hosting.
 *  - Si una fila no tiene woocommerce_id, se ignora (nunca se crea nada).
 *  - NO crea productos. NO borra nada. Solo actualiza el número de stock.
 *
 * Variables de entorno necesarias (se configuran en Railway):
 *  - PROD_URL          : conexión MySQL al ERP (usuario dashboard_readonly)
 *  - WC_URL            : https://kuranko.pe
 *  - WC_CONSUMER_KEY   : ck_...
 *  - WC_CONSUMER_SECRET: cs_...
 */

const mysql = require('mysql2/promise');
const axios = require('axios');

// ─── Configuración ──────────────────────────────────────────────────────────
const PROD_URL = process.env.PROD_URL;
const WC_URL = (process.env.WC_URL || '').replace(/\/+$/, ''); // sin barra final
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;
const LIMITE_PRUEBA = 20;          // solo 20 productos en la prueba
const PAUSA_MS = 1500;             // pausa entre llamadas (1.5s) para ir suave

function validarConfig() {
  const faltan = [];
  if (!PROD_URL) faltan.push('PROD_URL');
  if (!WC_URL) faltan.push('WC_URL');
  if (!WC_KEY) faltan.push('WC_CONSUMER_KEY');
  if (!WC_SECRET) faltan.push('WC_CONSUMER_SECRET');
  if (faltan.length) {
    console.error('❌ Faltan variables de entorno:', faltan.join(', '));
    process.exit(1);
  }
}

const pausa = (ms) => new Promise(r => setTimeout(r, ms));

// Cliente WooCommerce (autenticación por API key sobre HTTPS)
function wcClient() {
  return axios.create({
    baseURL: `${WC_URL}/wp-json/wc/v3`,
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 20000,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ─── Leer 20 productos del ERP (SOLO LECTURA) ───────────────────────────────
async function leerProductosERP() {
  const pool = mysql.createPool(PROD_URL + '?connectionLimit=3');
  try {
    // SELECT puro: stock consolidado por variación/simple, solo con woocommerce_id.
    // Excluye 'variable' (el padre contenedor, que no tiene stock propio).
    const [rows] = await pool.query(
      `SELECT pv.id AS variation_id,
              pv.woocommerce_id AS wc_id,
              p.woocommerce_id AS wc_padre,
              pv.product_type,
              pv.sku,
              COALESCE(SUM(ls.quantity), 0) AS stock
       FROM product_variations pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
       WHERE pv.woocommerce_id IS NOT NULL
         AND pv.product_type IN ('variation','simple')
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.woocommerce_id, p.woocommerce_id, pv.product_type, pv.sku
       ORDER BY pv.id
       LIMIT ${LIMITE_PRUEBA}`
    );
    return rows;
  } finally {
    await pool.end();
  }
}

// ─── Actualizar UN producto en WooCommerce ──────────────────────────────────
// Se identifica SOLO por woocommerce_id. Devuelve {ok, detalle}.
async function actualizarStock(wc, prod) {
  const stock = Number(prod.stock) || 0;
  try {
    if (prod.product_type === 'simple') {
      // Producto simple: /products/{wc_id}
      await wc.put(`/products/${prod.wc_id}`, {
        manage_stock: true,
        stock_quantity: stock,
        stock_status: stock > 0 ? 'instock' : 'outofstock'
      });
    } else {
      // Variación: /products/{wc_padre}/variations/{wc_id}
      await wc.put(`/products/${prod.wc_padre}/variations/${prod.wc_id}`, {
        manage_stock: true,
        stock_quantity: stock,
        stock_status: stock > 0 ? 'instock' : 'outofstock'
      });
    }
    return { ok: true, detalle: `stock=${stock}` };
  } catch (e) {
    const msg = e.response
      ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 200)}`
      : e.message;
    return { ok: false, detalle: msg };
  }
}

// ─── Programa principal ─────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  PRUEBA DE SINCRONIZACIÓN DE STOCK — Kuranko');
  console.log('  (solo 20 productos, modo seguro)');
  console.log('═══════════════════════════════════════════════════\n');

  validarConfig();

  console.log('1) Leyendo productos del ERP (solo lectura)...');
  let productos;
  try {
    productos = await leerProductosERP();
  } catch (e) {
    console.error('❌ Error al leer el ERP:', e.message);
    process.exit(1);
  }
  console.log(`   ✓ ${productos.length} productos leídos del ERP.\n`);

  if (!productos.length) {
    console.log('No hay productos con woocommerce_id para sincronizar.');
    return;
  }

  console.log('2) Actualizando stock en WooCommerce (de a uno, con pausa)...\n');
  const wc = wcClient();
  let exito = 0, fallo = 0;
  const errores = [];

  for (let i = 0; i < productos.length; i++) {
    const p = productos[i];
    const tipo = p.product_type === 'simple' ? 'simple   ' : 'variación';
    const r = await actualizarStock(wc, p);
    if (r.ok) {
      exito++;
      console.log(`   ✓ [${i + 1}/${productos.length}] ${tipo} wc_id=${p.wc_id} (${p.sku}) → ${r.detalle}`);
    } else {
      fallo++;
      errores.push({ sku: p.sku, wc_id: p.wc_id, error: r.detalle });
      console.log(`   ✗ [${i + 1}/${productos.length}] ${tipo} wc_id=${p.wc_id} (${p.sku}) → ${r.detalle}`);
    }
    if (i < productos.length - 1) await pausa(PAUSA_MS);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  RESULTADO: ${exito} actualizados, ${fallo} con error`);
  console.log('═══════════════════════════════════════════════════');
  if (errores.length) {
    console.log('\nDetalle de errores:');
    errores.forEach(e => console.log(`  - ${e.sku} (wc_id=${e.wc_id}): ${e.error}`));
    console.log('\nSi ves errores 401 → revisa las claves API.');
    console.log('Si ves errores 404 → ese woocommerce_id no existe en la tienda.');
  } else {
    console.log('\n✅ Todos los productos se actualizaron sin errores.');
    console.log('   Revisa en kuranko.pe que el stock de estos productos sea correcto.');
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('Error inesperado:', e);
  process.exit(1);
});
