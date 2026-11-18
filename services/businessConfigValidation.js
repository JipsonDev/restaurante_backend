const LIMITS = {
  nombre_restaurante: 120,
  razon_social: 180,
  ruc: 13,
  direccion: 240,
  telefono: 40,
  correo: 160,
  logo_url: 500,
  color_marca: 7,
  iva_porcentaje: 7,
  servicio_porcentaje: 7,
  moneda: 3,
  simbolo_moneda: 5,
  texto_ticket: 400,
  impresora_caja: 180,
  impresora_cocina: 180,
  alertas_demora_activas: 1,
  alerta_espera_minutos: 3,
  alerta_lista_minutos: 3,
};

function configError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function text(value, label, max, { required = false } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw configError(`${label} es obligatorio.`);
  if (result.length > max) throw configError(`${label} admite hasta ${max} caracteres.`);
  return result;
}

function percentage(value, label) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!/^\d{1,3}(?:\.\d{1,3})?$/.test(raw)) throw configError(`${label} debe ser un porcentaje entre 0 y 100.`);
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw configError(`${label} debe ser un porcentaje entre 0 y 100.`);
  return String(number);
}

export function normalizeBusinessConfigPatch(values = {}, allowedKeys = Object.keys(LIMITS)) {
  const allowed = new Set(allowedKeys);
  const result = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!allowed.has(key)) continue;
    if (key === 'alertas_demora_activas') {
      if (!['0','1'].includes(String(value))) throw configError('Las alertas deben usar 0 o 1.');
      result[key] = String(value);
    } else if (['alerta_espera_minutos','alerta_lista_minutos'].includes(key)) {
      const raw = String(value ?? '').trim();
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 240) throw configError('Los límites de atención deben ser minutos enteros entre 1 y 240.');
      result[key] = String(Number(raw));
    } else if (key === 'nombre_restaurante') result[key] = text(value, 'El nombre del restaurante', LIMITS[key], { required: true });
    else if (key === 'iva_porcentaje') result[key] = percentage(value, 'El IVA');
    else if (key === 'servicio_porcentaje') result[key] = percentage(value, 'El servicio');
    else if (key === 'moneda') {
      const currency = String(value ?? '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw configError('La moneda debe usar un código de tres letras, por ejemplo USD.');
      result[key] = currency;
    } else if (key === 'simbolo_moneda') result[key] = text(value, 'El símbolo de moneda', LIMITS[key], { required: true });
    else if (key === 'correo') {
      const email = text(value, 'El correo', LIMITS[key]).toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw configError('El correo de facturación no es válido.');
      result[key] = email;
    } else if (key === 'ruc') {
      const taxId = text(value, 'El RUC o identificación fiscal', LIMITS[key]);
      if (taxId && !/^\d{10,13}$/.test(taxId)) throw configError('El RUC o identificación fiscal debe tener entre 10 y 13 dígitos.');
      result[key] = taxId;
    } else if (key === 'telefono') {
      const phone = text(value, 'El teléfono', LIMITS[key]);
      if (phone && phone.replace(/\D/g, '').length < 7) throw configError('El teléfono debe contener al menos 7 dígitos.');
      result[key] = phone;
    } else if (key === 'color_marca') {
      // Color principal del local (marca blanca): #RRGGBB, o vacío para el color del producto.
      const color = String(value ?? '').trim();
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw configError('El color de marca debe ser un código como #D63B20.');
      result[key] = color.toUpperCase();
    } else if (key === 'logo_url') {
      const url = text(value, 'La URL del logo', LIMITS[key]);
      if (url && !/^\/uploads\//i.test(url) && !/^https?:\/\//i.test(url)) throw configError('El logo debe ser una URL http(s) o una imagen cargada en el sistema.');
      result[key] = url;
    } else result[key] = text(value, key.replaceAll('_', ' '), LIMITS[key]);
  }
  return result;
}
