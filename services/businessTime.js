// Día de negocio en la hora del local (Ecuador, UTC−5), sin depender de la zona del servidor de base de datos.
// MySQL guarda las fechas con NOW() en la zona de su sesión (en Aiven, UTC). Si se compara DATE(created_at) con
// CURDATE(), desde las 19:00 de Ecuador las ventas caen en «mañana». Aquí todo se convierte a la zona del negocio.
const raw = String(process.env.BUSINESS_TZ_OFFSET || '-05:00').trim();
export const BUSINESS_TZ = /^[+-](0\d|1[0-4]):[0-5]\d$/.test(raw) ? raw : '-05:00';

const local = (expr) => `CONVERT_TZ(${expr}, @@session.time_zone, '${BUSINESS_TZ}')`;

/** Fecha y hora del local para una columna DATETIME (p. ej. para sacar la hora con HOUR()). */
export const localTime = (column) => local(column);
/** Fecha (AAAA-MM-DD) del local para una columna o expresión DATETIME. */
export const localDate = (column) => `DATE(${local(column)})`;
/** Hoy, en la hora del local. */
export const localToday = () => `DATE(${local('NOW()')})`;
/** Condición «la columna cae en el día de hoy del local» (usa índices: compara rangos en la zona de la base). */
export const isLocalToday = (column) =>
  `${column} >= CONVERT_TZ(${localToday()}, '${BUSINESS_TZ}', @@session.time_zone) AND ${column} < CONVERT_TZ(DATE_ADD(${localToday()}, INTERVAL 1 DAY), '${BUSINESS_TZ}', @@session.time_zone)`;
/** Inicio del día local `?` (AAAA-MM-DD) expresado en la zona de la base. Úsalo como `col >= ${fromLocalDay()}`. */
export const fromLocalDay = () => `CONVERT_TZ(?, '${BUSINESS_TZ}', @@session.time_zone)`;
/** Fin exclusivo del día local `?`. Úsalo como `col < ${toLocalDayEnd()}`. */
export const toLocalDayEnd = () => `CONVERT_TZ(DATE_ADD(?, INTERVAL 1 DAY), '${BUSINESS_TZ}', @@session.time_zone)`;
/** Hoy menos N días, en hora local, como límite en la zona de la base. */
export const localDaysAgo = (days) => `CONVERT_TZ(DATE_SUB(${localToday()}, INTERVAL ${Number(days) | 0} DAY), '${BUSINESS_TZ}', @@session.time_zone)`;
export const localTomorrow = () => `CONVERT_TZ(DATE_ADD(${localToday()}, INTERVAL 1 DAY), '${BUSINESS_TZ}', @@session.time_zone)`;
/** Fecha de hoy (AAAA-MM-DD) en la hora del local, calculada en Node. */
export function localTodayISO(now = new Date()) {
  const [, sign, hh, mm] = BUSINESS_TZ.match(/^([+-])(\d\d):(\d\d)$/);
  const offset = (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  return new Date(now.getTime() + offset * 60000).toISOString().slice(0, 10);
}
/** Fecha y hora del local como texto 'AAAA-MM-DD HH:MM' (el formato de las reservas), calculada en Node. */
export function localNowStamp(now = new Date()) {
  const [, sign, hh, mm] = BUSINESS_TZ.match(/^([+-])(\d\d):(\d\d)$/);
  const offset = (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  return new Date(now.getTime() + offset * 60000).toISOString().slice(0, 16).replace('T', ' ');
}
