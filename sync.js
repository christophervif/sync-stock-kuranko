// ═══════════════════════════════════════════════════════════════════════════
//  FASE "IMÁGENES" — ERP → WooCommerce (aditiva, solo RELLENA lo que falta)
//  Sube la galería de imágenes del ERP SOLO a los productos/variaciones que en
//  la web NO tienen NINGUNA imagen. Nunca pisa una galería existente.
//    · Simples y padres variables → se rellena la galería a nivel de producto.
//    · Variaciones (hijos)         → se rellena la imagen de la variación.
//
//  CUIDADOS (hosting compartido + links del ERP que a veces no cargan):
//    · El link se valida ANTES de mandarlo a WooCommerce (HEAD/GET liviano desde
//      el puente, que tiene mejor red). Los links muertos NO se envían a la web,
//      así WooCommerce no se cuelga intentando descargar algo que no existe.
//    · Se procesa de a UNO, con pausas y un TOPE de escrituras por corrida (MAX).
//    · Los que fallan se guardan como alerta en "Alertas de vinculación" y no se
//      reintentan hasta pasados REINTENTO_FAIL_DIAS días (para no saturar).
//    · Memoria en sync_imagenes_estado: lo que ya quedó OK no se vuelve a tocar.
//
//  Reutiliza el catálogo web que ya leyó pendientes-web.js (webAll), así que NO
//  vuelve a leer la tienda. Corre en la misma cadencia que esa recolección.
// ═══════════════════════════════════════════════════════════════════════════
const axios = require('axios');
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

async function prepararTabla(portalPool) {
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_imagenes_estado (
      clave VARCHAR(40) PRIMARY KEY,
      woocommerce_id BIGINT,
      sku VARCHAR(255),
      nivel VARCHAR(20),
      estado VARCHAR(10),
      detalle VARCHAR(255),
      intento_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

// ¿El link responde? HEAD y, si no lo permiten, GET de 1 byte. Desde el puente.
async function linkVivo(url, timeoutMs) {
  const base = { timeout: timeoutMs, maxRedirects: 3, validateStatus: s => s >= 200 && s < 400 };
  try { await axios.head(url, base); return true; }
  catch (e) {
    try {
      await axios.get(url, { ...base, responseType: 'arraybuffer', headers: { Range: 'bytes=0-0' } });
      return true;
    } catch (e2) { return false; }
  }
}

// Deja solo los links que responden. Devuelve { vivos, muertos }.
async function filtrarVivos(urls, timeoutMs, pausaMs) {
  const vivos = [], muertos = [];
  for (const u of urls) {
    if (await linkVivo(u, timeoutMs)) vivos.push(u); else muertos.push(u);
    if (pausaMs) await pausa(pausaMs);
  }
  return { vivos, muertos };
}

// Imágenes del ERP para una lista de SKUs. Devuelve mapa sku(min) → {tipo, own[], prod[], galeria[]}
//   own     = imágenes propias de la variación/simple (product_variation_id = su id)
//   prod    = imágenes a nivel de producto/padre (product_variation_id NULL)
//   galeria = TODAS las imágenes del producto (nivel producto + las de todas sus
//             variantes). Sirve de respaldo para el padre variable cuando en el ERP
//             las fotos están colgadas de las variantes y no a nivel de producto.
async function imagenesErpDeSkus(prodPool, skus) {
  const map = new Map();
  if (!skus.length) return map;
  const ph = skus.map(() => '?').join(',');
  const [rows] = await prodPool.query(
    `SELECT pv.id AS vid, pv.product_id, pv.product_type AS tipo, LOWER(TRIM(pv.sku)) AS sku
       FROM product_variations pv
      WHERE pv.deleted_at IS NULL AND LOWER(TRIM(pv.sku)) IN (${ph})`, skus);
  if (!rows.length) return map;
  const pids = [...new Set(rows.map(r => r.product_id))];
  // Traemos las imágenes por product_id EFECTIVO: el de la propia fila, o —si la
  // imagen está colgada de una variación— el del padre de esa variación (vía JOIN).
  // Así capturamos las fotos aunque el ERP no guarde product_id en la fila de imagen.
  const phP = pids.map(() => '?').join(',');
  const [imgs] = await prodPool.query(
    `SELECT pi.product_variation_id AS vid,
            COALESCE(pi.product_id, pvv.product_id) AS pid,
            (pi.product_variation_id IS NULL) AS nivel_prod,
            pi.path
       FROM product_images pi
       LEFT JOIN product_variations pvv ON pvv.id = pi.product_variation_id
      WHERE pi.deleted_at IS NULL
        AND COALESCE(pi.product_id, pvv.product_id) IN (${phP})
      ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC`, pids);
  const byVar = {}, byProd = {}, galeria = {};
  imgs.forEach(im => {
    if (!im.path || im.pid == null) return;
    (galeria[im.pid] = galeria[im.pid] || []).push(im.path);
    if (im.product_variation_id != null) (byVar[im.product_variation_id] = byVar[im.product_variation_id] || []).push(im.path);
    else if (im.nivel_prod) (byProd[im.pid] = byProd[im.pid] || []).push(im.path);
  });
  const dedup = (a) => [...new Set((a || []).filter(Boolean))];
  rows.forEach(r => map.set(r.sku, {
    tipo: r.tipo,
    own: dedup(byVar[r.vid]),
    prod: dedup(byProd[r.product_id]),
    galeria: dedup(galeria[r.product_id])
  }));
  return map;
}

// Inserta alertas de imagen (APÉNDICE, sin borrar) en la tabla que lee el portal
// para la hoja "Alertas de vinculación". Usa ids negativos para no chocar con las
// alertas de la fase de stock/precio.
async function guardarAlertasImg(portalPool, alertas) {
  if (!alertas.length) return;
  let neg = -3000000;
  const valores = alertas.map(a => [neg--, a.wc || 0, a.sku || '', (a.detalle || '').slice(0, 255), a.motivo || 'Error al subir imagen']);
  await portalPool.query(
    `INSERT INTO sync_sku_alertas (variation_id, woocommerce_id, sku_erp, sku_woo, motivo)
     VALUES ${valores.map(() => '(?,?,?,?,?)').join(',')}
     ON DUPLICATE KEY UPDATE motivo = VALUES(motivo)`,
    valores.flat());
}

// Guarda/actualiza la memoria de intentos.
async function guardarMemoria(portalPool, registros) {
  if (!registros.length) return;
  const valores = registros.map(r => [r.clave, r.wc || 0, r.sku || '', r.nivel || '', r.estado, (r.detalle || '').slice(0, 255)]);
  await portalPool.query(
    `INSERT INTO sync_imagenes_estado (clave, woocommerce_id, sku, nivel, estado, detalle, intento_en)
     VALUES ${valores.map(() => '(?,?,?,?,?,?,NOW())').join(',')}
     ON DUPLICATE KEY UPDATE woocommerce_id=VALUES(woocommerce_id), sku=VALUES(sku),
       nivel=VALUES(nivel), estado=VALUES(estado), detalle=VALUES(detalle), intento_en=NOW()`,
    valores.flat());
}

const diasDesde = (fecha) => fecha ? (Date.now() - new Date(fecha).getTime()) / 86400000 : Infinity;

async function sincronizarImagenes({
  prodPool, portalPool, wc, DRY_RUN = false, webAll,
  MAX = parseInt(process.env.IMG_MAX_POR_CORRIDA || '25', 10),
  MAX_PADRES = parseInt(process.env.IMG_MAX_PADRES || '15', 10),
  PAUSA = parseInt(process.env.IMG_PAUSA_MS || '900', 10),
  PAUSA_LINK = parseInt(process.env.IMG_PAUSA_LINK_MS || '300', 10),
  LINK_TIMEOUT = parseInt(process.env.IMG_LINK_TIMEOUT_MS || '8000', 10),
  REINTENTO_FAIL_DIAS = parseInt(process.env.IMG_REINTENTO_FAIL_DIAS || '7', 10),
  REINSPECT_DIAS = parseInt(process.env.IMG_REINSPECT_DIAS || '7', 10)
} = {}) {
  console.log('\n──────────── FASE IMÁGENES (rellenar solo lo que falta en la web) ────────────');
  if (DRY_RUN) { console.log('   (DRY_RUN: no se sube ninguna imagen.)'); return { subidas: 0, fallidas: 0 }; }
  if (!Array.isArray(webAll) || !webAll.length) { console.log('   Sin catálogo web disponible; se omite.'); return { subidas: 0, fallidas: 0 }; }

  await prepararTabla(portalPool);
  const [mrows] = await portalPool.query(`SELECT clave, estado, detalle, intento_en FROM sync_imagenes_estado`);
  const memoria = new Map(); mrows.forEach(r => memoria.set(r.clave, r));

  const alertas = [];    // → sync_sku_alertas
  const registros = [];  // → sync_imagenes_estado
  let intentos = 0;      // cuenta escrituras a WooCommerce (lo pesado)

  // ── 1) Nivel producto: simples y padres variables con galería vacía en la web ──
  const prodCand = webAll.filter(p =>
    (p.type === 'simple' || p.type === 'variable') &&
    (p.sku || '').trim() && (!p.images || p.images.length === 0));
  const skusProd = [...new Set(prodCand.map(p => (p.sku || '').trim().toLowerCase()))];
  const erpProd = await imagenesErpDeSkus(prodPool, skusProd);

  for (const cand of prodCand) {
    const esPadre = cand.type === 'variable';
    const clave = (esPadre ? 'p' : 's') + cand.id;
    const nivel = esPadre ? 'padre' : 'simple';
    const mem = memoria.get(clave);
    if (mem && mem.estado === 'ok') continue;                         // ya resuelto
    if (mem && mem.estado === 'fail' && diasDesde(mem.intento_en) < REINTENTO_FAIL_DIAS) {
      alertas.push({ wc: cand.id, sku: cand.sku, motivo: 'Error al subir imagen', detalle: mem.detalle }); // sigue visible, sin reintentar
      continue;
    }
    if (intentos >= MAX) break;

    const erp = erpProd.get((cand.sku || '').trim().toLowerCase());
    if (!erp) continue;                                              // no está en el ERP → sin imágenes que subir
    // Padre: galería de producto y, si no tiene, la unión de sus variantes.
    // Simple: su imagen propia, luego la de producto, luego lo que haya.
    let urls = esPadre
      ? (erp.prod.length ? erp.prod : erp.galeria)
      : (erp.own.length ? erp.own : (erp.prod.length ? erp.prod : erp.galeria));
    urls = [...new Set((urls || []).filter(Boolean))];
    if (!urls.length) continue;                                     // el ERP tampoco tiene imágenes

    intentos++;
    const { vivos, muertos } = await filtrarVivos(urls, LINK_TIMEOUT, PAUSA_LINK);
    if (!vivos.length) {
      const det = `Link(s) del ERP no accesibles (${muertos.length})`;
      alertas.push({ wc: cand.id, sku: cand.sku, motivo: 'Imagen del ERP no accesible', detalle: (urls[0] || det).slice(0, 255) });
      registros.push({ clave, wc: cand.id, sku: cand.sku, nivel, estado: 'fail', detalle: det });
      await pausa(PAUSA); continue;
    }
    try {
      const { data } = await wc.put(`/products/${cand.id}`, { images: vivos.map(u => ({ src: u })) });
      if (data && Array.isArray(data.images) && data.images.length > 0) {
        registros.push({ clave, wc: cand.id, sku: cand.sku, nivel, estado: 'ok', detalle: `${data.images.length} imagen(es)` });
        console.log(`   ✓ ${nivel} ${cand.sku} (wc ${cand.id}): ${data.images.length} imagen(es).`);
      } else {
        const det = 'WooCommerce no guardó las imágenes';
        alertas.push({ wc: cand.id, sku: cand.sku, motivo: 'Error al subir imagen', detalle: det });
        registros.push({ clave, wc: cand.id, sku: cand.sku, nivel, estado: 'fail', detalle: det });
      }
    } catch (e) {
      const det = e.response ? `HTTP ${e.response.status}` : (e.message || 'error');
      alertas.push({ wc: cand.id, sku: cand.sku, motivo: 'Error al subir imagen', detalle: det.slice(0, 255) });
      registros.push({ clave, wc: cand.id, sku: cand.sku, nivel, estado: 'fail', detalle: det.slice(0, 255) });
      console.log(`   ✗ ${nivel} ${cand.sku} (wc ${cand.id}): ${det}`);
    }
    await pausa(PAUSA);
  }

  // ── 2) Nivel variación: hijos sin imagen dentro de padres variables de la web ──
  let padresInsp = 0;
  const padresWeb = webAll.filter(p => p.type === 'variable' && p.id);
  for (const padre of padresWeb) {
    if (intentos >= MAX || padresInsp >= MAX_PADRES) break;
    const claveP = 'vp' + padre.id;
    const memP = memoria.get(claveP);
    if (memP && diasDesde(memP.intento_en) < REINSPECT_DIAS) continue; // inspeccionado hace poco

    // Leer variaciones de la web de este padre (id, sku, ¿tiene imagen?)
    const variacionesWeb = [];
    try {
      let page = 1;
      while (true) {
        const { data } = await wc.get(`/products/${padre.id}/variations`, { params: { per_page: 100, page, _fields: 'id,sku,image' } });
        const arr = data || [];
        arr.forEach(v => variacionesWeb.push({ id: v.id, sku: (v.sku || '').trim(), tieneImg: !!(v.image && v.image.src) }));
        if (arr.length < 100) break;
        page++; if (page > 50) break;
        await pausa(PAUSA);
      }
    } catch (e) { padresInsp++; continue; }
    padresInsp++;

    const vacias = variacionesWeb.filter(v => v.sku && !v.tieneImg);
    registros.push({ clave: claveP, wc: padre.id, sku: padre.sku, nivel: 'padre-insp', estado: 'ok', detalle: `${vacias.length} variación(es) sin imagen` });
    if (!vacias.length) { await pausa(PAUSA); continue; }

    const erpV = await imagenesErpDeSkus(prodPool, [...new Set(vacias.map(v => v.sku.toLowerCase()))]);
    for (const v of vacias) {
      if (intentos >= MAX) break;
      const clave = 'v' + v.id;
      const mem = memoria.get(clave);
      if (mem && mem.estado === 'ok') continue;
      if (mem && mem.estado === 'fail' && diasDesde(mem.intento_en) < REINTENTO_FAIL_DIAS) {
        alertas.push({ wc: v.id, sku: v.sku, motivo: 'Error al subir imagen', detalle: mem.detalle });
        continue;
      }
      const erp = erpV.get(v.sku.toLowerCase());
      const urls = erp ? [...new Set((erp.own.length ? erp.own : erp.prod).filter(Boolean))] : [];
      if (!urls.length) continue;

      intentos++;
      const { vivos } = await filtrarVivos(urls.slice(0, 1), LINK_TIMEOUT, PAUSA_LINK); // la variación toma 1 imagen
      if (!vivos.length) {
        alertas.push({ wc: v.id, sku: v.sku, motivo: 'Imagen del ERP no accesible', detalle: (urls[0] || '').slice(0, 255) });
        registros.push({ clave, wc: v.id, sku: v.sku, nivel: 'variacion', estado: 'fail', detalle: 'link no accesible' });
        await pausa(PAUSA); continue;
      }
      try {
        const { data } = await wc.put(`/products/${padre.id}/variations/${v.id}`, { image: { src: vivos[0] } });
        if (data && data.image && data.image.src) {
          registros.push({ clave, wc: v.id, sku: v.sku, nivel: 'variacion', estado: 'ok', detalle: '1 imagen' });
          console.log(`   ✓ variación ${v.sku} (wc ${v.id}): 1 imagen.`);
        } else {
          const det = 'WooCommerce no guardó la imagen';
          alertas.push({ wc: v.id, sku: v.sku, motivo: 'Error al subir imagen', detalle: det });
          registros.push({ clave, wc: v.id, sku: v.sku, nivel: 'variacion', estado: 'fail', detalle: det });
        }
      } catch (e) {
        const det = e.response ? `HTTP ${e.response.status}` : (e.message || 'error');
        alertas.push({ wc: v.id, sku: v.sku, motivo: 'Error al subir imagen', detalle: det.slice(0, 255) });
        registros.push({ clave, wc: v.id, sku: v.sku, nivel: 'variacion', estado: 'fail', detalle: det.slice(0, 255) });
        console.log(`   ✗ variación ${v.sku} (wc ${v.id}): ${det}`);
      }
      await pausa(PAUSA);
    }
  }

  await guardarMemoria(portalPool, registros);
  await guardarAlertasImg(portalPool, alertas);

  const subidas = registros.filter(r => r.estado === 'ok' && r.nivel !== 'padre-insp').length;
  const fallidas = alertas.length;
  console.log(`   RESULTADO imágenes: ${subidas} subidas, ${fallidas} con alerta (tope ${MAX} por corrida).`);
  if (intentos >= MAX) console.log('   (Se alcanzó el tope de la corrida; el resto continúa en la próxima.)');
  return { subidas, fallidas };
}

module.exports = { sincronizarImagenes };
