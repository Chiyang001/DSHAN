import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.length > 1 ? children : children[0],
  }),
  useState: () => [undefined, () => {}],
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  Fragment: 'Fragment',
}

const primitives = {
  Button: (props) => react.createElement('button', props, props.children),
  Switch: (props) => react.createElement('button', { ...props, role: 'switch' }),
}

const resolve = (specifier) => {
  if (specifier === 'react') return react
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${specifier}`)
}

/* The bundle registers itself on window, so the factory is captured once and
   every test mounts a fresh instance over it. */
const factory = (() => {
  let captured
  globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry } } }
  try {
    createRequire(import.meta.url)('./client.js')
  } finally {
    delete globalThis.window
  }
  assert.equal(captured.id, 'dsh-android-settings')
  return captured.factory
})()

function mountPlugin(overrides = {}) {
  const slots = []
  const plugin = factory(resolve)
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_ownerKey, contribute) => { contribute(); return () => {} },
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
    ...overrides,
  }
  plugin.apply(ctx)
  return { slots }
}

test('the plugin registers only Android settings sections', () => {
  const { slots } = mountPlugin()
  const names = slots.map(({ options }) => `${options.name}#${options.id}`)
  assert.deepEqual(names, [
    'settings.action#android-kernel-update',
    'settings.section#android',
  ])
})

test('the plugin asks for no service beyond slots', () => {
  /* Removing the sidebar arrows also removes their layout and locale needs; a
     stray inject entry would keep the plugin waiting on a service it no longer
     uses. */
  const plugin = factory(resolve)
  assert.deepEqual(plugin.inject, ['slots'])
})

test('no sidebar navigation affordance survives in the bundle', () => {
  assert.doesNotMatch(source, /dsh-android-nav/)
  assert.doesNotMatch(source, /sidebar\.footer\.action/)
  assert.doesNotMatch(source, /toggleSidebar/)
  assert.doesNotMatch(source, /PanelArrow|CollapseSidebarAction|ExpandSidebarAction/)
})

test('the Android settings section still renders its controls', () => {
  const { slots } = mountPlugin()
  const section = slots.find(({ options }) => options.name === 'settings.section')
  assert.equal(section.options.label(), 'Android 设置')
  const tree = section.component({})
  assert.equal(tree.type, 'div')
  const rows = tree.children.filter((child) => child && child.props?.className === 'Pt1bsG_row')
  const settingRows = rows.filter((row) => {
    const kids = Array.isArray(row.children) ? row.children : [row.children]
    const text = kids[0]
    if (!text || text.type !== 'div') return false
    const textKids = Array.isArray(text.children) ? text.children : [text.children]
    return textKids.some((node) => node?.props?.className === 'Pt1bsG_title')
  })
  /* Shizuku, storage access, and the two Harness switches. */
  assert.equal(settingRows.length, 11)
  assert.match(source, /Pt1bsG_row/)
  assert.match(source, /@deepseek-ai\/dsh-client-ui-primitives/)
  assert.doesNotMatch(source, /type: 'checkbox'/)
})

test('update dialog switches channels, displays the checked version and locks selection during installation', async () => {
  const values = []
  let cursor = 0
  let readStatus
  const hooks = {
    ...react,
    useCallback(fn) { readStatus = fn; return fn },
    useState(initial) {
      const index = cursor++
      if (!(index in values)) values[index] = initial
      return [values[index], (value) => { values[index] = value }]
    },
    useRef(initial) {
      const index = cursor++
      return values[index] ??= { current: initial }
    },
  }
  let component
  factory((name) => name === 'react' ? hooks : resolve(name)).apply({ slots: {
    inject: (_name, callback) => callback(),
    register: (options, value) => { if (options.id === 'android-kernel-update') component = value },
  } })
  const render = () => { cursor = 0; return component() }
  const nodes = (tree) => {
    if (Array.isArray(tree)) return tree.flatMap(nodes)
    if (!tree || typeof tree !== 'object') return []
    return [tree, ...nodes(tree.children)]
  }
  const button = (tree, label) => nodes(tree).find((node) => node.type === primitives.Button && node.children === label)
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const calls = []
  let pendingGet
  let status = { phase: 'idle', channel: 'latest', currentVersion: '0.2.1', busy: false }
  globalThis.document = { body: {} }
  globalThis.fetch = async (_url, options) => {
    if (!options && pendingGet) return pendingGet
    if (options) {
      const body = JSON.parse(options.body)
      calls.push(body)
      if (body.action === 'check') {
        status = { ...status, channel: body.channel ?? status.channel, phase: 'checked', available: true, compatible: true }
        status.latestVersion = status.channel === 'alpha' ? '0.2.2-alpha.3' : '0.2.1-rc.5'
      } else if (body.action === 'start') status = { ...status, phase: 'resolve', busy: true }
    }
    return { ok: true, json: async () => status }
  }
  try {
    await button(render(), '检查更新').props.onClick()
    assert.equal(button(render(), '正式版').props['aria-pressed'], true)
    const oldStatus = status
    let resolveOldRead
    pendingGet = new Promise((resolve) => { resolveOldRead = resolve })
    const oldRead = readStatus()
    pendingGet = null
    await button(render(), 'Alpha 版').props.onClick()
    resolveOldRead({ ok: true, json: async () => oldStatus })
    await oldRead
    let tree = render()
    assert.deepEqual(calls.at(-1), { action: 'check', channel: 'alpha' })
    assert.equal(button(tree, 'Alpha 版').props['aria-pressed'], true)
    assert.ok(nodes(tree).some((node) => node.children === '最新版本 (alpha)：0.2.2-alpha.3'))
    await button(tree, '重新检查').props.onClick()
    assert.deepEqual(calls.at(-1), { action: 'check', channel: 'alpha' })
    button(render(), '关闭').props.onClick()
    await button(render(), '检查更新').props.onClick()
    assert.equal(button(render(), 'Alpha 版').props['aria-pressed'], true)
    await button(render(), '正式版').props.onClick()
    assert.deepEqual(calls.at(-1), { action: 'check', channel: 'latest' })
    await button(render(), '下载并安装更新').props.onClick()
    tree = render()
    assert.equal(button(tree, 'Alpha 版').props.disabled, true)
    assert.equal(button(tree, '正式版').props.disabled, true)
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})
