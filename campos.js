// Funciones puras de cálculo de campos "ricos" ERP -> WooCommerce (Kuranko)
// Reproducen las fórmulas del Excel del usuario. Sin dependencias.

// backorder_mode ('no'|'notify'|'yes') -> valor WooCommerce ('no'|'notify')
function backordersWoo(mode){
  return (mode === 'notify' || mode === 'yes') ? 'notify' : 'no';
}

// Publicado final (WooCommerce status): 'publish' | 'private'
//  fórmula: si stock>0 -> 1(publish); si no -> -1(private) solo si discontinued, si no 1(publish)
function publicadoWoo(stock, statusErp){
  const val = (stock > 0) ? 1 : (statusErp === 'discontinued' ? -1 : 1);
  return val === 1 ? 'publish' : (val === -1 ? 'private' : 'draft');
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
