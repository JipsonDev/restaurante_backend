// End-to-end simulation: real agent process -> HTTP queue -> .txt -> ACK.
// No production database, credentials or physical printer is used.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = path.resolve('print-jobs', 'demo', randomUUID());
const token = randomUUID();
const job = { id: randomUUID(), claim_token: randomUUID(), payload: {
  pedido_id: 100, modulo: 'cocina', plantilla: 'ticket_cocina',
  texto: '              MORENA MIA\n          PRUEBA SIN IMPRESORA\n------------------------------------------\nCOMANDA #00100                  Mesa 3\n2x Cafe con leche\n   Sin azucar - Leche deslactosada\n1x Sandwich\n   Sin cebolla\n------------------------------------------\nSIMULACION: NO SE HA IMPRESO PAPEL\n',
} };
let claimed = false;
let complete;
const done = new Promise((resolve) => { complete = resolve; });
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.headers['x-print-token'] !== token) { res.writeHead(401); res.end('{}'); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/api/impresiones/claim') {
    res.end(JSON.stringify({ job: claimed ? null : job }));
    claimed = true;
  } else if (req.url === `/api/impresiones/${job.id}/resultado`) {
    const result = JSON.parse(body);
    res.end('{"ok":true}');
    complete(result);
  } else { res.writeHead(404); res.end('{}'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const child = spawn(process.execPath, [fileURLToPath(new URL('./printAgent.js', import.meta.url))], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PRINT_SERVER_URL: `http://127.0.0.1:${server.address().port}`, PRINT_AGENT_TOKEN: token,
    PRINT_MODE: 'simulate', PRINT_MODULE: 'cocina', PRINT_OUTPUT_DIR: outputDir, PRINT_COMMAND: '', PRINT_ARGS: '' },
});
let timeout;
try {
  const failure = new Promise((_resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Agente termino antes de confirmar (${code}).`)));
    timeout = setTimeout(() => reject(new Error('El agente no confirmo en 20 segundos.')), 20000);
  });
  const result = await Promise.race([done, failure]);
  const file = path.join(outputDir, `${job.id}.txt`);
  if (result.estado !== 'SIMULADO' || await fs.readFile(file, 'utf8') !== job.payload.texto) {
    throw new Error('La simulacion no produjo la comanda esperada.');
  }
  console.log(`OK: comanda enviada automaticamente, guardada y confirmada como SIMULADO.\n${file}`);
} finally {
  clearTimeout(timeout);
  child.kill();
  server.closeAllConnections();
  server.close();
}
