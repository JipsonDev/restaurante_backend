import express from 'express';
import { pool } from '../db.js';

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

export async function sendPushToUser(trabajadorId, notification = {}) {
  const userId = Number(trabajadorId);
  if (!userId) return { sent: 0, reason: 'missing_user' };

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
