param(
  [Parameter(Mandatory = $true)][string]$RawPath,
  [Parameter(Mandatory = $true)][string]$PrinterName
)
# Envía bytes ESC/POS tal cual a la impresora (tipo de datos RAW): permite cortar el papel y abrir el cajón.
# Usa la cola de impresión de Windows, así que funciona con el controlador que ya trae la impresora USB.
$ErrorActionPreference = 'Stop'
$ticketPrinter = Get-Printer | Where-Object { $_.Name -eq $PrinterName } | Select-Object -First 1
if (-not $ticketPrinter) { throw "No existe la impresora: $PrinterName" }
if ($ticketPrinter.PortName -eq 'PORTPROMPT:' -or $ticketPrinter.Name -match 'OneNote|Print to PDF|XPS Document') {
  throw 'Selecciona una impresora de tickets fisica. Para pruebas sin papel usa PRINT_MODE=simulate.'
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int StartDocPrinter(IntPtr handle, int level, DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      var info = new DOCINFO { pDocName = "Morena Mia caja", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, info) == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written) || written != bytes.Length) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($RawPath))
