import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Peer } from '../peer.js';
import { createSignalServer } from '../signal-server.js';
import { createPair, encodePair, decodePair, sign, verify } from '../protocol.js';

test('private pair codes and authenticated descriptions reject changes and replays', () => {
  const pair = createPair('wss://example.org/peer');
  assert.deepEqual(decodePair(encodePair(pair)), pair);
  assert.throws(() => createPair('ws://example.org'));
  const httpPair = createPair('ws://example.org', true);
  assert.throws(() => decodePair(encodePair(httpPair)));
  assert.deepEqual(decodePair(encodePair(httpPair), true), httpPair);
  assert.throws(() => decodePair('bad'));
  assert.throws(() => decodePair(encodePair({ ...pair, signalingAddress: 'invalid-address' })));
  assert.throws(() => decodePair(encodePair({ ...pair, mode: 'unknown' })));
  const message = sign(pair, 'host', 0, { type: 'offer', sdp: 'fingerprint' });
  assert.equal(verify(pair, 'host', 0, message).sdp, 'fingerprint');
  assert.throws(() => verify(pair, 'guest', 0, message));
  assert.throws(() => verify(pair, 'host', 1, message));
  assert.throws(() => verify(pair, 'host', 0, { ...message, payload: message.payload + ' ' }));
});

test('real WebRTC peers transfer bidirectional tools, large images, cancellation and disconnect', { timeout: 40000 }, async t => {
  const server = createSignalServer({ port: 0 });
  await once(server.http, 'listening');
  const pair = createPair(`ws://127.0.0.1:${server.http.address().port}`);
  let canceled = false;
  const dispatch = label => async (method, args, signal) => {
    if (method === 'list') return [{ name: label }];
    if (method === 'large') return { data: 'x'.repeat(400000) };
    if (method === 'wait') { await new Promise(resolve => signal.addEventListener('abort', () => { canceled = true; resolve(); }, { once: true })); return 'canceled'; }
    if (method === 'call' && args.name === label) return { label, args };
    throw new Error('Tool not shared');
  };
  const host = new Peer({ pair, role: 'host', dispatch: dispatch('phone') });
  const hostAddresses = host.pc.config.iceAdditionalHostAddresses;
  assert.equal(hostAddresses, undefined);
  // Exercise Android's explicit-address path against a desktop peer.
  const { networkInterfaces } = await import('node:os');
  const local = Object.values(networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal);
  assert.ok(local);
  const guest = new Peer({ pair, role: 'guest', hostAddresses: [local.address], dispatch: dispatch('desktop') });
  t.after(async () => { await host.close(); await guest.close(); await server.close(); });
  await Promise.all([host.ready, guest.ready]);
  assert.deepEqual(await host.request('list', {}), [{ name: 'desktop' }]);
  assert.deepEqual(await guest.request('list', {}), [{ name: 'phone' }]);
  const [a, b] = await Promise.all([host.request('call', { name: 'desktop' }), guest.request('call', { name: 'phone' })]);
  assert.equal(a.label, 'desktop'); assert.equal(b.label, 'phone');
  assert.equal((await guest.request('large', {})).data.length, 400000);
  await assert.rejects(host.request('call', { name: 'forbidden' }), /not shared/);
  const controller = new AbortController();
  const pending = guest.request('wait', {}, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /outcome may be unknown/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(canceled, true);
  const disconnected = guest.request('wait', {});
  const rejected = assert.rejects(disconnected, /disconnected/);
  await guest.close();
  await rejected;
});
