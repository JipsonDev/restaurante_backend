import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function normalizePrinter(row = {}) {
  const name = row.Name || row.name || row.printer || '';
  if (!name) return null;
  const port = row.PortName || row.port || '';
  const lower = `${name} ${port}`.toLowerCase();
  return {
    name,
    driver: row.DriverName || row.driver || '',
    port,
    shared: Boolean(row.Shared || row.shared),
    connection: lower.includes('bluetooth') || lower.includes('bth') ? 'Bluetooth'
      : lower.includes('usb') ? 'USB'
        : lower.includes('ip_') || lower.includes('tcp') || /\d+\.\d+\.\d+\.\d+/.test(lower) ? 'Red'
          : 'Sistema',
  };
}

async function listWindowsPrinters() {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'Get-Printer | Select-Object Name,DriverName,PortName,Shared | ConvertTo-Json -Compress',
  ], { windowsHide: true, timeout: 12000 });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizePrinter).filter(Boolean);
}

async function listUnixPrinters() {
  const { stdout } = await execFileAsync('lpstat', ['-p'], { timeout: 12000 });
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^printer\s+(\S+)/i);
      return match ? normalizePrinter({ name: match[1] }) : null;
    })
    .filter(Boolean);
}

export async function listSystemPrinters() {
  if (process.env.PRINT_AVAILABLE_PRINTERS) {
    return process.env.PRINT_AVAILABLE_PRINTERS
      .split(',')
      .map((name) => normalizePrinter({ name: name.trim() }))
      .filter(Boolean);
  }

  try {
    if (os.platform() === 'win32') return await listWindowsPrinters();
    return await listUnixPrinters();
  } catch (error) {
    return [];
  }
}
