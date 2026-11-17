import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAWER_PULSE, encodeCp850, escposTicket } from '../services/printRunner.js';
import { agentOnline, markAgentSeen } from '../services/printQueue.js';

test('el texto en español se codifica en la página 850 de la impresora', () => {
  assert.deepEqual(encodeCp850('Ñandú ¿sí?'), [0xa5, 0x61, 0x6e, 0x64, 0xa3, 0x20, 0xa8, 0x73, 0xa1, 0x3f]);
  assert.deepEqual(encodeCp850('a\r\nb'), [0x61, 0x0a, 0x62]);
  assert.deepEqual(encodeCp850('−$1'), [0x2d, 0x24, 0x31]);
});

test('el ticket corta el papel y abre el cajón solo si se pide', () => {
  const has = (buf, seq) => buf.indexOf(Buffer.from(seq)) >= 0;
  const plain = escposTicket({ texto: 'Hola' });
  assert.ok(has(plain, [0x1d, 0x56, 0x42, 0x03]));
  assert.ok(!has(plain, DRAWER_PULSE));
  assert.ok(has(escposTicket({ texto: 'Hola', abrir_cajon: true }), DRAWER_PULSE));
  assert.ok(!has(escposTicket({ texto: 'Hola', abrir_cajon: true }, { drawer: false }), DRAWER_PULSE));
  const drawerOnly = escposTicket({ solo_cajon: true });
  assert.ok(has(drawerOnly, DRAWER_PULSE));
  assert.ok(!has(drawerOnly, [0x1d, 0x56]));
});

test('el agente se da por conectado solo si pidió trabajo hace poco', () => {
  markAgentSeen('caja', 1_000_000);
  assert.equal(agentOnline('caja', 1_010_000), true);
  assert.equal(agentOnline('caja', 1_020_000), false);
  assert.equal(agentOnline('cocina', 1_010_000), false);
});
