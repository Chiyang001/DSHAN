import { homedir } from 'node:os';

export function linkedDeviceContext(linked, peer, agent) {
  const id = agent?.session?.id ?? agent?.id;
  const chat = Object.values(linked.data?.chats ?? {}).find(c => !c.removed && c.owner === linked.data.deviceId && c.sessionId === id);
  if (!chat) return '';
  const local = linked.label.includes('Android') ? 'Android 手机' : '电脑';
  const remote = linked.remoteLabel?.includes('Android') ? 'Android 手机' : '电脑';
  const connected = peer?.state === 'connected' && chat.members.includes(linked.remoteId);
  return `当前是用户主动选择的联动消息会话，本机执行端是${local}。` + (connected
    ? `另一端${remote}已经配对并连接，无需再次生成配对码。用户要求查看或操作另一端的文件、桌面、设备信息或执行命令时，应调用 peer_status 检查实时状态，再调用 peer_tools 获取另一端工具及参数，用 peer_call 执行相应的原生截图、文件或命令工具。不要把本机工具当成另一端工具，也不要未经工具检查就声称未连接或无法访问。查看屏幕必须实际取得截图，读取文件或执行命令必须使用工具结果。联动会话已自动准备两端工具环境，不需要用户另选工作区或打开普通会话。工具超时后不要自动重发可能有副作用的命令，应先核对执行结果。`
    : '另一端当前离线或身份尚未确认。可调用 peer_status 查看状态，恢复连接后再获取和调用对端工具，不得声称已读取另一端的信息。');
}

export async function enableAndroidLinkedControl(fetcher = fetch, token = process.env.DSH_ANDROID_BRIDGE_TOKEN) {
  if (!token) return;
  const response = await fetcher('http://127.0.0.1:3981/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify({ method: 'updateAndroidSettings', controlEnabled: true, shellEnabled: true }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? '无法准备手机联动控制权限');
}

// Applies only to deliberately linked conversations and their paired-device
// tool contexts. Ordinary conversations keep their own presets and permissions.
export function installLinkedAccess(ctx, linked, android = !!process.env.DSH_ANDROID_BRIDGE_TOKEN) {
  const defaults = () => ({ cwd: android ? '/storage/emulated/0' : homedir(), ...(android ? { agentPreset: 'android' } : {}) });
  const preparing = new Map();
  let androidReady;
  const prepare = async id => {
    if (preparing.has(id)) return preparing.get(id);
    const task = (async () => {
      const sessions = ctx.get('sessions'), permissions = ctx.get('permissionPresets'), controller = ctx.get('sessionController');
      if (!sessions || !permissions || !controller) throw Error('联动执行环境尚未就绪，请稍后重试');
      let session = sessions.get(id);
      if (!session) {
        const inspection = await controller.inspect(id, AbortSignal.timeout(15000));
        await controller.create({ sessionId: id, ...(inspection.meta?.cwd ? { cwd: inspection.meta.cwd } : {}) });
        session = sessions.get(id);
      }
      if (!session) throw Error('联动会话未能恢复执行环境');
      permissions.set(session, 'danger-full-access');
      if (android) {
        androidReady ??= enableAndroidLinkedControl().catch(error => { androidReady = undefined; throw error; });
        await androidReady;
      }
      return ctx.get('agents')?.get(id);
    })();
    preparing.set(id, task);
    try { return await task; } finally { preparing.delete(id); }
  };
  linked.createDefaults = defaults;
  linked.prepareSession = prepare;
  linked.toolContext = async chat => {
    let id = chat.owner === linked.data.deviceId ? chat.sessionId : 'peer-toolhost-' + chat.id;
    if (!ctx.get('agents')?.get(id)) {
      if (chat.owner !== linked.data.deviceId) await ctx.get('sessionController').create({ sessionId: id, ...defaults() });
    }
    const agent = await prepare(id);
    if (!agent) throw Error('本机联动工具环境尚未就绪');
    return agent;
  };
  return () => { preparing.clear(); };
}
