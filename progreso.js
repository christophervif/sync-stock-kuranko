// ─── Avance en el log para fases largas ─────────────────────────────────────
// Escribe una línea de avance cada CADA ítems o cada SEG segundos (lo que pase
// primero), con porcentaje, tiempo transcurrido y tiempo estimado que falta.
// Así una fase larga (p. ej. 400 productos padre con pausas de 16 s) no parece
// detenida en Railway.
//
//   const av = crearAvance('Variaciones (stock y precio)', padres.length, 'productos padre');
//   ... en el loop: av.paso(() => `${ok} ok, ${err} con error`);
//   ... al final:   av.fin(() => `${ok} ok, ${err} con error`);
const fmtMin = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'menos de 1 min';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

function crearAvance(nombre, total, unidad = 'ítems', { CADA = 10, SEG = 60 } = {}) {
  const t0 = Date.now();
  let hechos = 0, ultimo = 0, ultimoN = 0;
  const linea = (extra, final) => {
    const ms = Date.now() - t0;
    const pct = total ? Math.floor((hechos / total) * 100) : 100;
    const resta = (!final && hechos && total > hechos) ? ms / hechos * (total - hechos) : null;
    const falta = resta == null ? '' : ` · faltan ${resta < 60000 ? 'menos de 1 min' : '~' + fmtMin(resta)}`;
    const x = typeof extra === 'function' ? extra() : extra;
    console.log(`   ${final ? '✓' : '…'} ${nombre}: ${hechos}/${total} ${unidad} (${pct} %)` +
      `${x ? ' · ' + x : ''} · lleva ${fmtMin(ms)}${falta}`);
    ultimo = Date.now(); ultimoN = hechos;
  };
  if (total) console.log(`   ▶ ${nombre}: ${total} ${unidad} por procesar.`);
  return {
    // Llamar al terminar CADA ítem
    paso(extra) {
      hechos++;
      if (hechos === total) return;                      // la línea final la escribe fin()
      if (hechos - ultimoN >= CADA || Date.now() - ultimo >= SEG * 1000 || hechos === 1) linea(extra, false);
    },
    fin(extra) { if (total) linea(extra, true); }
  };
}

module.exports = { crearAvance };
