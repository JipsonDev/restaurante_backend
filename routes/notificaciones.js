import crypto from 'node:crypto';
import express from 'express';
import { pool } from '../db.js';
import { generateVapidKeys, sendWebPush, validSubscription } from '../services/webPush.js';

const router = express.Router();
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
let pushDevicesReady = false;

async function ensurePushDevices() {
  if (pushDevicesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      trabajador_id INT NOT NULL,
      expo_push_token VARCHAR(255) NOT NULL,
      platform VARCHAR(30) NULL,
      device_name VARCHAR(120) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_push_token (expo_push_token),
      INDEX idx_push_devices_user (trabajador_id, enabled)
    )
  `);
  pushDevicesReady = true;
}

function isExpoPushToken(token) {
  return /^ExponentPushToken\[[^\]]+\]$/.test(token) || /^ExpoPushToken\[[^\]]+\]$/.test(token);
}

async function sendExpoPush(messages) {
  if (!messages.length || typeof fetch !== 'function') return { sent: 0, disabled: 0 };

  let sent = 0;
  let disabled = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        console.warn('Expo push fallo:', result || response.statusText);
        continue;
      }

      (result?.data || []).forEach((ticket, index) => {
        if (ticket?.status === 'ok') sent += 1;
        if (ticket?.details?.error === 'DeviceNotRegistered') {
          disabled += 1;
          const token = chunk[index]?.to;
          if (token) {
            pool.query('UPDATE push_devices SET enabled = 0 WHERE expo_push_token = ?', [token]).catch(() => {});
          }
        }
      });
    } catch (error) {
      console.warn('No se pudo enviar push Expo:', error.message);
    }
  }
  return { sent, disabled };
}

// ── Web Push (app web instalada en el teléfono) ─────────────────────────────
let webPushReady = false;
let vapidKeysPromise = null;
async function ensureWebPush() {
  if (webPushReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS web_push_suscripciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    trabajador_id INT NOT NULL,
    endpoint VARCHAR(1000) NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    p256dh VARCHAR(200) NOT NULL,
    auth VARCHAR(100) NOT NULL,
    dispositivo VARCHAR(160) NULL,
    fallos INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_web_push_endpoint (endpoint_hash),
    INDEX idx_web_push_user (trabajador_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS push_config (
    clave VARCHAR(60) NOT NULL,
    valor TEXT NOT NULL,
    PRIMARY KEY (clave)
  )`);
  webPushReady = true;
}

/** Claves VAPID: del entorno o, si no hay, creadas una vez y guardadas en la base. */
export function getVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return Promise.resolve({ publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() });
  }
  if (!vapidKeysPromise) {
    vapidKeysPromise = (async () => {
      await ensureWebPush();
      const fresh = generateVapidKeys();
      // INSERT IGNORE: si dos servidores arrancan a la vez, gana la primera clave guardada.
      await pool.query('INSERT IGNORE INTO push_config (clave, valor) VALUES (?, ?)', ['vapid', JSON.stringify(fresh)]);
      const [[row]] = await pool.query('SELECT valor FROM push_config WHERE clave = ?', ['vapid']);
      return JSON.parse(row.valor);
    })().catch((error) => { vapidKeysPromise = null; throw error; });
  }
  return vapidKeysPromise;
}

const endpointHash = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex');

async function sendWebPushToUsers(userIds, notification = {}) {
  const ids = [...new Set(userIds.map(Number).filter(Boolean))];
  if (!ids.length) return { sent: 0 };
  await ensureWebPush();
  const [subs] = await pool.query(`SELECT id, endpoint, p256dh, auth FROM web_push_suscripciones WHERE trabajador_id IN (${ids.map(() => '?').join(', ')})`, ids);
  if (!subs.length) return { sent: 0 };
  const keys = await getVapidKeys();
  const message = {
    title: notification.title || 'Morena Mía',
    body: notification.body || '',
    tag: notification.tag || notification.data?.type || 'aviso',
    kind: notification.kind || 'ready',
    data: { ...(notification.data || {}), url: '/' },
  };
  const results = await Promise.all(subs.map(async (sub) => {
    const result = await sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, message, keys,
      { ttl: notification.ttl || 300, topic: message.tag, urgency: notification.urgency || 'high' });
    // Suscripción vencida (el teléfono la anuló): se borra. Tras muchos fallos seguidos, también.
    if (result.gone) await pool.query('DELETE FROM web_push_suscripciones WHERE id = ?', [sub.id]).catch(() => {});
    else if (!result.ok) await pool.query('UPDATE web_push_suscripciones SET fallos = fallos + 1 WHERE id = ?', [sub.id]).catch(() => {});
    else await pool.query('UPDATE web_push_suscripciones SET fallos = 0 WHERE id = ? AND fallos > 0', [sub.id]).catch(() => {});
    return result;
  }));
  await pool.query('DELETE FROM web_push_suscripciones WHERE fallos >= 20').catch(() => {});
  return { sent: results.filter((r) => r.ok).length };
}

/** Aviso a todos los trabajadores activos con alguno de estos roles (p. ej. «queda poco» para administración). */
export async function sendPushToRoles(roles = [], notification = {}) {
  if (!roles.length) return { sent: 0 };
  const [users] = await pool.query(`SELECT id FROM trabajadores WHERE rol IN (${roles.map(() => '?').join(', ')}) AND COALESCE(activo, 1) = 1`, roles);
  return sendWebPushToUsers(users.map((u) => u.id), notification);
}

export async function sendPushToUser(trabajadorId, notification = {}) {
  const userId = Number(trabajadorId);
  if (!userId) return { sent: 0, reason: 'missing_user' };

  // Web Push y Expo en paralelo: uno no frena al otro.
  const web = sendWebPushToUsers([userId], notification).catch((error) => { console.warn('Web Push:', error.message); return { sent: 0 }; });
  const expo = sendExpoToUser(userId, notification);
  const [w, e] = await Promise.all([web, expo]);
  return { sent: (w.sent || 0) + (e.sent || 0) };
}

async function sendExpoToUser(userId, notification) {
  await ensurePushDevices();
  const [devices] = await pool.query(
    `SELECT expo_push_token
     FROM push_devices
     WHERE trabajador_id = ?
       AND enabled = 1`,
    [userId]
  );

  const messages = devices
    .map((device) => device.expo_push_token)
    .filter(isExpoPushToken)
    .map((token) => ({
      to: token,
      sound: 'default',
      priority: 'high',
      title: notification.title || 'Morena Mia',
      body: notification.body || 'Tienes una actualizacion pendiente.',
      data: notification.data || {},
    }));

  return sendExpoPush(messages);
}

router.post('/push-token', async (req, res) => {
  const { token, platform = null, device_name = null } = req.body || {};
  if (!isExpoPushToken(String(token || ''))) {
    return res.status(400).json({ message: 'Token push invalido.' });
  }

  try {
    await ensurePushDevices();
    await pool.query(
      `INSERT INTO push_devices (trabajador_id, expo_push_token, platform, device_name, enabled)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         trabajador_id = VALUES(trabajador_id),
         platform = VALUES(platform),
         device_name = VALUES(device_name),
         enabled = 1,
         last_seen_at = CURRENT_TIMESTAMP`,
      [req.user.id, token, platform, device_name]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Clave pública para que el navegador cree la suscripción.
router.get('/web-push/clave', async (_req, res) => {
  try { res.json({ publicKey: (await getVapidKeys()).publicKey }); }
  catch (error) { res.status(500).json({ message: 'No se pudo preparar los avisos.', error: error.message }); }
});

// Guarda la suscripción de este teléfono para el trabajador que inició sesión.
router.post('/web-push', async (req, res) => {
  const sub = req.body?.subscription;
  if (!validSubscription(sub)) return res.status(400).json({ message: 'Suscripción de avisos inválida.' });
  try {
    await ensureWebPush();
    const device = String(req.body?.dispositivo || req.get('user-agent') || '').slice(0, 160) || null;
    // Un mismo teléfono puede cambiar de mesero: la suscripción pasa al que inició sesión.
    await pool.query(`INSERT INTO web_push_suscripciones (trabajador_id, endpoint, endpoint_hash, p256dh, auth, dispositivo)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE trabajador_id = VALUES(trabajador_id), endpoint = VALUES(endpoint), p256dh = VALUES(p256dh), auth = VALUES(auth), dispositivo = VALUES(dispositivo), fallos = 0`,
    [req.user.id, sub.endpoint, endpointHash(sub.endpoint), sub.keys.p256dh, sub.keys.auth, device]);
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo activar los avisos.', error: error.message });
  }
});

router.delete('/web-push', async (req, res) => {
  try {
    await ensureWebPush();
    const endpoint = req.body?.endpoint;
    if (endpoint) await pool.query('DELETE FROM web_push_suscripciones WHERE endpoint_hash = ? AND trabajador_id = ?', [endpointHash(endpoint), req.user.id]);
    else await pool.query('DELETE FROM web_push_suscripciones WHERE trabajador_id = ?', [req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Aviso de prueba al propio teléfono (botón «Probar» en «Más»). Sale unos segundos después para dar tiempo a bloquear el teléfono.
router.post('/web-push/prueba', async (req, res) => {
  try {
    await ensureWebPush();
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM web_push_suscripciones WHERE trabajador_id = ?', [req.user.id]);
    if (!Number(n)) return res.json({ sent: 0, scheduled: false });
    const delay = Math.max(0, Math.min(15, Number(req.body?.delay) || 0));
    const send = () => sendWebPushToUsers([req.user.id], { title: 'Prueba: Mesa 4 lista para llevar', body: 'Así llega el aviso con el teléfono bloqueado.', tag: 'prueba', ttl: 60 }).catch(() => {});
    if (delay) { setTimeout(send, delay * 1000).unref?.(); return res.json({ sent: Number(n), scheduled: true, delay }); }
    res.json(await send());
  } catch (error) {
    res.status(500).json({ message: 'No se pudo enviar la prueba.', error: error.message });
  }
});

router.delete('/push-token', async (req, res) => {
  const { token } = req.body || {};
  try {
    await ensurePushDevices();
    if (token) {
      await pool.query(
        'UPDATE push_devices SET enabled = 0 WHERE trabajador_id = ? AND expo_push_token = ?',
        [req.user.id, token]
      );
    } else {
      await pool.query('UPDATE push_devices SET enabled = 0 WHERE trabajador_id = ?', [req.user.id]);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
