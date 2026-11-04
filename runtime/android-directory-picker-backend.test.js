import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import AndroidBrowseDirectoryPicker, { ROOTS } from './android-directory-picker-backend.js'

test('Android overlay disables the default picker and mounts the Android plugin', () => {
  const patches = parse(readFileSync(new URL('./android.patch.template.yml', import.meta.url), 'utf8'))
  const warnings = []
  const entries = applyEntryPatches([
    { id: 'agent-preset-registry', name: 'registry' },
    { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' },
    { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-auto' },
  ], patches, (...args) => warnings.push(args))
  assert.deepEqual(warnings, [])
  assert.equal(entries.find((entry) => entry.id === 'terminal-controller').config.shell.path, '/system/bin/sh')
  assert.equal(entries.find((entry) => entry.id === 'directory-picker').disabled, true)
  assert.equal(entries.find((entry) => entry.id === 'directory-picker-android').name, '__DIRECTORY_PICKER_PATH__')
})

test('Android storage stays discoverable and navigation returns to storage locations', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.DSH_ANDROID_BRIDGE_TOKEN
  const originalRoot = process.env.DSH_ANDROID_STORAGE_ROOT
  process.env.DSH_ANDROID_BRIDGE_TOKEN = 'test-token'
  process.env.DSH_ANDROID_STORAGE_ROOT = '/storage/emulated/0'
  let denied = true
  globalThis.fetch = async (_url, options) => {
    const { path } = JSON.parse(options.body)
    if (path.startsWith('/storage') && denied) {
      return { ok: false, json: async () => ({ error: '需要授予“所有文件访问”权限才能浏览内部存储' }) }
    }
    return { ok: true, json: async () => ({ path, entries: [{ name: 'Download', path: `${path}/Download` }] }) }
  }
  const picker = Object.create(AndroidBrowseDirectoryPicker.prototype)
  const baseList = async (path) => ({ path, home: homedir(), crumbs: [{ name: '应用数据', path: homedir() }], entries: [] })
  try {
    for (const path of [undefined, '', ROOTS, `${ROOTS}/`, '/', '//']) {
      const roots = await picker.androidList(path, undefined, baseList)
      assert.equal(roots.path, ROOTS)
      assert.ok(roots.entries.some((entry) => entry.path === '/storage/emulated/0'))
    }
    await assert.rejects(picker.androidList('/storage/emulated/0', undefined, baseList), /所有文件访问/)
    denied = false
    const storage = await picker.androidList('/storage/emulated/0/Download', undefined, baseList)
    assert.equal(storage.home, ROOTS)
    assert.deepEqual(storage.crumbs.map((crumb) => crumb.path), [ROOTS, '/storage/emulated/0', '/storage/emulated/0/Download'])
    const home = await picker.androidList(homedir(), undefined, baseList)
    assert.equal(home.home, ROOTS)
    assert.equal(home.crumbs[0].path, ROOTS)
    assert.equal(home.crumbs[1].path, homedir())
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.DSH_ANDROID_BRIDGE_TOKEN
    else process.env.DSH_ANDROID_BRIDGE_TOKEN = originalToken
    if (originalRoot === undefined) delete process.env.DSH_ANDROID_STORAGE_ROOT
    else process.env.DSH_ANDROID_STORAGE_ROOT = originalRoot
  }
})

test('creating a folder at storage locations reports how to select a real parent', async () => {
  const picker = Object.create(AndroidBrowseDirectoryPicker.prototype)
  for (const path of [undefined, '', ROOTS, `${ROOTS}/`, '/', '//']) {
    await assert.rejects(picker.createDirectory(path, 'test'), (error) => {
      assert.equal(error.code, 'directory-create-failed')
      assert.match(error.message, /请先选择内部存储或应用数据/)
      return true
    })
  }
})
