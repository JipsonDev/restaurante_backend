import { roomsForEvent } from './services/socketAuth.js';

let io = null;
const listeners = new Set();

/** Escucha todo lo que se emite (lo usa el vigilante de stock para revisar tras cada venta). */
export function onRealtimeEmit(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setRealtimeServer(server) {
  io = server;
}

export function emitRealtime(event, payload = {}) {
  for (const fn of listeners) { try { fn(event, payload); } catch { /* un oyente no frena el aviso */ } }
  if (!io) return;
  // Nunca io.emit: solo salas autenticadas (ver services/socketAuth.js).
  io.to(roomsForEvent(event)).emit(event, {
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
  RESERVATION_UPDATED: 'reservation:updated',
  PRINT_COMANDA: 'print:comanda',
  PRINT_PRECUENTA: 'print:precuenta',
  CATALOG_UPDATED: 'catalog:updated',
  INVENTORY_ALERT: 'inventory:alert',
};
