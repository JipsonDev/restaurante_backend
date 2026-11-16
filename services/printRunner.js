import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);

export function parsePrintArgs(value = '') {
  if (!value.trim()) return [];
  if (value.trim().startsWith('[')) {
    const args = JSON.parse(value);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('PRINT_ARGS debe ser una lista JSON de textos.');
    return args;
  }
  const args = [];
  let current = '', quote = null;
  for (const char of value) {
    if (quote) { if (char === quote) quote = null; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) { args.push(current); current = ''; } }
    else current += char;
  }
  if (quote) throw new Error('PRINT_ARGS contiene comillas sin cerrar.');
  if (current) args.push(current);
  return args;
}

export function createPrintRunner({ outputDir, mode = 'system', printer = '', command = '', args = [], platform = process.platform, exec = execute }) {
  if (!['system', 'simulate'].includes(mode)) throw new Error('PRINT_MODE debe ser system o simulate.');
  return async (job) => {
    if (!/^[a-zA-Z0-9-]+$/.test(job.id) || !job.payload?.texto?.trim()) throw new Error('Trabajo de impresion invalido.');
    await fs.mkdir(outputDir, { recursive: true });
    const file = path.join(outputDir, `${job.id}.txt`);
    await fs.writeFile(file, job.payload.texto, 'utf8');
    if (mode === 'simulate') return { estado: 'SIMULADO', file };
    const target = job.payload.impresora || printer;
    if (!target) throw new Error('Configura impresora_cocina o PRINT_PRINTER; no se selecciona una impresora por defecto.');
    if (command) {
      if (!args.some((arg) => arg.includes('{file}'))) throw new Error('PRINT_ARGS debe incluir {file}.');
      await exec(command, args.map((arg) => arg.replaceAll('{file}', file).replaceAll('{printer}', target)), { windowsHide: true, timeout: 60000, shell: false });
    } else if (platform === 'win32') {
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('../scripts/printTicket.ps1', import.meta.url)), '-TicketPath', file, '-PrinterName', target,
      ], { windowsHide: true, timeout: 60000, shell: false });
    } else {
      await exec('lp', ['-d', target, '--', file], { timeout: 60000, shell: false });
    }
    return { estado: 'ENVIADO', file };
  };
}

export function createPrintWorker({ api, run, outputDir, modulo = 'cocina' }) {
  let busy = false;
  const receiptFile = path.join(outputDir, `receipt-${modulo}.json`);
  const saveReceipt = async (receipt) => {
    await fs.writeFile(`${receiptFile}.tmp`, JSON.stringify(receipt), 'utf8');
    await fs.rename(`${receiptFile}.tmp`, receiptFile);
  };
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await fs.mkdir(outputDir, { recursive: true });
      let receipt;
      try { receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (receipt) {
        const result = receipt.result || { estado: 'REVISAR', error: 'El agente se detuvo durante el envio; revisar impresora antes de reimprimir.' };
        await api(`/${receipt.id}/resultado`, { claim_token: receipt.claim_token, ...result });
        await fs.unlink(receiptFile);
        return;
      }
      const { job } = await api('/claim', { modulo });
      if (!job) return;
      receipt = { id: job.id, claim_token: job.claim_token };
      await saveReceipt(receipt);
      let result;
      try { result = await run(job); }
      catch (error) { result = { estado: 'ERROR', error: error.message }; }
      receipt.result = { estado: result.estado, error: result.error || null };
      await saveReceipt(receipt);
      await api(`/${job.id}/resultado`, { claim_token: job.claim_token, ...receipt.result });
      await fs.unlink(receiptFile);
      return result;
    } finally { busy = false; }
  };
}
