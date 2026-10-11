import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidHostAddresses } from '../network.js';

test('Android uses authenticated active-network address discovery; desktop leaves OS discovery intact', async () => {
  assert.equal(await androidHostAddresses(undefined, ''), undefined);
  const addresses = await androidHostAddresses(undefined, 'test-token', async (_url, options) => {
    assert.equal(options.headers['x-bridge-token'], 'test-token');
    assert.equal(JSON.parse(options.body).method, 'peerNetworkAddresses');
    return { ok: true, json: async () => ({ addresses: ['192.168.1.2', 'invalid', '192.168.1.2', '2001:db8::1'] }) };
  });
  assert.deepEqual(addresses, ['192.168.1.2', '2001:db8::1']);
  await assert.rejects(androidHostAddresses(undefined, 'token', async () => ({ ok: true, json: async () => ({ addresses: [] }) })), /no active network/);
});
