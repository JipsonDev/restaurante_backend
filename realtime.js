let io = null;

export function setRealtimeServer(server) {
  io = server;
}

export function emitRealtime(event, payload = {}) {
  if (!io) return;
  io.emit(event, {
    ...payload,
    emitted_at: new Date().toISOString(),
  });
}

export const EVENTS = {
  ORDER_CREATED: 'order:created',
  ORDER_UPDATED: 'order:updated',
  ORDER_READY: 'order:ready',
  SPLIT_REQUESTED: 'split:requested',
  TABLE_OCCUPIED: 'TABLE_OCCUPIED',
  TABLE_FREED: 'TABLE_FREED',
  TABLE_UPDATED: 'TABLE_UPDATED',
  PAYMENT_CREATED: 'payment:created',
  CASH_UPDATED: 'cash:updated',
  PRINT_COMANDA: 'print:comanda',
  PRINT_PRECUENTA: 'print:precuenta',
};
