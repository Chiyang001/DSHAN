import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Peer } from '../peer.js';
import { createPair } from '../protocol.js';
import { createSignalServer } from '../signal-server.js';

async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Recovery timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const mode of ['relay', 'auto', 'p2p']) test(`${mode}: repeated outages recover without pairing or replaying RPCs`, { timeout: 70000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const pair = { ...createPair(`ws://127.0.0.1:${server.http.address().port}`), mode };
  let calls = 0, aborted = false, refreshes = 0;
  const options = { pair, reconnectDelay: 30, fallbackDelay: 0,
    refreshHostAddresses: async () => { refreshes++; return undefined; },
    dispatch: async (method, value, signal) => {
      if (method === 'slow') {
        calls++;
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        aborted = true;
      }
      return value;
    } };
  const host = new Peer({ ...options, role: 'host' }), guest = new Peer({ ...options, role: 'guest' });
  t.after(async () => { await Promise.all([host.close(), guest.close()]); await server.close(); });
  await Promise.race([Promise.all([host.ready, guest.ready]), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('initial connect timed out')), 10000); timer.unref(); })]);
  const oldSession = host.current.relaySession;
  const oldEpoch = host.current.signalPair.room;
  const pending = host.request('slow', 'never replay');
  const rejected = assert.rejects(pending, /outcome may be unknown/);
  await until(() => calls === 1);
  host.ws.terminate();
  await rejected;
  await until(() => host.state === 'connected' && guest.state === 'connected');
  assert.equal(await host.request('echo', 'recovered'), 'recovered');
  assert.equal(calls, 1); assert.equal(aborted, true); assert.ok(refreshes >= 2);
  assert.notEqual(host.current.signalPair.room, oldEpoch);
  if (mode !== 'p2p') assert.notEqual(host.current.relaySession, oldSession);
  const oldSocket = guest.ws;
  guest.ws.terminate();
  await until(() => guest.ws !== oldSocket && host.state === 'connected' && guest.state === 'connected');
  assert.equal(await guest.request('echo', 'second recovery'), 'second recovery');
  await guest.close();
  await until(() => host.state === 'closed');
  const attempts = host.attempts;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(host.attempts, attempts);
  assert.equal(server.rooms.size, 0);
});

test('heartbeat detects a half-open relay connection and recovers', { timeout: 10000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const pair = { ...createPair(`ws://127.0.0.1:${server.http.address().port}`), mode: 'relay' };
  const options = { pair, reconnectDelay: 20, heartbeatInterval: 80, dispatch: async (_, value) => value };
  const host = new Peer({ ...options, role: 'host' }), guest = new Peer({ ...options, role: 'guest' });
  t.after(async () => { await Promise.all([host.close(), guest.close()]); await server.close(); });
  await Promise.race([Promise.all([host.ready, guest.ready]), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('initial connect timed out')), 10000); timer.unref(); })]);
  const socket = host.ws;
  socket.ping = () => {}; // TCP stays open, but no heartbeat response arrives.
  await until(() => host.ws !== socket && host.state === 'connected' && guest.state === 'connected');
  assert.equal(await host.request('echo', 'alive'), 'alive');
});


test('offline address refresh retries and manual disconnect cancels recovery', { timeout: 10000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const pair = { ...createPair(`ws://127.0.0.1:${server.http.address().port}`), mode: 'relay' };
  let offline = true, refreshes = 0;
  const options = { pair, reconnectDelay: 20, dispatch: async (_, value) => value };
  const host = new Peer({ ...options, role: 'host', refreshHostAddresses: async () => {
    refreshes++; if (offline) throw new Error('No active network');
  } });
  const guest = new Peer({ ...options, role: 'guest' });
  t.after(async () => { await Promise.all([host.close(), guest.close()]); await server.close(); });
  await Promise.all([host.ready, guest.ready]);
  host.ws.terminate();
  await until(() => refreshes >= 2);
  assert.equal(host.state, 'reconnecting');
  offline = false;
  await until(() => host.state === 'connected' && guest.state === 'connected');
  assert.equal(await host.request('echo', 'network restored'), 'network restored');
  offline = true; host.ws.terminate();
  await until(() => host.state === 'reconnecting');
  await host.close();
  const attempts = refreshes;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(host.state, 'closed'); assert.equal(refreshes, attempts);
});


test('manual disconnect revokes a busy peer with all RPC slots occupied', { timeout: 10000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const pair = { ...createPair(`ws://127.0.0.1:${server.http.address().port}`), mode: 'relay' };
  let running = 0;
  const options = { pair, reconnectDelay: 20, dispatch: async (_, value, signal) => {
    running++;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return value;
  } };
  const host = new Peer({ ...options, role: 'host' }), guest = new Peer({ ...options, role: 'guest' });
  t.after(async () => { await Promise.all([host.close(), guest.close()]); await server.close(); });
  await Promise.all([host.ready, guest.ready]);
  const calls = Array.from({ length: 16 }, () => assert.rejects(host.request('slow', {}), /outcome may be unknown/));
  await until(() => running === 16);
  await host.close(); await Promise.all(calls);
  await until(() => guest.state === 'closed');
  assert.equal(guest.stopped, true);
});

test('authenticated handover replaces an occupied role without waiting for stale TCP cleanup', async t => {
  const { WebSocket } = await import('ws');
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const clients=[];t.after(async()=>{for(const ws of clients)ws.terminate();await server.close();});
  const open=async(role,resume,nonce)=>{const ws=new WebSocket('ws://127.0.0.1:'+server.http.address().port+'/peer');clients.push(ws);ws.frames=[];ws.on('message',raw=>ws.frames.push(JSON.parse(raw)));await once(ws,'open');ws.send(JSON.stringify({type:'join',room:'a'.repeat(32),access:'b'.repeat(64),role,resume,nonce}));return ws;};
  const host=await open('host','c'.repeat(64),'1'.repeat(32)), guest=await open('guest','d'.repeat(64),'2'.repeat(32));await until(()=>guest.frames.some(f=>f.type==='ready'));
  const epoch=guest.frames.find(f=>f.type==='ready').epoch;
  const impostor=await open('guest','e'.repeat(64),'3'.repeat(32));await until(()=>impostor.readyState===WebSocket.CLOSED);assert.equal(host.readyState,WebSocket.OPEN);assert.equal(guest.readyState,WebSocket.OPEN);
  const replay=await open('guest','d'.repeat(64),'2'.repeat(32));await until(()=>replay.readyState===WebSocket.CLOSED);assert.equal(guest.readyState,WebSocket.OPEN);
  const replacement=await open('guest','d'.repeat(64),'3'.repeat(32));await until(()=>host.readyState===WebSocket.CLOSED&&guest.readyState===WebSocket.CLOSED);
  const host2=await open('host','c'.repeat(64),'4'.repeat(32));await until(()=>replacement.frames.some(f=>f.type==='ready'));
  const ready=replacement.frames.find(f=>f.type==='ready');assert.notEqual(ready.epoch,epoch);assert.equal(ready.nonces.guest,'3'.repeat(32));assert.equal(ready.nonces.host,'4'.repeat(32));assert.equal(host2.readyState,WebSocket.OPEN);
});
