// Rango de fechas de un reporte: un periodo fijo (hoy, 7, 30, 90 días) o un rango propio «desde–hasta».
// Devuelve también el periodo anterior del mismo largo, para comparar.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = new Set([1, 7, 30, 90]);
export const MAX_REPORT_DAYS = 366;

const toUTC = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const valid = day => DAY.test(String(day || '')) && new Date(toUTC(day)).toISOString().slice(0, 10) === day;
export const shiftDay = (day, n) => new Date(toUTC(day) + n * 86400000).toISOString().slice(0, 10);
const fail = message => Object.assign(new Error(message), { status: 400 });

export function reportRange(query = {}, today) {
  let from, to;
  if (query.desde !== undefined || query.hasta !== undefined) {
    if (!valid(query.desde) || !valid(query.hasta)) throw fail('Indica el rango con fechas válidas (desde y hasta, formato AAAA-MM-DD).');
    from = query.desde; to = query.hasta;
    if (to < from) throw fail('La fecha final no puede ser anterior a la inicial.');
    if (to > today) throw fail('El rango no puede terminar después de hoy.');
  } else {
    const days = Number(query.days || 7);
    if (!PERIODS.has(days)) throw fail('Periodo inválido. Usa 1, 7, 30 o 90 días, o un rango desde–hasta.');
    to = today; from = shiftDay(today, -(days - 1));
  }
  const days = Math.round((toUTC(to) - toUTC(from)) / 86400000) + 1;
  if (days > MAX_REPORT_DAYS) throw fail('El rango no puede pasar de un año.');
  return { from, to, days, previousFrom: shiftDay(from, -days), previousTo: shiftDay(from, -1) };
}
