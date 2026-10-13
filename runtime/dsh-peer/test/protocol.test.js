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
