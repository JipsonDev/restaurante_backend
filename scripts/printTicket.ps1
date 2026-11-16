param(
  [Parameter(Mandatory = $true)][string]$TicketPath,
  [Parameter(Mandatory = $true)][string]$PrinterName
)
$ErrorActionPreference = 'Stop'
$ticketPrinter = Get-Printer | Where-Object { $_.Name -eq $PrinterName } | Select-Object -First 1
if (-not $ticketPrinter) { throw "No existe la impresora: $PrinterName" }
if ($ticketPrinter.PortName -eq 'PORTPROMPT:' -or $ticketPrinter.Name -match 'OneNote|Print to PDF|XPS Document') {
  throw 'Selecciona una impresora de tickets fisica. Para pruebas sin papel usa PRINT_MODE=simulate.'
}
# Uses the installed Windows driver and its configured ticket paper size.
Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | Out-Printer -Name $PrinterName
