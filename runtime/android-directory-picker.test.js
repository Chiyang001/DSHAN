import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { patchBrowseClient } from './android-directory-picker.js'
import { ROOTS } from './android-directory-picker-backend.js'

const require = createRequire(import.meta.url)
const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-directory-picker-browse/client'), 'utf8')

const roots = {
  path: ROOTS, home: ROOTS,
  crumbs: [{ name: '存储位置', path: ROOTS }],
  entries: [{ name: '内部存储', path: '/storage/emulated/0' }, { name: '应用数据', path: '/data/user/0/app.dsh.android/no_backup' }],
  truncated: false,
}

// Render the shipped browser bundle with controlled hook state. The element
// tree and callbacks are the upstream UI's, rather than a copy of its logic.
function renderBrowser(client, parent, selected = null, { busy = false, loading = false } = {}) {
  let plugin
  const slots = new Map()
  const state = [parent, selected, null, loading]
  const opened = []
  let cursor = 0
  const element = (type, props) => ({ type, props })
  const react = {
    createElement: element,
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef: (current) => ({ current }),
    useCallback: (callback) => callback,
    useEffect() {},
  }
  vm.runInNewContext(client, {
    AbortController,
    window: { __ModuleLoader__: { load({ factory }) {
      plugin = factory((name) => {
        if (name === 'react') return react
        if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: (_, key) => key })
        throw new Error(`Unexpected browser dependency: ${name}`)
      })
    } } },
  })
  plugin.apply({
    effect() {},
    slots: {
      inject(_name, callback) {
        const result = callback()
        if (result?.[Symbol.iterator]) Array.from(result)
      },
      register({ name }, component) { slots.set(name, component) },
    },
  })
  const trees = []
  for (const flow of slots.values()) {
    cursor = 0
    const browser = flow({ open: true, busy, t: (key) => key, onPicked: (path) => opened.push(path), onCancel() {} })
    trees.push(browser.type(browser.props))
  }
  assert.equal(trees.length, 2, 'hero and sidebar directory flows both mount')
  return { trees, opened, state }
}

function find(node, predicate) {
  if (node == null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat()) {
    const found = find(child, predicate)
    if (found) return found
  }
}

const button = (tree, label) => find(tree, (node) => node.props?.children === label)

test('storage locations cannot be opened as a workspace or used as a new-folder parent', () => {
  const original = renderBrowser(source, roots)
  assert.equal(button(original.trees[0], 'browser.open').props.disabled, false, 'reproduces the upstream virtual-root bug')
  const { trees, opened } = renderBrowser(patchBrowseClient(source), roots)
  for (const tree of trees) {
    const open = button(tree, 'browser.open')
    assert.equal(open.props.disabled, true)
    assert.equal(button(tree, 'browser.newFolder').props.disabled, true)
    open.props.onClick()
  }
  assert.deepEqual(opened, [], 'even a stale Open callback cannot submit the marker')
})

test('selecting either Android storage location enables Open with its real absolute path', () => {
  for (const entry of [...roots.entries, { name: 'Download', path: '/storage/emulated/0/Download' }]) {
    const { trees, opened } = renderBrowser(patchBrowseClient(source), roots, entry)
    for (const tree of trees) {
      const open = button(tree, 'browser.open')
      assert.equal(open.props.disabled, false)
      assert.equal(button(tree, 'browser.newFolder').props.disabled, false)
      open.props.onClick()
    }
    assert.deepEqual(opened, [entry.path, entry.path])
  }
})

test('a real listed directory remains selectable without choosing a child', () => {
  const listing = { ...roots, path: '/storage/emulated/0/Download', entries: [] }
  const { trees, opened } = renderBrowser(patchBrowseClient(source), listing)
  for (const tree of trees) {
    assert.equal(button(tree, 'browser.open').props.disabled, false)
    button(tree, 'browser.open').props.onClick()
  }
  assert.deepEqual(opened, [listing.path, listing.path])
  for (const flags of [{ busy: true }, { loading: true }]) {
    const frozen = renderBrowser(patchBrowseClient(source), listing, null, flags)
    assert.equal(button(frozen.trees[0], 'browser.open').props.disabled, true)
  }
})

test('path editing on storage locations starts with an absolute path', () => {
  const { trees, state } = renderBrowser(patchBrowseClient(source), roots)
  const edit = find(trees[0], (node) => node.props?.['aria-label'] === 'browser.editPath')
  edit.props.onClick()
  assert.ok(state.includes('/'))
  assert.ok(!state.includes(`${ROOTS}/`))
})

test('the picker adapts each active kernel once and refuses an unknown bundle without a partial patch', () => {
  const patched = patchBrowseClient(source)
  assert.equal(patchBrowseClient(patched), patched)
  assert.throws(() => patchBrowseClient('unknown kernel browser'), /切回内置内核/)
  assert.equal(readFileSync(new URL('../app/src/main/assets/android-directory-picker.js', import.meta.url), 'utf8'),
    readFileSync(new URL('./android-directory-picker.js', import.meta.url), 'utf8'))
  assert.equal(readFileSync(new URL('../app/src/main/assets/android-directory-picker-backend.js', import.meta.url), 'utf8'),
    readFileSync(new URL('./android-directory-picker-backend.js', import.meta.url), 'utf8'))
})

test('a downloaded kernel is patched before its browse surface is mounted, including after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshan-directory-picker-'))
  try {
    const packageRoot = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ exports: { './client': './client.js' } }))
    const client = join(packageRoot, 'client.js')
    writeFileSync(client, source)
    const entry = join(root, 'android-directory-picker.mjs')
    writeFileSync(entry, readFileSync(new URL('./android-directory-picker.js', import.meta.url), 'utf8'))
    const { apply } = await import(pathToFileURL(entry).href)
    for (let restart = 0; restart < 2; restart++) {
      const mounted = []
      const store = {}
      let cleanup
      await apply({
        effect: async (callback) => { cleanup = await callback() },
        loader: {
          store,
          async create({ name }) {
            assert.equal(readFileSync(client, 'utf8'), patchBrowseClient(source))
            mounted.push(name)
            const id = String(mounted.length)
            store[id] = { fiber: { async await() {}, async dispose() {} } }
            return id
          },
          resolve: (id) => store[id],
          remove: (id) => { delete store[id] },
        },
      })
      assert.ok(mounted[0].endsWith('android-directory-picker-backend.js'))
      assert.equal(mounted[1], '@deepseek-ai/dsh-client-ui-directory-picker-browse')
      assert.equal(existsSync(`${client}.android.tmp`), false)
      await cleanup()
      assert.deepEqual(Object.keys(store), [])
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true })
  }
})
