(function () {
  // Keep the captured composer identity: a quote must never land in another session.
  var capturedComposer = null
  function composer() {
    return Array.from(document.querySelectorAll('[data-composer-input][contenteditable="true"]'))
      .find(function (node) { return node.getClientRects().length > 0 }) || null
  }
  window.DSHSelection = {
    capture: function () {
      capturedComposer = null
      var selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null
      var range = selection.getRangeAt(0)
      var node = range.commonAncestorContainer
      var element = node.nodeType === 1 ? node : node.parentElement
      if (!element || element.closest('input, textarea, [contenteditable], [role="dialog"]')) return null
      capturedComposer = composer()
      return capturedComposer ? selection.toString() : null
    },
    append: function (text, note) {
      var editor = composer()
      if (!editor || editor !== capturedComposer || !editor.isConnected || !text.trim()) return false
      var quote = text.replace(/\r\n?/g, '\n').split('\n').map(function (line) { return '> ' + line }).join('\n')
      var insertion = (editor.textContent ? '\n\n' : '') + quote + '\n\n' + (note ? '注释：' + note + '\n' : '')
      // Use the editor's paste handler so draft state, persistence, chips and undo
      // stay owned by Lexical; never mutate its DOM or replace existing text.
      editor.focus()
      var range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      var selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      var transfer = new DataTransfer()
      transfer.setData('text/plain', insertion)
      var event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      editor.dispatchEvent(event)
      return event.defaultPrevented
    }
  }
})()
