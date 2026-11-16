import path from 'node:path';
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { createPrintRunner, createPrintWorker, parsePrintArgs } from '../services/printRunner.js';
import { listSystemPrinters } from '../services/printers.js';

dotenv.config();
const serverUrl = (process.env.PRINT_SERVER_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/api\/?$/, '').replace(/\/$/, '');
const outputDir = path.resolve(process.cwd(), process.env.PRINT_OUTPUT_DIR || 'print-jobs');
const mode = process.env.PRINT_MODE || 'system';
const modulo = process.env.PRINT_MODULE || 'cocina';
const token = process.env.PRINT_AGENT_TOKEN || '';
const printer = process.env.PRINT_PRINTER || '';
const args = parsePrintArgs(process.env.PRINT_ARGS || '');
if (!['cocina', 'caja'].includes(modulo)) throw new Error('PRINT_MODULE debe ser cocina o caja.');

if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ serverUrl, mode, modulo, printer: printer || '(configuracion del negocio)',
    tokenConfigured: Boolean(token), printers: await listSystemPrinters() }, null, 2));
} else {
  if (!token) throw new Error('Configura PRINT_AGENT_TOKEN con el mismo secreto del servidor.');
  const run = createPrintRunner({ outputDir, mode, printer, command: process.env.PRINT_COMMAND || '', args });
  const api = async (route, body) => {
    const response = await fetch(`${serverUrl}/api/impresiones${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-print-token': token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    return data;
  };
  const tick = createPrintWorker({ api, run, outputDir, modulo });
  const poll = async () => {
    try {
      const result = await tick();
      if (result) console.log(`[print-agent] ${result.estado}${result.error ? ': ' + result.error : ''}`);
    } catch (error) { console.error(`[print-agent] ${error.message}`); }
  };
  console.log(`[print-agent] ${modulo}, modo ${mode}. ${mode === 'simulate' ? 'SIMULACION: no imprime papel.' : 'ENVIADO = aceptado por el controlador.'}`);
  await poll();
  const timer = setInterval(poll, 2000);
  // Existing precuenta producers still use realtime; comandas use only the durable queue.
  const socket = io(serverUrl, { reconnection: true, auth: { printToken: token } });
  let legacyQueue = Promise.resolve();
  if (modulo === 'caja') {
    for (const event of ['print:precuenta', 'print:ticket', 'print:factura', 'print:cierre']) {
      socket.on(event, (payload) => {
        legacyQueue = legacyQueue.then(() => run({ id: randomUUID(), payload }))
          .then((result) => console.log(`[print-agent] ${result.estado} ${event}`))
          .catch((error) => console.error(`[print-agent] ${event}: ${error.message}`));
      });
    }
  }
  socket.on('print:comanda', () => { if (modulo === 'cocina') poll(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); socket.close(); });
}
