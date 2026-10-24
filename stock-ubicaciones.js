// ─── Ubicaciones que NO cuentan para el stock de la web ─────────────────────
// Por defecto CUARENTENA y EMBAJADOR: misma regla que el portal (Promociones,
// variable PROMO_EXCLUIR) y que el envío en vivo de las campañas. Si se cambia
// aquí (STOCK_EXCLUIR), hay que cambiarlo igual en el portal (PROMO_EXCLUIR).
// Se compara el nombre completo de la ubicación, sin tildes, mayúsculas ni
// espacios dobles.
const normalizar = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/\s+/g, ' ').trim();
const EXCLUIR = new Set((process.env.STOCK_EXCLUIR || 'CUARENTENA,EMBAJADOR')
  .split(',').map(normalizar).filter(Boolean));

let cache = null;
// Devuelve los id de location a excluir (nunca vacío: [0] si no hay ninguno, para usar en NOT IN (?))
async function ubicacionesExcluidas(prodPool) {
  if (cache) return cache;
  const [rows] = await prodPool.query(`SELECT id, name FROM locations`);
  const fuera = rows.filter(l => EXCLUIR.has(normalizar(l.name)));
  if (fuera.length) console.log(`   Stock sin contar: ${fuera.map(l => l.name).join(', ')}`);
  else console.log(`   ⚠ No se encontró ninguna ubicación llamada ${[...EXCLUIR].join(' / ')}: se cuenta todo el stock.`);
  cache = fuera.length ? fuera.map(l => l.id) : [0];
  return cache;
}

module.exports = { ubicacionesExcluidas, normalizar, EXCLUIR };
