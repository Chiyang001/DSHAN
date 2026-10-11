const { test } = require('node:test')
const assert = require('node:assert/strict')
const dns = require('node:dns')
const { install } = require('./android-network.cjs')

test('Android DNS fallback preserves native success/errors and supports family/all/order', async () => {
  const original = dns.lookup
  const originalPromise = dns.promises.lookup
  const error = Object.assign(new Error('native DNS failed'), { code: 'ENOTFOUND' })
  let mode = 'failure', calls = 0
  dns.lookup = (_host, _options, callback) => queueMicrotask(() => mode === 'success'
    ? callback(null, '127.0.0.1', 4) : callback(error))
  install(async () => {
    calls++
    if (mode === 'bridgeFailure') throw new Error('bridge offline')
    return [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]
  })
  const lookup = options => new Promise((resolve, reject) => dns.lookup('example.test', options, (err, address, family) => err ? reject(err) : resolve({ address, family })))
  try {
    assert.deepEqual(await lookup(4), { address: '127.0.0.1', family: 4 })
    assert.deepEqual((await lookup({ all: true, order: 'ipv4first' })).address,
      [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])
    assert.deepEqual(await dns.promises.lookup('example.test', { family: 6 }), { address: '::1', family: 6 })
    assert.deepEqual(await dns.promises.lookup('example.test', { all: true, order: 'ipv4first' }),
      [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])
    const before = calls
    mode = 'success'
    assert.equal((await lookup(4)).address, '127.0.0.1')
    assert.equal(calls, before)
    mode = 'bridgeFailure'
    await assert.rejects(lookup(4), e => e === error)
    await assert.rejects(dns.promises.lookup('example.test', { family: 4 }), e => e === error)
  } finally { dns.lookup = original; dns.promises.lookup = originalPromise; require('node:module').syncBuiltinESMExports() }
})
