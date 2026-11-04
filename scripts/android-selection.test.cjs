const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const script = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/android-selection.js'), 'utf8')

function fixture() {
  const state = { text: '第一行\r\n第二行', editable: false, inserted: [], prevented: true }
  const editor = {
    textContent: '已有草稿', isConnected: true,
    getClientRects: () => [1], focus() {},
    dispatchEvent(event) {
      state.inserted.push(event.clipboardData.getData('text/plain'))
      event.defaultPrevented = state.prevented
    }
  }
  state.editor = editor
  const selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: {
      nodeType: 1, closest: () => state.editable ? editor : null
    } }),
    toString: () => state.text, removeAllRanges() {}, addRange() {}
  }
  const context = {
    window: { getSelection: () => selection },
    document: {
      querySelectorAll: () => state.editor ? [state.editor] : [],
      createRange: () => ({ selectNodeContents() {}, collapse() {} })
    },
    DataTransfer: class {
      setData(type, value) { this[type] = value }
      getData(type) { return this[type] }
    },
    ClipboardEvent: class {
      constructor(type, options) { Object.assign(this, options); this.defaultPrevented = false }
    }
  }
  vm.runInNewContext(script, context)
  return { state, selection, api: context.window.DSHSelection }
}

test('quote and annotation enter the editor paste path without replacing the draft', () => {
  const { state, api } = fixture()
  assert.equal(api.capture(), state.text)
  assert.equal(api.append(state.text, '检查这个说法'), true)
  assert.equal(state.inserted[0], '\n\n> 第一行\n> 第二行\n\n注释：检查这个说法\n')
  assert.equal(state.editor.textContent, '已有草稿')
})

test('selection from an input and collapsed selections do not offer quote actions', () => {
  const { state, selection, api } = fixture()
  state.editable = true
  assert.equal(api.capture(), null)
  state.editable = false
  selection.isCollapsed = true
  assert.equal(api.capture(), null)
})

test('a session switch or a removed composer refuses insertion', () => {
  const { state, api } = fixture()
  api.capture()
  const original = state.editor
  state.editor = { ...original }
  assert.equal(api.append('原文', ''), false)
  state.editor = original
  original.isConnected = false
  assert.equal(api.append('原文', ''), false)
  assert.deepEqual(state.inserted, [])
})

test('unhandled paste reports failure and empty drafts need no leading separator', () => {
  const { state, api } = fixture()
  api.capture()
  state.editor.textContent = ''
  state.prevented = false
  assert.equal(api.append('"引号" <script> & \\', ''), false)
  assert.equal(state.inserted[0], '> "引号" <script> & \\\n\n')
})
