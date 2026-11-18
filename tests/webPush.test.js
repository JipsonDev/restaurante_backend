import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decryptPayload, encryptPayload, generateVapidKeys, sendWebPush, vapidAuthorization, validSubscription } from '../services/webPush.js';

// Vector de ejemplo del RFC 8291, apéndice A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('cifrado idéntico al ejemplo del RFC 8291', () => {
  const body = encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: RFC.salt, serverPrivateKey: RFC.asPrivate });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(decryptPayload(body, { uaPrivateKey: RFC.uaPrivate, p256dh: RFC.uaPublic, auth: RFC.auth }).toString(), RFC.plaintext);
});

test('cada aviso se cifra distinto y el navegador lo puede leer', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { p256dh: ua.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  const message = JSON.stringify({ title: 'Mesa 4: ronda lista', body: 'Café americano, Bolón mixto' });
  const a = encryptPayload(message, sub), b = encryptPayload(message, sub);
  assert.notEqual(a.toString('hex'), b.toString('hex'));
  assert.equal(decryptPayload(a, { uaPrivateKey: ua.getPrivateKey('base64url'), ...sub }).toString(), message);
  assert.throws(() => encryptPayload('x'.repeat(4000), sub), /largo/);
  assert.throws(() => encryptPayload('x', { p256dh: 'abc', auth: sub.auth }), /p256dh/);
});

test('la firma VAPID es un JWT ES256 válido para el servicio de push', () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, { now: 1_800_000_000_000 });
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [h, c, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.exp, 1_800_000_000 + 12 * 3600);
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('solo se aceptan suscripciones de servicios de push conocidos', () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
  assert.ok(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }));
  assert.ok(validSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys }));
  assert.ok(validSubscription({ endpoint: 'https://web.push.apple.com/QGx', keys }));
  assert.ok(!validSubscription({ endpoint: 'https://evil.example.com/push', keys }));
  assert.ok(!validSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys }));
  assert.ok(!validSubscription({ endpoint: 'https://fcm.googleapis.com.evil.com/x', keys }));
  assert.ok(!validSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: RFC.auth } }));
});

test('envío: encabezados correctos y suscripciones vencidas marcadas', async () => {
  const keys = generateVapidKeys();
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  let seen;
  const ok = await sendWebPush(sub, { title: 'Hola' }, keys, { topic: 'listo-12', fetchImpl: async (url, init) => { seen = { url, init }; return { status: 201 }; } });
  assert.deepEqual(ok, { ok: true, gone: false, status: 201 });
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.Topic, 'listo-12');
  assert.equal(seen.init.headers.Urgency, 'high');
  assert.equal(JSON.parse(decryptPayload(seen.init.body, { uaPrivateKey: ua.getPrivateKey('base64url'), ...sub.keys })).title, 'Hola');
  assert.equal((await sendWebPush(sub, {}, keys, { fetchImpl: async () => ({ status: 410 }) })).gone, true);
  assert.equal((await sendWebPush(sub, {}, keys, { fetchImpl: async () => { throw new Error('sin red'); } })).ok, false);
});
