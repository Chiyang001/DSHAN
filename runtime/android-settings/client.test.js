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
