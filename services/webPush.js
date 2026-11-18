// Web Push sin dependencias: avisos que llegan al teléfono aunque esté bloqueado o la app cerrada.
// Cifrado del mensaje según RFC 8291 (aes128gcm) y firma del servidor según RFC 8292 (VAPID).
// Las claves VAPID salen de VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY o, si no existen, se crean una vez
// y se guardan en la base (las suscripciones quedan atadas a esa clave: no debe cambiar).
import crypto from 'node:crypto';

const b64u = buffer => Buffer.from(buffer).toString('base64url');
const fromB64u = text => Buffer.from(String(text || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ── Claves VAPID ────────────────────────────────────────────────────────────
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('Clave pública VAPID inválida.');
  const d = fromB64u(privateKey);
  if (d.length !== 32) throw new Error('Clave privada VAPID inválida.');
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(d) }, format: 'jwk' });
}

/** Encabezado Authorization (VAPID) para enviar a un endpoint. */
export function vapidAuthorization(endpoint, keys, { subject = 'mailto:avisos@morenamia.local', now = Date.now(), ttlHours = 12 } = {}) {
  const audience = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + ttlHours * 3600, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

// ── Cifrado del mensaje (RFC 8291) ──────────────────────────────────────────
// options.salt y options.serverPrivateKey existen solo para comprobar con los vectores del RFC.
export function encryptPayload(plaintext, { p256dh, auth }, options = {}) {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Suscripción inválida: clave p256dh.');
  if (authSecret.length !== 16) throw new Error('Suscripción inválida: clave auth.');
  const ecdh = crypto.createECDH('prime256v1');
  if (options.serverPrivateKey) ecdh.setPrivateKey(fromB64u(options.serverPrivateKey)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const salt = options.salt ? fromB64u(options.salt) : crypto.randomBytes(16);

  const prkKey = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext));
  if (data.length > 3800) throw new Error('El aviso es demasiado largo.');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Descifra (lo hace el navegador; aquí solo para las pruebas). */
export function decryptPayload(body, { uaPrivateKey, p256dh, auth }) {
  const salt = body.subarray(0, 16), idLength = body[20];
  const asPublic = body.subarray(21, 21 + idLength), ciphertext = body.subarray(21 + idLength);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(fromB64u(uaPrivateKey));
  const uaPublic = fromB64u(p256dh);
  const prkKey = hmac(fromB64u(auth), ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1; while (end >= 0 && padded[end] === 0) end--;
  return padded.subarray(0, end); // quita el delimitador 0x02
}

// Solo servicios de push conocidos: así una suscripción falsa no convierte al servidor en un «cartero» hacia cualquier sitio.
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.microsoft\.com$/];
export function validSubscription(sub) {
  try {
    const url = new URL(String(sub?.endpoint || ''));
    if (url.protocol !== 'https:' || String(sub.endpoint).length > 1000) return false;
    if (!PUSH_HOSTS.some(re => re.test(url.hostname))) return false;
    return fromB64u(sub?.keys?.p256dh).length === 65 && fromB64u(sub?.keys?.auth).length === 16;
  } catch { return false; }
}

/** Envía un aviso. Devuelve { ok, gone } (gone = la suscripción ya no existe y hay que borrarla). */
export async function sendWebPush(subscription, message, keys, { ttl = 300, urgency = 'high', topic, fetchImpl = globalThis.fetch } = {}) {
  const body = encryptPayload(JSON.stringify(message), subscription.keys);
  const headers = {
    Authorization: vapidAuthorization(subscription.endpoint, keys),
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    TTL: String(ttl), Urgency: urgency,
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body, signal: controller.signal });
    const status = response.status;
    return { ok: status >= 200 && status < 300, gone: status === 404 || status === 410, status };
  } catch (error) {
    return { ok: false, gone: false, status: 0, error: error.message };
  } finally { clearTimeout(timer); }
}
