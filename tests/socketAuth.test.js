import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { attachSocketAuth, authenticateSocket, roomsForEvent } from '../services/socketAuth.js';

const jwtSecret = 'socket-test-secret';
const printToken = 'print-test-token';

test('handshake requires a valid JWT or the print agent token', () => {
  const token = jwt.sign({ id: 3, rol: 'Mesero' }, jwtSecret, { expiresIn: '1h' });
  const staff = authenticateSocket({ auth: { token } }, { jwtSecret, printToken });
  assert.equal(staff.kind, 'staff');
  assert.equal(staff.user.rol, 'mesero');
  assert.equal(authenticateSocket({ auth: { printToken } }, { jwtSecret, printToken }).kind, 'print-agent');
  for (const handshake of [{}, { auth: { token: 'forged' } }, { auth: { printToken: 'wrong' } }, { auth: { printToken: '' } }]) {
    assert.throws(() => authenticateSocket(handshake, { jwtSecret, printToken }), /unauthorized/);
  }
  assert.throws(() => authenticateSocket({ auth: { token: jwt.sign({ id: 1 }, 'otro-secreto') } }, { jwtSecret, printToken }));
});

test('print agents only get print events', () => {
  assert.deepEqual(roomsForEvent('order:created'), ['staff']);
  assert.deepEqual(roomsForEvent('print:comanda'), ['staff', 'print-agent']);
});

test('anonymous sockets are refused and only staff receive business events', async () => {
  const server = http.createServer();
  const io = new Server(server);
  attachSocketAuth(io, () => ({ jwtSecret, printToken }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const opts = { transports: ['websocket'], reconnection: false };
  try {
    const anonymous = connect(url, opts);
    const refused = await new Promise(resolve => anonymous.on('connect_error', error => resolve(error.message)));
    assert.equal(refused, 'unauthorized');
    anonymous.close();

    const staff = connect(url, { ...opts, auth: { token: jwt.sign({ id: 1, rol: 'cocina' }, jwtSecret, { expiresIn: '1h' }) } });
    const agent = connect(url, { ...opts, auth: { printToken } });
    await Promise.all([staff, agent].map(s => new Promise(resolve => s.on('system:connected', resolve))));
    const agentGotOrder = [];
    agent.on('order:created', payload => agentGotOrder.push(payload));
    const staffGot = new Promise(resolve => staff.on('order:created', resolve));
    const agentGotPrint = new Promise(resolve => agent.on('print:comanda', resolve));
    io.to(roomsForEvent('order:created')).emit('order:created', { id: 7 });
    io.to(roomsForEvent('print:comanda')).emit('print:comanda', { id: 7 });
    assert.equal((await staffGot).id, 7);
    assert.equal((await agentGotPrint).id, 7);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(agentGotOrder.length, 0);
    staff.close();
    agent.close();
  } finally {
    io.close();
    await new Promise(resolve => server.close(resolve));
  }
});
