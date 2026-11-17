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

// ── ESC/POS ────────────────────────────────────────────────────────────────
// Impresoras térmicas de tickets: el texto va en la página de códigos 850 (tildes y eñes),
// se corta el papel y, si se pide, se manda el pulso que abre el cajón de dinero.
const CP850 = { 'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'ç': 0x87, 'ê': 0x88, 'è': 0x8a, 'ï': 0x8b, 'î': 0x8c,
  'Ä': 0x8e, 'É': 0x90, 'ô': 0x93, 'ö': 0x94, 'û': 0x96, 'ù': 0x97, 'Ö': 0x99, 'Ü': 0x9a, 'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3,
  'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7, '¿': 0xa8, '¡': 0xad, 'Á': 0xb5, 'Â': 0xb6, 'À': 0xb7, 'Í': 0xd6, 'Ó': 0xe0, 'Ú': 0xe9, '°': 0xf8, '·': 0xfa, '€': 0xd5 };
const ESC = 0x1b, GS = 0x1d;
export const DRAWER_PULSE = [ESC, 0x70, 0x00, 0x19, 0xfa]; // ESC p 0 25 250: pin 2, pulso de 50 ms
export function encodeCp850(text) {
  const out = [];
  for (const char of String(text).replace(/\r\n?/g, '\n').normalize('NFC')) {
    const code = char.codePointAt(0);
    if (code === 0x0a || (code >= 0x20 && code < 0x7f)) out.push(code);
    else if (CP850[char] != null) out.push(CP850[char]);
    else if (/[−–—]/.test(char)) out.push(0x2d);
    else out.push(0x3f); // «?» para lo que la impresora no puede mostrar
  }
  return out;
}
export function escposTicket({ texto = '', abrir_cajon = false, solo_cajon = false } = {}, { drawer = true } = {}) {
  const bytes = [ESC, 0x40, ESC, 0x74, 0x02]; // inicializar + página de códigos 850
  if (drawer && (abrir_cajon || solo_cajon)) bytes.push(...DRAWER_PULSE);
  if (!solo_cajon) bytes.push(...encodeCp850(texto), 0x0a, 0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x03); // texto, avance y corte parcial
  return Buffer.from(bytes);
}

export function createPrintRunner({ outputDir, mode = 'system', printer = '', command = '', args = [], platform = process.platform, exec = execute, drawer = true }) {
  if (!['system', 'simulate', 'escpos'].includes(mode)) throw new Error('PRINT_MODE debe ser system, escpos o simulate.');
  return async (job) => {
    if (!/^[a-zA-Z0-9-]+$/.test(job.id) || (!job.payload?.texto?.trim() && !job.payload?.solo_cajon)) throw new Error('Trabajo de impresion invalido.');
    await fs.mkdir(outputDir, { recursive: true });
    const file = path.join(outputDir, `${job.id}.txt`);
    await fs.writeFile(file, job.payload.texto || '[abrir cajón]', 'utf8');
    if (mode === 'simulate') return { estado: 'SIMULADO', file };
    const target = job.payload.impresora || printer;
    if (!target) throw new Error('Configura impresora_cocina o PRINT_PRINTER; no se selecciona una impresora por defecto.');
    if (mode === 'escpos') {
      const raw = path.join(outputDir, `${job.id}.bin`);
      await fs.writeFile(raw, escposTicket(job.payload, { drawer }));
      if (platform === 'win32') {
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          fileURLToPath(new URL('../scripts/printRaw.ps1', import.meta.url)), '-RawPath', raw, '-PrinterName', target,
        ], { windowsHide: true, timeout: 60000, shell: false });
      } else {
        await exec('lp', ['-d', target, '-o', 'raw', '--', raw], { timeout: 60000, shell: false });
      }
      return { estado: 'ENVIADO', file };
    }
    if (job.payload.solo_cajon) throw new Error('Abrir el cajón necesita PRINT_MODE=escpos.');
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
