import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { KernelUpdater } from './kernel-updater.js'

test('version checks use mirror latest and never downgrade a newer installed version', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-updater-test-'))
  let version = '999.0.0-test.1'
  let requested
  const updater = new KernelUpdater({ home, fetcher: async (url) => {
    requested = url
    return { ok: true, json: async () => ({ name: '@deepseek-ai/dsh', version }) }
  } })
  try {
    let status = await updater.check()
    assert.equal(requested, 'https://registry.npmmirror.com/@deepseek-ai%2Fdsh/latest')
    assert.equal(status.available, true)
    version = '0.1.0'
    status = await updater.check()
    assert.equal(status.available, false)
    await assert.rejects(updater.start(), /先检查更新/)
    version = 'invalid-version'
    status = await updater.check()
    assert.equal(status.phase, 'failed')
    assert.match(status.error, /无效版本/)
  } finally { await updater.flush(); await rm(home, { recursive: true, force: true }) }
})

test('installation is isolated, exposes progress, blocks concurrent work and can cancel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-updater-test-'))
  const fakeWorker = new EventEmitter()
  let workerData
  fakeWorker.terminate = async () => { fakeWorker.emit('exit', 1) }
  const options = { home, fetcher: async () => ({ ok: true, json: async () => ({ name: '@deepseek-ai/dsh', version: '999.0.0-test.1' }) }), workerFactory: (data) => { workerData = data; return fakeWorker } }
  const updater = new KernelUpdater(options)
  try {
    await updater.check()
    const start = await updater.start()
    assert.equal(start.phase, 'resolve')
    assert.ok(workerData.stage.startsWith(join(home, 'kernels')))
    assert.notEqual(workerData.stage, updater.runtime)
    await assert.rejects(updater.start(), /已有更新/)
    await assert.rejects(updater.check(), /进行中/)
    await assert.rejects(updater.restart(), /尚未完成/)
    fakeWorker.emit('message', { phase: 'install', installed: 3, total: 10, package: 'example', log: '安装 example' })
    assert.equal(updater.snapshot().installed, 3)
    const cancelled = await updater.cancel()
    assert.equal(cancelled.phase, 'cancelled')
    assert.equal(updater.snapshot().currentVersion, start.currentVersion)
    const persisted = JSON.parse(await readFile(join(home, 'kernel-update.json'), 'utf8'))
    assert.equal(persisted.phase, 'cancelled')
    const restored = new KernelUpdater(options)
    await restored.initialized
    assert.equal(restored.snapshot().phase, 'cancelled')
    await restored.flush()
  } finally { await updater.flush(); await rm(home, { recursive: true, force: true }) }
})

test('channel selection uses official tags, persists and installs the checked Alpha version', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-updater-channel-'))
  const requested = []
  let workerData
  const fakeWorker = new EventEmitter()
  fakeWorker.terminate = async () => {}
  const options = { home, fetcher: async (url) => {
    requested.push(url)
    return { ok: true, json: async () => ({ name: '@deepseek-ai/dsh', version: url.endsWith('/alpha') ? '999.0.0-alpha.3' : '998.0.0' }) }
  }, workerFactory: (data) => { workerData = data; return fakeWorker } }
  const updater = new KernelUpdater(options)
  let restored
  try {
    const stable = await updater.check()
    assert.equal(stable.channel, 'latest')
    assert.equal(stable.latestVersion, '998.0.0')
    const alpha = await updater.check('alpha')
    assert.equal(alpha.channel, 'alpha')
    assert.equal(alpha.latestVersion, '999.0.0-alpha.3')
    restored = new KernelUpdater(options)
    await restored.initialized
    assert.equal(restored.snapshot().channel, 'alpha')
    await restored.check()
    assert.deepEqual(requested.map((url) => url.split('/').at(-1)), ['latest', 'alpha', 'alpha'])
    await restored.start()
    assert.equal(workerData.version, '999.0.0-alpha.3')
    await assert.rejects(restored.check('latest'), /进行中/)
    assert.equal(restored.snapshot().channel, 'alpha')
    fakeWorker.emit('message', { phase: 'ready' })
    await assert.rejects(restored.check('latest'), /重启启用/)
    assert.equal(restored.snapshot().latestVersion, workerData.version)
    fakeWorker.emit('exit', 0)
  } finally {
    await updater.flush()
    if (restored) await restored.flush()
    await rm(home, { recursive: true, force: true })
  }
})

test('failed channel checks cannot install a result from the previous channel or fall back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-updater-channel-'))
  const requested = []
  const updater = new KernelUpdater({ home, fetcher: async (url) => {
    requested.push(url)
    return url.endsWith('/alpha') ? { ok: false, status: 404 } : { ok: true, json: async () => ({ name: '@deepseek-ai/dsh', version: '999.0.0' }) }
  } })
  try {
    await updater.check('latest')
    for (const channel of ['next', '../latest', 'toString', ['alpha'], {}, null, 1]) {
      await assert.rejects(updater.check(channel), /通道无效/)
    }
    assert.equal(requested.length, 1)
    const failed = await updater.check('alpha')
    assert.equal(failed.phase, 'failed')
    assert.equal(failed.channel, 'alpha')
    assert.equal(failed.latestVersion, '')
    assert.equal(failed.available, false)
    assert.equal(failed.checkedAt, null)
    assert.match(failed.error, /404/)
    await assert.rejects(updater.start(), /先检查更新/)
    assert.equal(requested.length, 2)
    assert.equal((await updater.check('latest')).available, true)
  } finally { await updater.flush(); await rm(home, { recursive: true, force: true }) }
})

test('older update records default to latest and Alpha checks keep downgrade and Node guards', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-updater-channel-'))
  await writeFile(join(home, 'kernel-update.json'), JSON.stringify({ phase: 'idle' }))
  let metadata = { name: '@deepseek-ai/dsh', version: '0.0.1-alpha.1' }
  const updater = new KernelUpdater({ home, fetcher: async () => ({ ok: true, json: async () => metadata }) })
  try {
    await updater.initialized
    assert.equal(updater.snapshot().channel, 'latest')
    const older = await updater.check('alpha')
    assert.equal(older.available, false)
    await assert.rejects(updater.start(), /先检查更新/)
    metadata = { name: '@deepseek-ai/dsh', version: '999.0.0-alpha.1', engines: { node: '>=999.0.0' } }
    const incompatible = await updater.check('alpha')
    assert.equal(incompatible.available, true)
    assert.equal(incompatible.compatible, false)
    await assert.rejects(updater.start(), /兼容/)
  } finally { await updater.flush(); await rm(home, { recursive: true, force: true }) }
})
