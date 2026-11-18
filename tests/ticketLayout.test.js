import test from 'node:test';
import assert from 'node:assert/strict';
import { escposTicket, encodeStyled } from '../services/printRunner.js';
import { build, t } from '../services/ticketLayout.js';

const has = (buf, seq) => buf.includes(Buffer.from(seq));

test('ESC/POS aplica título grande y negrita cuando llega el texto con estilos', () => {
  const markup = build(t.title('Mesa 5'), t.big('2 x Seco de pollo'), 'normal');
  const bytes = escposTicket({ texto: 'plano', texto_marcado: markup });
  assert.ok(has(bytes, [0x1d, 0x21, 0x11]), 'doble ancho y alto');
  assert.ok(has(bytes, [0x1d, 0x21, 0x01]), 'doble alto');
  assert.ok(has(bytes, [0x1d, 0x21, 0x00]), 'vuelve a tamaño normal');
  assert.ok(!bytes.includes(Buffer.from('plano')), 'no imprime el texto plano');
  assert.ok(!bytes.includes(0x1f), 'no deja marcas de estilo');
  assert.ok(encodeStyled('hola').length > 0);
});

test('sin texto con estilos imprime el plano de siempre (agentes y trabajos antiguos)', () => {
  const bytes = escposTicket({ texto: 'Hola' });
  assert.ok(bytes.includes(Buffer.from('Hola')));
  assert.ok(!has(bytes, [0x1d, 0x21, 0x11]));
});
