window.__ModuleLoader__.load({
  id: 'dsh-peer',
  factory: (require) => {
    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const CODE_LENGTH = 8
    const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/

    function parseCode(value) {
      const raw = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
      return CODE_RE.test(raw) ? raw : ''
    }

    function CodeBoxes({ value, onChange, disabled, readOnly = false, autoFocus = false }) {
      const refs = React.useRef([])
      const digits = React.useMemo(() => {
        const chars = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH)
        return Array.from({ length: CODE_LENGTH }, (_, index) => chars[index] || '')
      }, [value])
      const boxStyle = {
        boxSizing: 'border-box',
        width: 40,
        height: 48,
        textAlign: 'center',
        fontSize: 20,
        fontWeight: 600,
        letterSpacing: '0.04em',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-general, #ddd)',
        background: readOnly ? 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08))' : 'var(--dsw-alias-bg-layer-2, #fff)',
        color: 'var(--dsw-alias-label-primary, #222)',
        font: 'inherit',
      }
      function commit(nextDigits) {
        onChange(nextDigits.join('').slice(0, CODE_LENGTH))
      }
      function handleInput(index, event) {
        const char = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-1)
        const next = [...digits]
        next[index] = char
        commit(next)
        if (char && index < CODE_LENGTH - 1) refs.current[index + 1]?.focus()
      }
      function handleKeyDown(index, event) {
        if (event.key === 'Backspace' && !digits[index] && index > 0) {
          refs.current[index - 1]?.focus()
          return
        }
        if (event.key === 'ArrowLeft' && index > 0) refs.current[index - 1]?.focus()
        if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) refs.current[index + 1]?.focus()
      }
      function handlePaste(event) {
        event.preventDefault()
        const pasted = parseCode(event.clipboardData.getData('text'))
        if (!pasted) return
        onChange(pasted)
        refs.current[Math.min(pasted.length, CODE_LENGTH - 1)]?.focus()
      }
      return h('div', {
        role: 'group',
        'aria-label': readOnly ? '配对码' : '输入配对码',
        onPaste: readOnly ? undefined : handlePaste,
        style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 },
      }, digits.map((digit, index) => h('input', {
        key: index,
        ref: node => { refs.current[index] = node },
        type: 'text',
        inputMode: 'text',
        autoCapitalize: 'characters',
        autoCorrect: 'off',
        spellCheck: false,
        maxLength: 1,
        value: digit,
        readOnly,
        disabled,
        autoFocus: autoFocus && index === 0,
        'aria-label': `配对码第 ${index + 1} 位`,
        onChange: event => handleInput(index, event),
        onKeyDown: event => handleKeyDown(index, event),
        style: boxStyle,
      })))
    }

    function ConnectionSettings() {
      const [state, setState] = React.useState(null)
      const [code, setCode] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const mounted = React.useRef(false)
      const inFlight = React.useRef(false)
      const joinAttempted = React.useRef('')
      const read = React.useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
          const response = await fetch('/peer/settings')
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '无法读取连接状态')
          if (mounted.current) setState(data)
        } catch (readError) { if (mounted.current) setError(readError.message) }
        finally { inFlight.current = false }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        read()
        const timer = setInterval(read, 3000)
        const scan = event => {
          if (event.detail?.error) setError(event.detail.error)
          else if (event.detail?.code) {
            const parsed = parseCode(event.detail.code)
            if (parsed) { setCode(parsed); setError('') }
            else setError('无效配对码')
          }
        }
        window.addEventListener('dsh-peer-scan', scan)
        return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('dsh-peer-scan', scan) }
      }, [read])
      const sessions = state?.sessions || []
      const session = sessions.at(-1) || null
      const sharedTools = session?.tools?.map(tool => tool.name).join(',') || ''
      const active = state && !['disconnected', 'closed', 'error', 'failed'].includes(state.state)
      const connected = state?.state === 'connected'
      async function post(action, fields = {}) {
        if (busy) return
        setBusy(true); setError('')
        try {
          const response = await fetch('/peer/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...fields }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '连接操作失败')
          if (mounted.current) {
            setState(data)
            if (action === 'join') { setCode(''); joinAttempted.current = '' }
          }
        } catch (postError) { if (mounted.current) setError(postError.message) }
        finally { if (mounted.current) setBusy(false) }
      }
      React.useEffect(() => {
        if (!CODE_RE.test(code) || active || connected || busy || !session) return
        if (joinAttempted.current === code) return
        joinAttempted.current = code
        post('join', { code, sessionId: session.id, tools: sharedTools, allowHttp: true })
      }, [code, active, connected, busy, session, sharedTools])
      const text = (title, description) => h('div', null, h('div', { className: 'Pt1bsG_title' }, title), h('div', { className: 'Pt1bsG_description' }, description))
      const row = (title, description, control) => h('div', { className: 'Pt1bsG_row' }, text(title, description), control)
      const names = { android_status: '设备状态', android_screenshot: '截图', android_screen: '读取屏幕内容', android_tap: '点击屏幕', android_swipe: '滑动屏幕', android_text: '输入文字', android_key: '按键', android_launch_app: '打开应用', android_shell: '执行 shell 命令（高级）', android_displays: '查看显示屏', android_virtual_display: '管理虚拟副屏', android_select_display: '选择显示屏', android_ui: '读取界面结构', android_tap_element: '点击界面元素', android_tap_cell: '按网格点击', android_scroll: '滚动页面', android_find_files: '查找手机文件', android_search_text: '搜索手机文件内容', read: '读取文件', write: '写入文件', edit: '编辑文件', glob: '查找文件', grep: '搜索文件内容', read_image: '查看图片' }
      const hosting = Boolean(state?.hosting && state?.shortCode)
      const isAndroid = Boolean(window.DSHAndroid?.scanPeerQr)
      return h('div', null,
        row('电脑连接', connected ? '已连接电脑，可在任意会话中调用对方共享的工具。' : active ? '正在连接电脑，请保持两端在线…' : hosting ? '等待手机输入配对码并连接…' : '在电脑端创建配对码，或在下方输入电脑显示的 8 位配对码。',
          active && h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => post('disconnect') }, '断开连接')),
        (error || state?.error) && h('div', { className: 'Pt1bsG_row', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #d43b3b)', overflowWrap: 'anywhere' } }, error || state.error),
        connected && row('连接方式', state.transport?.includes('relay') ? '加密中继连接' : 'P2P 直接连接', h('span', { className: 'Pt1bsG_description' }, '已加密')),
        connected && row('连接会话', sessions.find(item => item.id === state.sessionId)?.label || '当前会话', null),
        !active && !connected && h(React.Fragment, null,
          row('创建配对', '在本机生成 8 位配对码，供手机扫码或输入后自动连接。全部工具默认可被对方调用。',
            h(Button, { variant: 'outline', size: 'sm', disabled: busy || !session, onClick: () => post('host', { sessionId: session?.id, tools: sharedTools, allowHttp: true }) }, hosting ? '重新生成配对码' : '创建配对码')),
          hosting && h('div', { className: 'Pt1bsG_row', style: { display: 'block' } }, text('本机配对码', '将此 8 位码展示给手机，或让对方扫描下方二维码。'),
            h(CodeBoxes, { value: state.shortCode, readOnly: true, disabled: true }),
            state.qrDataUrl && h('img', { src: state.qrDataUrl, alt: '配对二维码', style: { display: 'block', width: 220, marginTop: 12, borderRadius: 8 } })),
          isAndroid && row('扫描二维码', '扫描电脑显示的配对二维码，识别后自动连接。', h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => window.DSHAndroid.scanPeerQr() }, '扫码配对')),
          h('div', { className: 'Pt1bsG_row', style: { display: 'block' } }, text('输入配对码', '输入电脑显示的 8 位配对码，输满后自动连接。'),
            h(CodeBoxes, { value: code, disabled: busy, autoFocus: !isAndroid, onChange: setCode }),
            busy && h('div', { className: 'Pt1bsG_description', role: 'status', style: { marginTop: 8 } }, '正在连接…')),
          !session && h('div', { className: 'Pt1bsG_row', role: 'status', style: { color: 'var(--dsw-alias-state-error-primary, #d43b3b)' } }, '请先打开一个会话')),
        connected && row('已共享的工具', state.sharedTools?.map(name => names[name] || name).join('、') || '全部可用工具', null))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'connection', order: 35, label: () => '连接',
        }, ConnectionSettings))
      },
    }
  },
})
