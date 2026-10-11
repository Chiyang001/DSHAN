import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardDuplicateHelloVerify } from '../dtls-compat.js';

test('DTLS duplicate cookie requests do not restart Flight3; other handshake messages still reach verification', async () => {
  const processed = [];
  const socket = { dtls: { flight: 1 }, onHandleHandshakes: async messages => {
    for (const message of messages) {
      if (message.msg_type === 3) { assert.equal(socket.dtls.flight, 1); socket.dtls.flight = 3; }
      processed.push(message.msg_type);
    }
  } };
  guardDuplicateHelloVerify(socket);
  await socket.onHandleHandshakes([{ msg_type: 3 }, { msg_type: 3 }, { msg_type: 2 }, { msg_type: 11 }]);
  assert.deepEqual(processed, [3, 2, 11]);
  socket.dtls.flight = 5;
  await socket.onHandleHandshakes([{ msg_type: 3 }, { msg_type: 20 }]);
  assert.deepEqual(processed, [3, 2, 11, 20]);
});

test('server orders reordered client authentication without skipping verification', async () => {
  const processed = [];
  const socket = { sessionType: 2, dtls: { flight: 4 }, onHandleHandshakes: async messages => {
    for (const message of messages) processed.push(message.msg_type);
  } };
  guardDuplicateHelloVerify(socket);
  await socket.onHandleHandshakes([{ msg_type: 15 }, { msg_type: 16 }]);
  assert.deepEqual(processed, []);
  await socket.onHandleHandshakes([{ msg_type: 11 }]);
  assert.deepEqual(processed, [11, 16, 15]);
  await socket.onHandleHandshakes([{ msg_type: 11 }, { msg_type: 16 }, { msg_type: 15 }]);
  assert.deepEqual(processed, [11, 16, 15]);
});

test('certificate verification errors propagate through compatibility handling', async () => {
  const socket = { sessionType: 2, dtls: { flight: 4 }, onHandleHandshakes: async messages => {
    if (messages.some(message => message.msg_type === 15)) throw new Error('invalid proof');
  } };
  guardDuplicateHelloVerify(socket);
  await assert.rejects(socket.onHandleHandshakes([{ msg_type: 11 }, { msg_type: 16 }, { msg_type: 15 }]), /invalid proof/);
});

test('client buffers the server flight in sequence and ignores retransmissions', async () => {
  const processed = [];
  const socket = { sessionType: 1, dtls: { flight: 3 }, onHandleHandshakes: async messages => {
    processed.push(...messages.map(message => message.msg_type));
  } };
  guardDuplicateHelloVerify(socket);
  const flight = [2, 11, 12, 13, 14].map((msg_type, index) => ({ msg_type, message_seq: index + 1 }));
  await socket.onHandleHandshakes([...flight].reverse());
  await socket.onHandleHandshakes(flight);
  assert.deepEqual(processed, [2, 11, 12, 13, 14]);
});
