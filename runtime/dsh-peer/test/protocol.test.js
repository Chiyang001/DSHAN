import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPair, generateShortCode, isShortCode, lookupShortPair, registerShortPair, resolvePair, SHORT_CODE_RE } from '../protocol.js';
import { createSignalServer } from '../signal-server.js';

test('short pairing codes are eight unambiguous characters', () => {
  const code = generateShortCode();
  assert.match(code, SHORT_CODE_RE);
  assert.equal(code.length, 8);
  assert.equal(isShortCode(code), true);
  assert.equal(isShortCode('dsh-peer:abc'), false);
});

test('short pair registration and lookup round-trip through signaling HTTP', { timeout: 10000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  t.after(async () => { await server.close(); });
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const pair = createPair(url, true);
  const code = await registerShortPair(pair, AbortSignal.timeout(5000));
  const resolved = await lookupShortPair(code, url, true, AbortSignal.timeout(5000));
  assert.equal(resolved.room, pair.room);
  assert.equal(resolved.secret, pair.secret);
  assert.equal((await resolvePair(code, { signalingUrl: url, allowHttp: true, signal: AbortSignal.timeout(5000) })).room, pair.room);
});

test('HTTP pairing uses the configured IP while retaining the domain Host', { timeout: 10000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  t.after(() => server.close());
  const url = `ws://nonexistent.invalid:${server.http.address().port}`;
  const hosts = [];
  server.http.on('request', req => {
    hosts.push(req.headers.host);
    if (req.method === 'PUT') {
      assert.equal(Number(req.headers['content-length']), Buffer.byteLength(JSON.stringify(pair)));
      assert.equal(req.headers['transfer-encoding'], undefined);
    }
  });
  const pair = { ...createPair(url, true), signalingAddress: '127.0.0.1' };
  const code = await registerShortPair(pair, AbortSignal.timeout(5000));
  const resolved = await resolvePair(code, { signalingUrl: url, signalingAddress: '127.0.0.1', signal: AbortSignal.timeout(5000) });
  assert.equal(resolved.room, pair.room);
  assert.equal(resolved.secret, pair.secret);
  assert.deepEqual(hosts, Array(2).fill(`nonexistent.invalid:${server.http.address().port}`));
});

test('pair registration failures include the server HTTP status', async t => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(503); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pair = createPair(`ws://127.0.0.1:${server.address().port}`);
  await assert.rejects(registerShortPair(pair, AbortSignal.timeout(3000)), /HTTP 503/);
});

test('request deadline is reported as timeout instead of numeric DOM exception code', async t => {
  const { createServer } = await import('node:http');
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const pair = createPair(`ws://127.0.0.1:${server.address().port}`);
  await assert.rejects(registerShortPair(pair, AbortSignal.timeout(50)), /请求超时/);
});
