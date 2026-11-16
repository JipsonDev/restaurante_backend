import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { claimPrintJob, finishPrintJob, printQueueStatus } from '../services/printQueue.js';

const router = express.Router();
export function verifyPrintAgent(req, res, next) {
  const expected = Buffer.from(process.env.PRINT_AGENT_TOKEN || '');
  const provided = Buffer.from(String(req.headers['x-print-token'] || ''));
  if (!expected.length) return res.status(503).json({ message: 'PRINT_AGENT_TOKEN no configurado en el servidor.' });
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ message: 'Agente de impresion no autorizado.' });
  }
  next();
}

router.get('/estado', verifyToken, verifyRole('admin', 'cocina', 'mesero', 'caja'), async (_req, res) => {
  try { res.json(await printQueueStatus()); }
  catch (error) { res.status(503).json({ message: error.message }); }
});

router.post('/claim', verifyPrintAgent, async (req, res) => {
  const modulo = req.body.modulo || 'cocina';
  if (!['cocina', 'caja'].includes(modulo)) return res.status(400).json({ message: 'Modulo invalido.' });
  try { res.json({ job: await claimPrintJob(modulo) }); }
  catch (error) { res.status(503).json({ message: error.message }); }
});

router.post('/:id/resultado', verifyPrintAgent, async (req, res) => {
  try {
    const updated = await finishPrintJob(req.params.id, req.body.claim_token, req.body.estado, req.body.error);
    res.status(updated ? 200 : 409).json({ ok: updated });
  } catch (error) { res.status(400).json({ message: error.message }); }
});

export default router;
