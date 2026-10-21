// Funciones puras de cálculo de campos "ricos" ERP -> WooCommerce (Kuranko)
// Reproducen las fórmulas del Excel del usuario. Sin dependencias.

// backorder_mode ('no'|'notify'|'yes') -> valor WooCommerce ('no'|'notify')
function backordersWoo(mode){
  return (mode === 'notify' || mode === 'yes') ? 'notify' : 'no';
}

// ERP en Borrador o Descontinuada -> el producto se esconde por completo en la web
function esInactivoErp(statusErp){
  return statusErp === 'draft' || statusErp === 'discontinued';
}

// Publicado final (WooCommerce status): 'publish' | 'private'
//  Borrador o Descontinuada (con o sin stock) -> 'private' (Visibilidad: Privada).
//  Activa -> 'publish' (Visibilidad: Pública).
function publicadoWoo(stock, statusErp){
  return esInactivoErp(statusErp) ? 'private' : 'publish';
}

// Visibilidad final: 'visible' | 'hidden'
//  =IF(OR(back=notify,back=1),"visible",IF(OR(pubErp=-1,pubErp=0,nombre~"PCK"),"hidden",IF(stock>0,"visible","hidden")))
//  pubErp: mapeo ERP status -> export Publicado: active->1, discontinued->0, draft->-1
function statusAExportPub(statusErp){
  if (statusErp === 'active') return 1;
  if (statusErp === 'discontinued') return 0;
  if (statusErp === 'draft') return -1;
  return 1;
}
function visibilidadWoo(stock, statusErp, backordersFinal, nombre){
  const pubErp = statusAExportPub(statusErp);
  const tienePCK = /PCK/.test(String(nombre||''));
  // Borrador o Descontinuada: siempre oculto, aunque tenga reservas ("A pedido")
  if (esInactivoErp(statusErp)) return 'hidden';
  if (backordersFinal === 'notify') return 'visible';
  if (pubErp === -1 || pubErp === 0 || tienePCK) return 'hidden';
  return stock > 0 ? 'visible' : 'hidden';
}

// Descripción corta: solo simple/variable, sin stock y notify -> HTML; si no, ''
function descripcionCortaWoo(tipo, stock, backordersFinal, htmlSimple, htmlVariable){
  if (tipo === 'simple'){
    if (stock > 0) return '';
    return backordersFinal === 'notify' ? htmlSimple : '';
  }
  if (tipo === 'variable'){
    if (stock > 0) return '';
    return backordersFinal === 'notify' ? htmlVariable : '';
  }
  return ''; // variation u otro
}

// Categorías:
//  - '' -> ''
//  - si el nombre tiene "MKP": UNA sola categoría, dentro de Marketplace.
//    Se toma la primera ruta jerárquica (con " > "); si no hay, la primera ruta.
//    Las demás categorías se descartan (el producto queda solo en Marketplace).
//  - si no: la(s) ruta(s) tal cual.
function categoriasWoo(rutaErp, nombre){
  const ruta = (rutaErp || '').trim();
  if (!ruta) return '';
  if (/MKP/.test(String(nombre||''))) {
    const paths = ruta.split(',').map(x => x.trim()).filter(Boolean);
    const elegida = paths.find(p => p.includes('>')) || paths[0] || '';
    return elegida ? ('Marketplace > ' + elegida) : '';
  }
  return ruta;
}

module.exports = { backordersWoo, publicadoWoo, statusAExportPub, visibilidadWoo, descripcionCortaWoo, categoriasWoo };
