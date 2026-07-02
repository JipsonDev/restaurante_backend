import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { io } from 'socket.io-client';
import dotenv from 'dotenv';

dotenv.config();

const serverUrl = process.env.PRINT_SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
const outputDir = path.resolve(process.cwd(), process.env.PRINT_OUTPUT_DIR || 'print-jobs');
const printCommand = process.env.PRINT_COMMAND || '';
const printArgs = (process.env.PRINT_ARGS || '').split(' ').filter(Boolean);

fs.mkdirSync(outputDir, { recursive: true });

function safeName(type, payload) {
  const suffix = payload.pedido_id || Date.now();
  const template = String(payload.plantilla || payload.tipo || type)
    .replace(/[^a-z0-9_-]/gi, '_')
    .toLowerCase();
  return `${template}-${suffix}-${Date.now()}.txt`;
}

function runPrintCommand(file, printer = '') {
  if (!printCommand) {
    console.log(`[print-agent] Ticket guardado: ${file}${printer ? ` | impresora sugerida: ${printer}` : ''}`);
    return;
  }

  const args = printArgs.map((arg) => arg.replace('{file}', file).replace('{printer}', printer || ''));
  const child = spawn(printCommand, args, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => {
    if (code !== 0) console.error(`[print-agent] Comando de impresion termino con codigo ${code}`);
  });
}

function handlePrint(type, payload = {}) {
  const file = path.join(outputDir, safeName(type, payload));
  fs.writeFileSync(file, payload.texto || '', 'utf8');
  runPrintCommand(file, payload.impresora || payload.printer || '');
}

const socket = io(serverUrl, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
});

socket.on('connect', () => {
  console.log(`[print-agent] Conectado a ${serverUrl}`);
});

socket.on('print:comanda', (payload) => handlePrint('comanda', payload));
socket.on('print:precuenta', (payload) => handlePrint('precuenta', payload));
socket.on('print:ticket', (payload) => handlePrint('ticket', payload));
socket.on('print:factura', (payload) => handlePrint('factura', payload));
socket.on('print:cierre', (payload) => handlePrint('cierre', payload));

socket.on('connect_error', (error) => {
  console.error(`[print-agent] No se pudo conectar: ${error.message}`);
});
