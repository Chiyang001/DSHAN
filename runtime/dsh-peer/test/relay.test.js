import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPair } from '../protocol.js';
import { createSignalServer } from '../signal-server.js';
import { Peer } from '../peer.js';
import { RelayWire } from '../relay.js';

for (const mode of ['relay', 'auto']) test(`${mode}: encrypted relay transfers bidirectional RPC, images and disconnects`, { timeout: 15000 }, async t => {
  const server = createSignalServer({ port: 0, ttl: 100 }); await once(server.http, 'listening');
  const pair = { ...createPair(`ws://127.0.0.1:${server.http.address().port}`), mode };
  const relayed = [];
  const options = { pair, fallbackDelay: 0, dispatch: async (method, args, signal) => {
    if (method === 'slow') { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('canceled'); }
    return args;
  } };
  const host = new Peer({ ...options, role: 'host' });
  const guest = new Peer({ ...options, role: 'guest' });
  t.after(async () => { await host.close(); await guest.close(); await server.close(); });
  host.ws.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'relay-data') relayed.push(raw.toString()); });
  await Promise.all([host.ready, guest.ready]);
  assert.match(host.status().transport, /relay/);
  assert.match(guest.status().transport, /relay/);
  const privateText = 'private tool body not visible to server';
  assert.equal(await host.request('echo', privateText), privateText);
  assert.equal(await guest.request('echo', privateText), privateText);
  const image = { content: [{ type: 'image', data: 'Q'.repeat(400000) }] };
  assert.deepEqual(await host.request('echo', image), image);
  assert.ok(relayed.length > 10);
  assert.ok(relayed.every(raw => !raw.includes(privateText)));
  assert.ok([...server.rooms.values()].every(room => !JSON.stringify(room.access).includes(pair.secret)));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await host.request('echo', 'paired room stays alive beyond pairing TTL'), 'paired room stays alive beyond pairing TTL');
  const controller = new AbortController();
  const slow = host.request('slow', {}, controller.signal); controller.abort();
  await assert.rejects(slow, /canceled/);
  const closed = once(host.ws, 'close');
  await guest.close(); await closed;
  assert.equal(host.state, 'closed');
  await assert.rejects(host.request('echo', {}), /not connected/);
});

test('relay rejects ciphertext tampering, reflection, replay and oversized frames', async () => {
  const pair = createPair('wss://example.org');
  const frames = [], messages = [], errors = [];
  const ws = { readyState: 1, send(raw, callback) { frames.push(JSON.parse(raw)); callback(); } };
  const host = new RelayWire(ws, pair, 'host', 'session1', value => messages.push(value), error => errors.push(error));
  const guest = new RelayWire(ws, pair, 'guest', 'session1', value => messages.push(value), error => errors.push(error));
  await host.send({ secret: 'hello' });
  guest.accept(frames[0]); assert.deepEqual(messages, [{ secret: 'hello' }]);
  guest.accept(frames[0]); assert.match(errors.pop().message, /replayed/);
  host.accept(frames[0]); assert.ok(errors.pop());
  const receiver = new RelayWire(ws, pair, 'guest', 'session1', () => assert.fail('tampering accepted'), error => errors.push(error));
  receiver.accept({ ...frames[0], end: !frames[0].end }); assert.ok(errors.pop());
  receiver.accept({ ...frames[0], data: 'A'.repeat(48001) }); assert.ok(errors.pop());
  await assert.rejects(host.send({ data: 'x'.repeat(16 * 1024 * 1024) }), /16 MiB/);
  host.close(); guest.close(); receiver.close();
});

test('explicit FRP address preserves the domain Host while connecting without DNS', { timeout: 10000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const port = server.http.address().port;
  const headers = [];
  server.http.on('upgrade', req => headers.push(req.headers.host));
  const pair = { ...createPair(`ws://nonexistent.invalid:${port}`, true), mode: 'relay', signalingAddress: '127.0.0.1' };
  const dispatch = async (_method, value) => value;
  const host = new Peer({ pair, role: 'host', dispatch });
  const guest = new Peer({ pair, role: 'guest', dispatch });
  t.after(async () => { await host.close(); await guest.close(); await server.close(); });
  await Promise.all([host.ready, guest.ready]);
  assert.deepEqual(headers, [`nonexistent.invalid:${port}`, `nonexistent.invalid:${port}`]);
  assert.equal(await host.request('echo', 'domain identity retained'), 'domain identity retained');
});

test('auto mode still connects when UDP/WebRTC setup throws before producing an offer', { timeout: 10000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const pair = createPair(`ws://127.0.0.1:${server.http.address().port}`);
  const dispatch = async (_method, value) => value;
  const host = new Peer({ pair, role: 'host', dispatch });
  host.pc.createOffer = async () => { throw new Error('UDP is unavailable'); };
  const guest = new Peer({ pair, role: 'guest', dispatch });
  t.after(async () => { await host.close(); await guest.close(); await server.close(); });
  await Promise.all([host.ready, guest.ready]);
  assert.match(host.status().transport, /relay/);
  assert.equal(host.status().diagnostics.webrtcError, 'UDP is unavailable');
  assert.equal(await guest.request('echo', 'UDP not required'), 'UDP not required');
});
