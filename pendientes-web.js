// ═══════════════════════════════════════════════════════════════════════════
//  RECOLECCIÓN "productos sin ID" — busca en WooCommerce el ID y las imágenes
//  de los productos del ERP que NO tienen woocommerce_id (pendientes).
//  · Método liviano: trae el catálogo de la web EN BLOQUE (paginado) y cruza por
//    SKU localmente, en vez de una consulta por producto.
//  · Variaciones: resuelve el padre por su SKU y lee sus variaciones.
//  · Se ejecuta como MÁXIMO cada REFRESH_H horas (no en cada reinicio del puente).
//  · Solo LEE de la web (GET). Guarda el resultado en la base del portal para que
//    el botón "Exportar productos sin ID" lo baje.
// ═══════════════════════════════════════════════════════════════════════════
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

async function prepararTabla(portalPool) {
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_pendientes_web (
      sku VARCHAR(255) PRIMARY KEY,
      tipo VARCHAR(20),
      woocommerce_id BIGINT,
      imagenes MEDIUMTEXT,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_pendientes_web_ts (
      id TINYINT PRIMARY KEY,
      corrio_en DATETIME
    )`);
}

async function estaFresco(portalPool, horas) {
  try {
    const [[r]] = await portalPool.query(`SELECT corrio_en FROM sync_pendientes_web_ts WHERE id = 1`);
    if (r && r.corrio_en) return (Date.now() - new Date(r.corrio_en).getTime()) / 3600000 < horas;
  } catch (e) {}
  return false;
}

// Productos del ERP sin woocommerce_id (simples, variables y variaciones)
async function leerPendientes(prodPool) {
  const [rows] = await prodPool.query(`
    SELECT pv.id AS vid, TRIM(pv.sku) AS sku, pv.product_type AS tipo,
           (SELECT TRIM(pp.sku) FROM product_variations pp
             WHERE pp.product_id = pv.product_id AND pp.product_type = 'variable'
               AND pp.deleted_at IS NULL LIMIT 1) AS parent_sku
      FROM product_variations pv
     WHERE pv.woocommerce_id IS NULL
       AND pv.product_type IN ('simple','variable','variation')
       AND pv.deleted_at IS NULL
       AND TRIM(pv.sku) <> ''`);
  return rows;
}

// Catálogo de WooCommerce EN BLOQUE → mapa sku(minúsc.) -> {id, type, images[]}
async function mapaProductosWC(wc, PAUSA) {
  const map = new Map();
  let page = 1;
  while (true) {
    const { data } = await wc.get('/products', { params: { per_page: 100, page, status: 'any', _fields: 'id,sku,type,images' } });
    const arr = data || [];
    arr.forEach(p => {
      const sk = (p.sku || '').trim().toLowerCase();
      if (sk) map.set(sk, { id: p.id, type: p.type, images: (p.images || []).map(i => i.src).filter(Boolean) });
    });
    if (arr.length < 100) break;
    page++; if (page > 300) break;
    await pausa(PAUSA);
  }
  return map;
}

async function recolectarPendientesWeb({ prodPool, portalPool, wc, PAUSA_ITEM = 700, REFRESH_H = 6, FORCE = false }) {
  await prepararTabla(portalPool);
  if (!FORCE && await estaFresco(portalPool, REFRESH_H)) {
    console.log(`\n   (Recolección "sin ID" fresca (< ${REFRESH_H}h) — se omite esta corrida.)`);
    return { omitido: true };
  }
  console.log('\n──────────── RECOLECCIÓN "productos sin ID" (ID + imágenes de la web) ────────────');
  const pend = await leerPendientes(prodPool);
  console.log(`   ${pend.length} productos sin woocommerce_id en el ERP.`);
  if (!pend.length) {
    await portalPool.query('DELETE FROM sync_pendientes_web');
    await portalPool.query(`INSERT INTO sync_pendientes_web_ts (id, corrio_en) VALUES (1, NOW()) ON DUPLICATE KEY UPDATE corrio_en = NOW()`);
    return { total: 0, conId: 0 };
  }
  const mapa = await mapaProductosWC(wc, PAUSA_ITEM);
  console.log(`   ${mapa.size} productos leídos del catálogo web.`);

  const resultados = []; // {sku, tipo, wc_id, imagenes}
  const variacionesPend = [];
  for (const p of pend) {
    if (p.tipo === 'variation') { variacionesPend.push(p); continue; }
    const hit = mapa.get((p.sku || '').toLowerCase());
    resultados.push({ sku: p.sku, tipo: p.tipo, wc_id: hit ? hit.id : null, imagenes: hit ? hit.images.join(', ') : '' });
  }
  // Variaciones: agrupar por SKU del padre, resolver el padre en la web y leer sus variaciones
  const porPadre = {};
  variacionesPend.forEach(p => { const ps = (p.parent_sku || '').toLowerCase(); if (ps) (porPadre[ps] = porPadre[ps] || []).push(p); });
  for (const ps of Object.keys(porPadre)) {
    const hijos = porPadre[ps];
    const padre = mapa.get(ps);
    if (!padre) { hijos.forEach(h => resultados.push({ sku: h.sku, tipo: 'variation', wc_id: null, imagenes: '' })); continue; }
    const vmap = new Map();
    try {
      let page = 1;
      while (true) {
        const { data } = await wc.get(`/products/${padre.id}/variations`, { params: { per_page: 100, page, _fields: 'id,sku,image' } });
        const arr = data || [];
        arr.forEach(v => { const sk = (v.sku || '').trim().toLowerCase(); if (sk) vmap.set(sk, { id: v.id, img: (v.image && v.image.src) ? v.image.src : '' }); });
        if (arr.length < 100) break;
        page++; if (page > 50) break;
        await pausa(PAUSA_ITEM);
      }
    } catch (e) { /* padre sin variaciones legibles */ }
    hijos.forEach(h => { const hit = vmap.get((h.sku || '').toLowerCase()); resultados.push({ sku: h.sku, tipo: 'variation', wc_id: hit ? hit.id : null, imagenes: hit ? hit.img : '' }); });
    await pausa(PAUSA_ITEM);
  }

  // Guardar (reemplaza lo anterior)
  await portalPool.query('DELETE FROM sync_pendientes_web');
  const CH = 500;
  for (let i = 0; i < resultados.length; i += CH) {
    const t = resultados.slice(i, i + CH);
    await portalPool.query(
      `INSERT INTO sync_pendientes_web (sku, tipo, woocommerce_id, imagenes) VALUES ${t.map(() => '(?,?,?,?)').join(',')}
       ON DUPLICATE KEY UPDATE tipo=VALUES(tipo), woocommerce_id=VALUES(woocommerce_id), imagenes=VALUES(imagenes)`,
      t.flatMap(r => [r.sku, r.tipo, r.wc_id, r.imagenes]));
  }
  await portalPool.query(`INSERT INTO sync_pendientes_web_ts (id, corrio_en) VALUES (1, NOW()) ON DUPLICATE KEY UPDATE corrio_en = NOW()`);
  const conId = resultados.filter(r => r.wc_id).length;
  console.log(`   ${conId}/${resultados.length} encontrados en la web (con ID). Guardado para el botón "Exportar productos sin ID".`);
  return { total: resultados.length, conId };
}

module.exports = { recolectarPendientesWeb };
