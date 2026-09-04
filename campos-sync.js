// ═══════════════════════════════════════════════════════════════════════════
//  FASE "CAMPOS RICOS" — ERP -> WooCommerce (aditiva al puente de stock/precio)
//  Sincroniza, SOLO sobre productos que ya están en la web (woocommerce_id) y
//  con la misma memoria de "solo si cambió":
//   · Variación/simple: reservas (backorders), peso, largo, ancho, alto.
//   · Producto padre/simple: nombre, publicado(status), destacado, visibilidad,
//     descripción corta.  (Categorías y etiquetas = Fase 2.)
//  NO crea ni borra nada. Respeta DRY_RUN. Reglas idénticas al Excel del usuario
//  (ver campos.js, validado al 100%).
// ═══════════════════════════════════════════════════════════════════════════
const C = require('./campos');
const { crearResolvedorTaxonomia } = require('./campos-tax');

// HTML "Pronto en stock / A pedido" (de la pestaña Info: C2 simple, C4 variable)
const HTML_SIMPLE = "<div id=\"wcapf-active-filters-1\" class=\"woocommerce wcapf-ajax-term-filter widget cf widget_wcapf-active-filters\"><strong><a data-key=\"attra-disponibilidad\" data-value=\"352\" data-multiple-filter=\"\"><span class=\"name\"><font color=\"#E84E0E\">Disponible A PEDIDO.                                        </font></span></a></strong></div>\n<div id=\"wcapf-attribute-filter-6\" class=\"woocommerce wcapf-ajax-term-filter widget cf widget_wcapf-attribute-filter\">\n<div class=\"wcapf-layered-nav et-list-wcapf ps ps--theme_default\" data-ps-id=\"7946ef68-653f-c20b-c5f3-9a8737d12d7d\">\n\n<strong><span class=\"name\">El tiempo de espera es de 2 a 3 semanas. Consultar <a href=\"http://wa.me/51963358335\" target=\"_blank\" rel=\"noopener\"><u>AQUÍ</u></a> para confirmar y/o información más detallada.</span></strong>\n\n<strong><span class=\"name\">Usar código APEDIDO para obtener el descuento de 50% de adelanto y el 50% restante se realiza en la entrega.</span></strong>\n<strong><span class=\"name\">Para compras A pedido <u>SOLO</u> se aceptan <u>pagos con transferencia</u>.</span></strong>\n\n&nbsp;\n\n</div>\n</div>";
const HTML_VARIABLE = "<div id=\"wcapf-active-filters-1\" class=\"woocommerce wcapf-ajax-term-filter widget cf widget_wcapf-active-filters\"><strong><a data-key=\"attra-disponibilidad\" data-value=\"352\" data-multiple-filter=\"\"><span class=\"name\">-                            </span></a><a data-key=\"attra-disponibilidad\" data-value=\"352\" data-multiple-filter=\"\">                </a></strong></div>\n<div id=\"wcapf-attribute-filter-6\" class=\"woocommerce wcapf-ajax-term-filter widget cf widget_wcapf-attribute-filter\">\n<div class=\"wcapf-layered-nav et-list-wcapf ps ps--theme_default\" data-ps-id=\"7946ef68-653f-c20b-c5f3-9a8737d12d7d\">\n\n<strong><span class=\"name\">Si uno o más variantes de este producto no está en stock puedes solicitarlo <font color=\"#E84E0E\">A PEDIDO</font>. El tiempo de espera es de 2 a 3 semanas. Consultar <a href=\"http://wa.me/51963358335\" target=\"_blank\" rel=\"noopener\"><u>AQUÍ</u></a> para confirmar y/o información más detallada.</span></strong>\n\n<strong><span class=\"name\">Usar código APEDIDO para obtener el descuento de 50% de adelanto y el 50% restante se realiza en la entrega.</span></strong>\n<strong><span class=\"name\">Para compras <font color=\"#E84E0E\">A PEDIDO</font> <u>solo</u> se aceptan <u>pagos con transferencia</u>.</span></strong>\n\n&nbsp;\n\n</div>\n</div>";

// ─── Tablas de memoria de campos ricos (en la base del portal) ──────────────
async function prepararTablasCampos(portalPool) {
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_estado_var_campos (
      variation_id BIGINT PRIMARY KEY,
      backorders VARCHAR(10),
      weight  DECIMAL(10,3),
      length  DECIMAL(10,3),
      width   DECIMAL(10,3),
      height  DECIMAL(10,3),
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS sync_estado_padre (
      product_id BIGINT PRIMARY KEY,
      woocommerce_id BIGINT,
      name VARCHAR(255),
      publicado VARCHAR(10),
      featured TINYINT(1),
      visibility VARCHAR(10),
      short_description MEDIUMTEXT,
      categorias MEDIUMTEXT,
      etiquetas TEXT,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  // Por si la tabla ya existía sin las columnas nuevas
  try { await portalPool.query(`ALTER TABLE sync_estado_padre ADD COLUMN categorias MEDIUMTEXT`); } catch (e) {}
  try { await portalPool.query(`ALTER TABLE sync_estado_padre ADD COLUMN etiquetas TEXT`); } catch (e) {}
}

// Categorías del ERP por product_id -> "ruta1, ruta2" (jerarquía completa)
async function leerCategoriasErp(prodPool, prodIds) {
  const cats = {};
  if (!prodIds.length) return cats;
  const [allCats] = await prodPool.query(`SELECT id, name, parent_id FROM product_categories`);
  const byId = {}; allCats.forEach(c => { byId[c.id] = { name: c.name, parent: c.parent_id }; });
  const ruta = (id) => { const p = []; let cur = id, g = 0; while (cur != null && byId[cur] && g++ < 12) { p.unshift(byId[cur].name); cur = byId[cur].parent; } return p.join(' > '); };
  const [asig] = await prodPool.query(
    `SELECT product_id, product_category_id FROM product_product_category
      WHERE product_id IN (${prodIds.map(() => '?').join(',')})`, prodIds);
  const setById = {};
  asig.forEach(a => { const r = ruta(a.product_category_id); if (!r) return; (setById[a.product_id] = setById[a.product_id] || new Set()).add(r); });
  Object.keys(setById).forEach(k => { cats[k] = [...setById[k]].join(', '); });
  return cats;
}

// Etiquetas del ERP por product_id -> "tag1, tag2"
async function leerEtiquetasErp(prodPool, prodIds) {
  const tags = {};
  if (!prodIds.length) return tags;
  const [rows] = await prodPool.query(
    `SELECT ppt.product_id, t.name FROM product_product_tag ppt
       JOIN product_tags t ON t.id = ppt.product_tag_id
      WHERE ppt.product_id IN (${prodIds.map(() => '?').join(',')})`, prodIds);
  const setById = {};
  rows.forEach(r => { if (!r.name) return; (setById[r.product_id] = setById[r.product_id] || new Set()).add(String(r.name).trim()); });
  Object.keys(setById).forEach(k => { tags[k] = [...setById[k]].join(', '); });
  return tags;
}

// ─── Lectura del ERP (SOLO LECTURA): variaciones/simples en la web + datos ──
async function leerDatosRicos(prodPool) {
  const [rows] = await prodPool.query(
    `SELECT pv.id AS variation_id, pv.woocommerce_id AS wc_id,
            p.id AS product_id, p.woocommerce_id AS wc_padre,
            pv.product_type, pv.sku, pv.status,
            pv.weight, pv.length, pv.width, pv.height,
            pvs.backorder_mode AS backorder_mode,
            p.name AS prod_name, p.is_featured,
            COALESCE(SUM(ls.quantity), 0) AS stock
       FROM product_variations pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN product_variation_stocks pvs ON pvs.product_variation_id = pv.id
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
      WHERE pv.woocommerce_id IS NOT NULL
        AND pv.product_type IN ('variation','simple')
        AND pv.deleted_at IS NULL
      GROUP BY pv.id, pv.woocommerce_id, p.id, p.woocommerce_id, pv.product_type,
               pv.sku, pv.status, pv.weight, pv.length, pv.width, pv.height,
               pvs.backorder_mode, p.name, p.is_featured`);
  return rows;
}

// Normalizadores
const s = (v) => v == null ? '' : String(v);
const numStr = (v) => (v == null || v === '') ? '' : String(Number(v)); // 0.150 -> "0.15"

// Campos de la VARIACIÓN/simple (nivel variación)
function calcularVariacion(row) {
  return {
    backorders: C.backordersWoo(s(row.backorder_mode)),
    weight: numStr(row.weight),
    length: numStr(row.length),
    width:  numStr(row.width),
    height: numStr(row.height)
  };
}

// Agrega por producto padre y calcula los campos de nivel PADRE/simple.
// Devuelve Map product_id -> { tipo, wc_target, campos, sku_ref }
function calcularPadres(rows, catMap = {}, tagMap = {}) {
  const porProd = new Map();
  for (const r of rows) {
    if (!porProd.has(r.product_id)) porProd.set(r.product_id, []);
    porProd.get(r.product_id).push(r);
  }
  const out = new Map();
  for (const [pid, hijos] of porProd) {
    const esSimple = hijos.length === 1 && hijos[0].product_type === 'simple';
    // Stock agregado: el padre "tiene stock" si alguna hija tiene stock
    const stockAny = hijos.some(h => (Number(h.stock) || 0) > 0) ? 1 : 0;
    // Estado agregado: discontinued solo si TODAS descontinuadas; si alguna active -> active; si no, draft
    let statusPadre;
    if (hijos.every(h => h.status === 'discontinued')) statusPadre = 'discontinued';
    else if (hijos.some(h => h.status === 'active')) statusPadre = 'active';
    else statusPadre = 'draft';
    // Backorders agregado: notify si alguna hija es notify/yes
    const backPadre = hijos.some(h => C.backordersWoo(s(h.backorder_mode)) === 'notify') ? 'notify' : 'no';
    const nombre = s(hijos[0].prod_name);
    const tipo = esSimple ? 'simple' : 'variable';
    const featured = hijos[0].is_featured ? 1 : 0;
    // wc target del producto: simple usa el wc_id de su fila; variable usa wc_padre
    const wc_target = esSimple ? hijos[0].wc_id : hijos[0].wc_padre;
    const campos = {
      name: nombre,
      publicado: C.publicadoWoo(stockAny, statusPadre),               // 'publish'|'private'|'draft'
      featured: featured,                                             // 0|1
      visibility: C.visibilidadWoo(stockAny, statusPadre, backPadre, nombre),
      short_description: C.descripcionCortaWoo(tipo, stockAny, backPadre, HTML_SIMPLE, HTML_VARIABLE),
      categorias: C.categoriasWoo(catMap[pid] || '', nombre),   // ruta(s) + prefijo "Marketplace >" si nombre~MKP
      etiquetas: s(tagMap[pid] || '')                            // tal cual del sistema
    };
    out.set(pid, { tipo, wc_target, campos, sku_ref: s(hijos[0].sku) });
  }
  return out;
}

// ─── Memoria ────────────────────────────────────────────────────────────────
async function leerMemoriaVar(portalPool) {
  const [rows] = await portalPool.query(
    `SELECT variation_id, backorders, weight, length, width, height FROM sync_estado_var_campos`);
  const m = {};
  rows.forEach(r => { m[r.variation_id] = {
    backorders: s(r.backorders), weight: numStr(r.weight), length: numStr(r.length),
    width: numStr(r.width), height: numStr(r.height) }; });
  return m;
}
async function leerMemoriaPadre(portalPool) {
  const [rows] = await portalPool.query(
    `SELECT product_id, name, publicado, featured, visibility, short_description, categorias, etiquetas FROM sync_estado_padre`);
  const m = {};
  rows.forEach(r => { m[r.product_id] = {
    name: s(r.name), publicado: s(r.publicado), featured: r.featured ? 1 : 0,
    visibility: s(r.visibility), short_description: s(r.short_description),
    categorias: s(r.categorias), etiquetas: s(r.etiquetas) }; });
  return m;
}

const igualVar = (a, b) => a && b && a.backorders===b.backorders && a.weight===b.weight &&
  a.length===b.length && a.width===b.width && a.height===b.height;
const igualPadre = (a, b) => a && b && a.name===b.name && a.publicado===b.publicado &&
  a.featured===b.featured && a.visibility===b.visibility && a.short_description===b.short_description &&
  s(a.categorias)===s(b.categorias) && s(a.etiquetas)===s(b.etiquetas);

async function guardarMemoriaVar(portalPool, regs) {
  if (!regs.length) return;
  const vals = regs.map(r => [r.variation_id, r.campos.backorders,
    r.campos.weight===''?null:r.campos.weight, r.campos.length===''?null:r.campos.length,
    r.campos.width===''?null:r.campos.width, r.campos.height===''?null:r.campos.height]);
  await portalPool.query(
    `INSERT INTO sync_estado_var_campos (variation_id, backorders, weight, length, width, height)
     VALUES ${vals.map(()=>'(?,?,?,?,?,?)').join(',')}
     ON DUPLICATE KEY UPDATE backorders=VALUES(backorders), weight=VALUES(weight),
       length=VALUES(length), width=VALUES(width), height=VALUES(height)`,
    vals.flat());
}
async function guardarMemoriaPadre(portalPool, regs) {
  for (const r of regs) {
    await portalPool.query(
      `INSERT INTO sync_estado_padre (product_id, woocommerce_id, name, publicado, featured, visibility, short_description, categorias, etiquetas)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE woocommerce_id=VALUES(woocommerce_id), name=VALUES(name),
         publicado=VALUES(publicado), featured=VALUES(featured), visibility=VALUES(visibility),
         short_description=VALUES(short_description), categorias=VALUES(categorias), etiquetas=VALUES(etiquetas)`,
      [r.product_id, r.wc_target, r.campos.name, r.campos.publicado, r.campos.featured,
       r.campos.visibility, r.campos.short_description, r.campos.categorias, r.campos.etiquetas]);
  }
}

// Convierte los campos padre calculados al payload de WooCommerce
function payloadPadre(campos) {
  const statusWoo = campos.publicado; // ya viene 'publish'/'private'/'draft'
  return {
    name: campos.name,
    status: statusWoo,
    featured: !!campos.featured,
    catalog_visibility: campos.visibility,
    short_description: campos.short_description
  };
}
function payloadVarCampos(v) {
  const p = { backorders: v.backorders };
  if (v.weight !== '') p.weight = v.weight;
  if (v.length !== '' || v.width !== '' || v.height !== '') {
    p.dimensions = { length: v.length, width: v.width, height: v.height };
  }
  return p;
}

const pausa = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Orquestador de la fase ─────────────────────────────────────────────────
async function sincronizarCamposRicos({ prodPool, portalPool, wc, DRY_RUN, LOTE = 50, PAUSA = 16000, PAUSA_ITEM = 700 }) {
  console.log('\n──────────── FASE CAMPOS RICOS (nombre, publicado, visibilidad, etc.) ────────────');
  await prepararTablasCampos(portalPool);
  const rows = await leerDatosRicos(prodPool);
  console.log(`   ${rows.length} variaciones/simples en la web.`);

  const memVar = await leerMemoriaVar(portalPool);
  const memPadre = await leerMemoriaPadre(portalPool);

  // Categorías y etiquetas del ERP (Fase 2) por product_id
  const prodIds = [...new Set(rows.map(r => r.product_id))];
  const catMap = await leerCategoriasErp(prodPool, prodIds);
  const tagMap = await leerEtiquetasErp(prodPool, prodIds);
  const tax = crearResolvedorTaxonomia(wc, { DRY_RUN, PAUSA_ITEM });

  // 1) Detectar variaciones cuyos campos ricos cambiaron
  const varCambiadas = [];
  for (const r of rows) {
    const campos = calcularVariacion(r);
    if (!igualVar(campos, memVar[r.variation_id])) {
      varCambiadas.push({ ...r, campos });
    }
  }
  // 2) Detectar padres/simples cuyos campos cambiaron (incluye categorías y etiquetas)
  const padres = calcularPadres(rows, catMap, tagMap);
  const padreCambiado = [];
  for (const [pid, info] of padres) {
    const prev = memPadre[pid];
    if (!igualPadre(info.campos, prev)) {
      padreCambiado.push({ product_id: pid, ...info, prev });
    }
  }
  console.log(`   Cambios detectados: ${varCambiadas.length} variaciones, ${padreCambiado.length} productos (nivel padre).`);

  let okVar = 0, okPadre = 0, err = 0;
  const varOk = [], padreOk = [];

  if (DRY_RUN) {
    console.log('   *** DRY_RUN: no se escribe en WooCommerce. Se listan los cambios y no se guarda memoria. ***');
    varCambiadas.slice(0, 10).forEach(v => console.log(`     [var] ${v.sku} -> ${JSON.stringify(v.campos)}`));
    padreCambiado.slice(0, 10).forEach(p => console.log(`     [padre] ${p.sku_ref} (${p.tipo}) -> ${JSON.stringify(p.campos)}`));
    // Previsualizar qué categorías/etiquetas NO existen en la web (se crearían en real)
    for (const p of padreCambiado) {
      if (p.campos.categorias) await tax.resolverCategorias(p.campos.categorias);
      if (p.campos.etiquetas) await tax.resolverEtiquetas(p.campos.etiquetas);
    }
    const r = tax.resumen();
    if (r.categoriasCreadas.length) console.log(`   ⚠ Categorías que se CREARÍAN (${r.categoriasCreadas.length}): ${[...new Set(r.categoriasCreadas)].slice(0,20).join(' · ')}`);
    if (r.etiquetasCreadas.length) console.log(`   ⚠ Etiquetas que se CREARÍAN (${r.etiquetasCreadas.length}): ${[...new Set(r.etiquetasCreadas)].slice(0,20).join(' · ')}`);
    return { okVar, okPadre, err, dry: true, varCambiadas: varCambiadas.length, padreCambiado: padreCambiado.length };
  }

  // 3) PADRES: para 'simple' se combina con sus campos de variación en un solo PUT /products/{id};
  //    para 'variable' es un PUT /products/{wc_padre} con los campos de padre.
  const simplesVarCampos = {}; // wc_id -> payload de campos de variación (para fusionar en el simple)
  varCambiadas.forEach(v => { if (v.product_type === 'simple') simplesVarCampos[v.wc_id] = payloadVarCampos(v.campos); });

  let nPut = 0; // pausa CORTA entre cada PUT (sin ráfagas), para no saturar el hosting
  for (const p of padreCambiado) {
    if (nPut++ > 0) await pausa(PAUSA_ITEM);
    try {
      let body = payloadPadre(p.campos);
      if (p.tipo === 'simple' && simplesVarCampos[p.wc_target]) {
        body = { ...body, ...simplesVarCampos[p.wc_target] }; // fusiona reservas/peso/dims del simple
        delete simplesVarCampos[p.wc_target]; // ya lo mandamos aquí
      }
      // Categorías/etiquetas: solo si cambiaron vs memoria (resuelve nombre->ID, crea las que falten)
      const prev = p.prev || {};
      if (s(p.campos.categorias) !== s(prev.categorias)) {
        body.categories = await tax.resolverCategorias(p.campos.categorias);
      }
      if (s(p.campos.etiquetas) !== s(prev.etiquetas)) {
        body.tags = await tax.resolverEtiquetas(p.campos.etiquetas);
      }
      await wc.put(`/products/${p.wc_target}`, body);
      okPadre++; padreOk.push(p);
      if (p.tipo === 'simple') { const v = varCambiadas.find(x => x.wc_id === p.wc_target); if (v) { okVar++; varOk.push(v); } }
    } catch (e) {
      err++; const msg = e.response ? `HTTP ${e.response.status}` : e.message;
      console.log(`   ✗ padre ${p.sku_ref} (wc ${p.wc_target}): ${msg}`);
    }
  }

  // 4) Simples que cambiaron SOLO en campos de variación (su padre no cambió) → PUT propio
  const simplesSueltos = varCambiadas.filter(v => v.product_type === 'simple' && simplesVarCampos[v.wc_id]);
  let nPut2 = 0;
  for (const v of simplesSueltos) {
    if (nPut2++ > 0) await pausa(PAUSA_ITEM);
    try {
      await wc.put(`/products/${v.wc_id}`, simplesVarCampos[v.wc_id]);
      okVar++; varOk.push(v);
    } catch (e) { err++; console.log(`   ✗ simple ${v.sku} (wc ${v.wc_id}): ${e.response?('HTTP '+e.response.status):e.message}`); }
  }

  // 5) VARIACIONES (de productos variable) → batch por padre, con lectura del resultado por ítem
  const varsDeVariable = varCambiadas.filter(v => v.product_type === 'variation');
  const porPadre = {};
  varsDeVariable.forEach(v => { (porPadre[v.wc_padre] = porPadre[v.wc_padre] || []).push(v); });
  for (const padre of Object.keys(porPadre)) {
    const grupo = porPadre[padre];
    for (let i = 0; i < grupo.length; i += LOTE) {
      const lote = grupo.slice(i, i + LOTE);
      try {
        const { data } = await wc.post(`/products/${padre}/variations/batch`, {
          update: lote.map(v => ({ id: v.wc_id, ...payloadVarCampos(v.campos) }))
        });
        // Lectura por ítem: los que traen error en la respuesta NO se cuentan como OK
        const errById = {};
        (data && data.update || []).forEach(u => { if (u && u.error) errById[u.id] = u.error.message || 'error'; });
        for (const v of lote) {
          if (errById[v.wc_id]) { err++; console.log(`   ✗ variación ${v.sku} (wc ${v.wc_id}): ${errById[v.wc_id]}`); }
          else { okVar++; varOk.push(v); }
        }
      } catch (e) {
        err += lote.length;
        console.log(`   ✗ lote variaciones padre ${padre}: ${e.response?('HTTP '+e.response.status):e.message}`);
      }
      if (i + LOTE < grupo.length) await pausa(PAUSA);
    }
  }

  // 6) Guardar memoria SOLO de lo que se aplicó bien
  if (varOk.length) await guardarMemoriaVar(portalPool, varOk);
  if (padreOk.length) await guardarMemoriaPadre(portalPool, padreOk);

  const rtax = tax.resumen();
  if (rtax.categoriasCreadas.length) console.log(`   + Categorías nuevas creadas en la web (${rtax.categoriasCreadas.length}): ${[...new Set(rtax.categoriasCreadas)].slice(0,20).join(' · ')}`);
  if (rtax.etiquetasCreadas.length) console.log(`   + Etiquetas nuevas creadas en la web (${rtax.etiquetasCreadas.length}): ${[...new Set(rtax.etiquetasCreadas)].slice(0,20).join(' · ')}`);
  console.log(`   RESULTADO campos ricos: ${okPadre} productos (padre) + ${okVar} variaciones actualizadas, ${err} con error.`);
  return { okVar, okPadre, err, dry: false, categoriasCreadas: rtax.categoriasCreadas.length, etiquetasCreadas: rtax.etiquetasCreadas.length };
}

module.exports = {
  sincronizarCamposRicos, prepararTablasCampos, leerDatosRicos,
  calcularVariacion, calcularPadres, payloadPadre, payloadVarCampos
};
