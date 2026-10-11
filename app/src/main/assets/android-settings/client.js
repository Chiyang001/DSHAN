window.__ModuleLoader__.load({
  id: 'dsh-android-settings',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { Button, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    function KernelUpdateAction() {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [requesting, setRequesting] = React.useState(false)
      const active = React.useRef(true)
      const scroll = React.useRef(null)
      const phases = { idle: '尚未检查', checking: '检查最新版本', checked: '版本检查完成', resolve: '解析依赖', install: '下载、校验和安装', verify: '验证安装结果', ready: '安装完成，等待启用', restarting: '正在重启应用', complete: '更新已完成', cancelled: '已取消', failed: '操作失败' }
      const read = React.useCallback(async () => {
        const response = await fetch('/android/kernel-update')
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || '读取更新状态失败')
        if (active.current) setState(data)
        return data
      }, [])
      React.useEffect(() => { active.current = true; return () => { active.current = false } }, [])
      React.useEffect(() => {
        if (!open) return
        let disposed = false
        let timer
        const poll = async () => {
          try { await read() } catch (error) { if (!disposed && active.current) setError(error.message) }
          if (!disposed) timer = setTimeout(poll, 700)
        }
        poll()
        return () => { disposed = true; clearTimeout(timer) }
      }, [open, read])
      React.useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [state?.logs?.length, state?.package])
      async function action(action) {
        setRequesting(true)
        setError('')
        try {
          const response = await fetch('/android/kernel-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '更新操作失败')
          if (active.current) setState(data)
        } catch (error) { if (active.current) setError(error.message) }
        finally { if (active.current) setRequesting(false) }
      }
      async function show() {
        setOpen(true)
        setError('')
        try {
          const current = await read()
          if (!current.busy && !['ready', 'restarting'].includes(current.phase)) await action('check')
        } catch (error) { setError(error.message) }
      }
      const info = (label, value) => h('p', { style: { margin: '8px 0', overflowWrap: 'anywhere' } }, `${label}：${value || '—'}`)
      const controls = [
        h(Button, { key: 'close', variant: 'outline', size: 'sm', onClick: () => setOpen(false) }, '关闭'),
        !state?.busy && state?.phase !== 'restarting' && h(Button, { key: 'check', variant: 'outline', size: 'sm', disabled: requesting, onClick: () => action('check') }, '重新检查'),
        state?.available && state?.compatible && !state?.busy && !['ready', 'restarting'].includes(state?.phase) && h(Button, { key: 'install', variant: 'outline', size: 'sm', disabled: requesting, onClick: () => action('start') }, '下载并安装更新'),
        ['resolve', 'install', 'verify'].includes(state?.phase) && h(Button, { key: 'cancel', variant: 'outline', size: 'sm', disabled: requesting, onClick: () => action('cancel') }, '取消更新'),
        state?.phase === 'ready' && h(Button, { key: 'restart', variant: 'outline', size: 'sm', disabled: requesting, onClick: () => action('restart') }, '重启并启用'),
      ]
      return h(React.Fragment, null,
        h(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: show }, '检查更新'),
        open && createPortal(h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,.4)' } },
          h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': 'DSH 内核更新', onKeyDown: (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }, style: { boxSizing: 'border-box', width: 'min(640px, 100%)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 20, borderRadius: 14, background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)', boxShadow: '0 12px 40px #0003' } },
            h('h2', { style: { margin: '0 0 14px', fontSize: 20 } }, 'DSH 内核更新'),
            h('div', { style: { minHeight: 0, overflowY: 'auto' } },
            info('镜像站', 'https://registry.npmmirror.com'),
            info('当前版本', state?.currentVersion), info('最新版本 (latest)', state?.latestVersion),
            h('p', { role: 'status', 'aria-live': 'polite', style: { fontWeight: 600 } }, phases[state?.phase] || '读取更新状态…'),
            state?.available === false && state?.phase === 'checked' && h('p', null, '当前内核已是镜像站最新版本，或比镜像站版本更新。'),
            state?.compatible === false && h('p', { role: 'alert' }, `新版本要求 Node ${state.engines}，当前内置 Node 不兼容，暂时无法更新。`),
            state?.busy && h('progress', { 'aria-label': '更新进行中', style: { width: '100%' } }),
            state?.package && info('当前依赖', state.package),
            state?.total > 0 && info('依赖处理进度', `${state.installed} / 最多 ${state.total} 个包（不适用的可选依赖会跳过）`),
            state?.requests > 0 && info('镜像请求', `${state.requests} 次`),
            state?.startedAt && info('已用时间', `${state.elapsedSeconds} 秒`),
            (error || state?.error) && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #d43b3b)', overflowWrap: 'anywhere' } }, error || state.error),
            h('p', { className: 'Pt1bsG_description', style: { marginTop: 12 } }, '更新在独立目录下载和校验。关闭此窗口可继续使用 DSH，安装进度会保留。启用新内核需重启应用，会中断当前任务；旧内核保留，启动失败会自动回退。'),
            h('div', { ref: scroll, role: 'log', 'aria-label': '实时更新日志', style: { maxHeight: 220, overflowY: 'auto', background: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08))', borderRadius: 8, padding: 12, font: '12px/1.7 monospace', overflowWrap: 'anywhere' } },
              (state?.logs || []).map((entry, index) => h('div', { key: `${entry.time}-${index}` }, `[${new Date(entry.time).toLocaleTimeString()}] ${entry.text}`)))),
            h('div', { style: { display: 'flex', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 16 } }, controls))), document.body))
    }

    function AndroidSettings() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const mounted = React.useRef(false)
      const inFlight = React.useRef(false)
      const refresh = React.useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
          const response = await fetch('/android/settings')
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '无法读取 Android 设置')
          if (mounted.current) { setState(data); setError('') }
        } catch (error) {
          if (mounted.current) setError(error.message)
        } finally { inFlight.current = false }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        refresh()
        const timer = setInterval(refresh, 3000)
        const onFocus = () => refresh()
        window.addEventListener('focus', onFocus)
        return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('focus', onFocus) }
      }, [refresh])
      async function action(method, fields = {}) {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setError('')
        try {
          const response = await fetch('/android/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, ...fields }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '设置操作失败')
          if (mounted.current) setState(data)
        } catch (error) {
          if (mounted.current) setError(error.message)
        } finally {
          inFlight.current = false
          if (mounted.current) setBusy(false)
        }
      }
      const rowText = (title, description) => h('div', null,
        h('div', { className: 'Pt1bsG_title' }, title),
        description && h('div', { className: 'Pt1bsG_description' }, description))
      const actionRow = (title, description, buttonLabel, onClick) => h('div', { className: 'Pt1bsG_row' },
        rowText(title, description),
        h(Button, { variant: 'outline', size: 'sm', disabled: busy || !state, onClick }, buttonLabel))
      const toggleRow = (title, description, key, unavailable = false) => h('div', { className: 'Pt1bsG_row' },
        rowText(title, description),
        h(Switch, {
          checked: Boolean(state?.[key]),
          disabled: busy || !state || unavailable,
          label: title,
          onChange: (next) => action('updateAndroidSettings', { [key]: next }),
        }))
      return h('div', null,
        error && h('div', { className: 'Pt1bsG_row' },
          h('div', { className: 'Pt1bsG_description', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #d43b3b)' } }, error)),
        !state && h('div', { className: 'Pt1bsG_row' },
          h('div', { className: 'Pt1bsG_description', role: 'status' }, '正在读取 Android 设置…')),
        actionRow(
          'Shizuku 授权',
          state?.shizukuStatus || '设备操作通过 Shizuku 授权完成。',
          state?.shizukuConnected ? '重新授权' : '授权 Shizuku',
          () => action('requestShizuku'),
        ),
        actionRow(
          '无线 ADB 配对',
          (state?.adbStatus || '尚未连接') + '。无需 Shizuku：打开无线调试的配对码窗口，保持窗口打开，在 DSHAN 通知中输入六位配对码。',
          state?.adbConnected ? '重新配对' : '通知栏配对',
          () => action('requestAdbPairing'),
        ),
        actionRow(
          'Root 授权',
          state?.rootStatus || '已 Root 的手机可点击检测，并在 Root 管理器中授予权限。',
          '检测并授权 Root',
          () => action('requestRoot'),
        ),
        toggleRow(
          'Root 模式',
          '开启后设备命令优先通过 su 执行。仍需开启设备控制；任意命令另需 shell 授权。',
          'rootEnabled',
          !state?.rootAvailable && !state?.rootEnabled,
        ),
        actionRow(
          '虚拟副屏',
          (state?.virtualDisplayStatus || '尚未开启') + '。创建 720×1280 的独立副屏；AI 使用前需枚举并选择真实显示 ID。副屏截图需要 Android 14+ 和 Shizuku。',
          state?.virtualDisplayManaged ? '关闭虚拟副屏' : '创建虚拟副屏',
          () => action(state?.virtualDisplayManaged ? 'closeVirtualDisplay' : 'createVirtualDisplay'),
        ),
        toggleRow('允许 DeepSeek 管理虚拟副屏', '允许 AI 按需创建或关闭 DSHAN 副屏；还需开启设备控制。关闭此开关不会关闭当前副屏。', 'virtualDisplayAllowed'),
        actionRow('模拟辅助显示设备', '可在开发者选项中手动配置，或管理已有副屏。', '打开开发者选项', () => action('openDisplaySettings')),
        actionRow(
          '悬浮窗权限',
          state?.overlayGranted
            ? '已授予悬浮窗权限，后台执行任务时可显示任务状态。'
            : '尚未授予悬浮窗权限。可在系统设置中允许本应用显示悬浮窗。',
          state?.overlayGranted ? '管理权限' : '授予权限',
          () => action('openOverlaySettings'),
        ),
        actionRow(
          '存储访问',
          state?.granted
            ? `已授予所有文件访问权限。本机存储：${state.storageRoot}`
            : '浏览本机存储作为工作区需要授予“所有文件访问”权限。',
          state?.granted ? '管理权限' : '授予权限',
          () => action('openStorageSettings'),
        ),
        toggleRow(
          '允许 Harness 控制这台手机',
          '开启后，模型可通过手机工具执行点击、滑动、截图等操作。',
          'controlEnabled',
        ),
        toggleRow(
          '允许任意 shell 命令（高级）',
          '开启后，模型可执行任意 shell 命令；设备控制开关也需开启。',
          'shellEnabled',
        ))
    }
    function ConnectionSettings() {
      const [state, setState] = React.useState(null)
      const [code, setCode] = React.useState('')
      const [sessionId, setSessionId] = React.useState('')
      const [shared, setShared] = React.useState([])
      const [allowHttp, setAllowHttp] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const mounted = React.useRef(false)
      const inFlight = React.useRef(false)
      const read = React.useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
          const response = await fetch('/peer/settings')
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '无法读取连接状态')
          if (mounted.current) setState(data)
        } catch (error) { if (mounted.current) setError(error.message) }
        finally { inFlight.current = false }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        read()
        const timer = setInterval(read, 3000)
        const scan = event => {
          if (event.detail?.error) setError(event.detail.error)
          else if (event.detail?.code) { setCode(event.detail.code); setError('') }
        }
        window.addEventListener('dsh-peer-scan', scan)
        return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('dsh-peer-scan', scan) }
      }, [read])
      const sessions = state?.sessions || []
      const chosen = sessions.find(item => item.id === sessionId) || (!sessionId && sessions.length === 1 ? sessions[0] : null)
      const tools = chosen?.tools || []
      const active = state && !['disconnected', 'closed', 'error', 'failed'].includes(state.state)
      const connected = state?.state === 'connected'
      async function action(action) {
        if (busy) return
        setBusy(true); setError('')
        try {
          const response = await fetch('/peer/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, code: code.trim(), sessionId: chosen?.id, tools: shared.filter(name => tools.some(tool => tool.name === name)).join(','), allowHttp }) })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '连接操作失败')
          if (mounted.current) { setState(data); if (action === 'join') setCode('') }
        } catch (error) { if (mounted.current) setError(error.message) }
        finally { if (mounted.current) setBusy(false) }
      }
      const fieldStyle = { boxSizing: 'border-box', width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-general, #ddd)', background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)', font: 'inherit' }
      const text = (title, description) => h('div', null, h('div', { className: 'Pt1bsG_title' }, title), h('div', { className: 'Pt1bsG_description' }, description))
      const row = (title, description, control) => h('div', { className: 'Pt1bsG_row' }, text(title, description), control)
      const names = { android_status: '设备状态', android_screenshot: '截图', android_screen: '读取屏幕内容', android_tap: '点击屏幕', android_swipe: '滑动屏幕', android_text: '输入文字', android_key: '按键', android_launch_app: '打开应用', android_shell: '执行 shell 命令（高级）', android_displays: '查看显示屏', android_virtual_display: '管理虚拟副屏', android_select_display: '选择显示屏', android_ui: '读取界面结构', android_tap_element: '点击界面元素', android_tap_cell: '按网格点击', android_scroll: '滚动页面', android_find_files: '查找手机文件', android_search_text: '搜索手机文件内容', read: '读取文件', write: '写入文件', edit: '编辑文件', glob: '查找文件', grep: '搜索文件内容', read_image: '查看图片' }
      return h('div', null,
        row('电脑连接', connected ? '已连接电脑，可在所选会话中调用对方共享的工具。' : active ? '正在连接电脑，请保持两端在线…' : '在电脑的连接插件中生成配对二维码或配对码，再通过下方方式连接。',
          active && h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => action('disconnect') }, '断开连接')),
        (error || state?.error) && h('div', { className: 'Pt1bsG_row', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #d43b3b)', overflowWrap: 'anywhere' } }, error || state.error),
        connected && row('连接方式', state.transport?.includes('relay') ? '加密中继连接' : 'P2P 直接连接', h('span', { className: 'Pt1bsG_description' }, '已加密')),
        connected && row('连接会话', sessions.find(item => item.id === state.sessionId)?.label || '原连接会话', null),
        !active && h(React.Fragment, null,
          row('扫描二维码', '扫描电脑连接插件显示的配对二维码，识别后点击“配对并连接”。', h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => {
            if (window.DSHAndroid?.scanPeerQr) window.DSHAndroid.scanPeerQr()
            else setError('当前环境无法使用相机，请输入配对码。')
          } }, '扫码配对')),
          h('div', { className: 'Pt1bsG_row', style: { display: 'block' } }, text('输入配对码', '粘贴电脑生成的完整 dsh-peer: 配对码。配对码仅供本人使用。'),
            h('textarea', { 'aria-label': '电脑配对码', value: code, onChange: event => setCode(event.target.value), placeholder: 'dsh-peer:…', rows: 3, maxLength: 8192, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, disabled: busy, style: { ...fieldStyle, marginTop: 12, resize: 'vertical' } })),
          h('div', { className: 'Pt1bsG_row', style: { display: 'block' } }, text('连接会话', '连接和共享权限绑定此会话；关闭该会话会断开连接。请使用启用了原生工具的会话。'),
            h('select', { 'aria-label': '连接会话', value: chosen?.id || '', disabled: busy, onChange: event => { setSessionId(event.target.value); setShared([]) }, style: { ...fieldStyle, marginTop: 12 } },
              h('option', { value: '' }, sessions.length ? '请选择会话' : '请先打开一个 Android 模式会话'), sessions.map(item => h('option', { key: item.id, value: item.id }, item.label)))),
          row('允许 HTTP 配对服务', '仅在电脑使用自行配置的 HTTP / FRP 地址时开启。', h(Switch, { checked: allowHttp, disabled: busy, label: '允许 HTTP 配对服务', onChange: setAllowHttp })),
          h('div', { className: 'Pt1bsG_row', style: { display: 'block' } }, text('允许电脑调用的手机工具', '仅共享选中的工具；不选择时，只允许手机调用电脑工具。手机原有设备控制权限仍然生效。'),
            tools.map(tool => h('div', { key: tool.name, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 } },
              h('span', { className: 'Pt1bsG_description', title: tool.description }, names[tool.name] || tool.name), h(Switch, { checked: shared.includes(tool.name), disabled: busy, label: names[tool.name] || tool.name, onChange: enabled => setShared(old => enabled ? [...new Set([...old, tool.name])] : old.filter(name => name !== tool.name)) })))),
          row('开始配对', '电脑需保持配对会话打开。如果配对码已失效，请在电脑重新生成。', h(Button, { variant: 'outline', size: 'sm', disabled: busy || !chosen || !code.trim(), onClick: () => action('join') }, busy ? '正在配对…' : '配对并连接'))),
        connected && row('已共享的手机工具', state.sharedTools?.map(name => names[name] || name).join('、') || '未共享手机工具', null))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.action', () => ctx.slots.register({
          name: 'settings.action', id: 'android-kernel-update', order: -10,
        }, KernelUpdateAction))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'android', order: 50, label: () => 'Android 设置',
        }, AndroidSettings))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'connection', order: 51, label: () => '连接',
        }, ConnectionSettings))
      },
    }
  },
})
