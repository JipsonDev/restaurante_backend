import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrintRunner, createPrintWorker, parsePrintArgs } from '../services/printRunner.js';

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'morena-print-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const job = { id: 'test-1', claim_token: 'lease-1', payload: { texto: 'COCINA\n2x Café\nSin azúcar', impresora: 'Tickets Cocina USB' } };

test('quoted names and paths remain single arguments', () => {
  assert.deepEqual(parsePrintArgs('/D:"{printer}" "{file}"'), ['/D:{printer}', '{file}']);
  assert.deepEqual(parsePrintArgs('["-d","{printer}","{file}"]'), ['-d', '{printer}', '{file}']);
  assert.throws(() => parsePrintArgs('"unfinished'));
});

test('simulation writes the complete ticket and never reports physical printing', async (t) => {
  const outputDir = await directory(t);
  const run = createPrintRunner({ outputDir, mode: 'simulate', exec: assert.fail });
  const result = await run(job);
  assert.equal(result.estado, 'SIMULADO');
  assert.equal(await fs.readFile(result.file, 'utf8'), job.payload.texto);
});

test('Windows dispatches a named printer without shell or visible window', async (t) => {
  const outputDir = await directory(t);
  let call;
  const run = createPrintRunner({ outputDir, platform: 'win32', exec: async (...args) => { call = args; } });
  assert.equal((await run(job)).estado, 'ENVIADO');
  assert.equal(call[0], 'powershell.exe');
  assert.equal(call[1].at(-1), 'Tickets Cocina USB');
  assert.equal(call[2].shell, false);
  assert.equal(call[2].windowsHide, true);
});

test('custom executable really consumes the ticket, including paths with spaces', async (t) => {
  const outputDir = await directory(t);
  const fakePrinter = path.join(outputDir, 'fake printer.cjs');
  const received = path.join(outputDir, 'received.txt');
  await fs.writeFile(fakePrinter, "require('fs').copyFileSync(process.argv[2], process.argv[3]);");
  const run = createPrintRunner({ outputDir, command: process.execPath, args: [fakePrinter, '{file}', received] });
  assert.equal((await run(job)).estado, 'ENVIADO');
  assert.equal(await fs.readFile(received, 'utf8'), job.payload.texto);
});

test('missing printer and failed executable are errors, not success', async (t) => {
  const outputDir = await directory(t);
  await assert.rejects(createPrintRunner({ outputDir })({ ...job, payload: { texto: 'Ticket' } }), /Configura/);
  await assert.rejects(createPrintRunner({ outputDir, exec: async () => { throw new Error('offline'); } })(job), /offline/);
});

test('duplicate wakeups and a lost ACK cannot print twice, even after restart', async (t) => {
  const outputDir = await directory(t);
  let prints = 0, claims = 0, acknowledgements = 0;
  const api = async (route) => {
    if (route === '/claim') { claims += 1; return { job }; }
    acknowledgements += 1;
    if (acknowledgements === 1) throw new Error('network lost');
    return { ok: true };
  };
  const run = async () => { prints += 1; return { estado: 'ENVIADO' }; };
  const worker = createPrintWorker({ api, run, outputDir });
  const first = worker();
  await worker();
  await assert.rejects(first, /network lost/);
  const restarted = createPrintWorker({ api, run, outputDir });
  await restarted();
  assert.equal(prints, 1);
  assert.equal(claims, 1);
  assert.equal(acknowledgements, 2);
});

test('interrupted dispatch is marked for review without printing again', async (t) => {
  const outputDir = await directory(t);
  await fs.writeFile(path.join(outputDir, 'receipt-cocina.json'), JSON.stringify({ id: job.id, claim_token: job.claim_token }));
  let result;
  await createPrintWorker({ outputDir, run: assert.fail, api: async (_route, body) => { result = body; } })();
  assert.equal(result.estado, 'REVISAR');
});

test('printer failure is acknowledged as ERROR and keeps the ticket file', async (t) => {
  const outputDir = await directory(t);
  let result;
  const worker = createPrintWorker({ outputDir, run: async () => { throw new Error('paper jam'); },
    api: async (route, body) => { if (route === '/claim') return { job }; result = body; },
  });
  await worker();
  assert.equal(result.estado, 'ERROR');
  assert.equal(result.error, 'paper jam');
});
