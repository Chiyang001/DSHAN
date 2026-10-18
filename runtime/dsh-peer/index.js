import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { Peer } from './peer.js';
import { createPair, registerShortPair, resolvePair } from './protocol.js';
import { androidHostAddresses } from './network.js';
import { isIP } from 'node:net';
import QRCode from 'qrcode';

export const name = 'dsh-peer';
export const inject = ['tools', 'agents'];
export const DEFAULT_SIGNALING_SERVER = 'ws://dshanp2p.chiyang001.top/peer';

export function resolveSignalingServer(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return DEFAULT_SIGNALING_SERVER;
}

function acceptSettingsWrite(req) {
  const host = req.headers.host;
  if (!host) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null') return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function apply(ctx, config = {}) {
  let peer, allowed = new Set(), shareAll = false, executionQueue = Promise.resolve(), hostingShortCode;
  const callableTools = agent => ctx.tools.schemas(agent).filter(tool => !tool.name.startsWith('peer_') && tool.name !== 'run_code' && ctx.tools.resolveExecution(tool.name, agent, false));
  const liveAgents = () => ctx.agents.list().filter(agent => ctx.agents.get(agent.id) === agent);
  const availableTools = () => {
    const tools = new Map();
    for (const agent of liveAgents()) for (const schema of callableTools(agent)) tools.set(schema.name, { schema, agent });
    return tools;
  };
  const schemas = () => [...availableTools().values()].filter(({ schema }) => shareAll || allowed.has(schema.name)).map(({ schema }) => schema);
  const dispatch = async (method, args, signal) => {
    if (method === 'list') return schemas();
    if (method !== 'call' || !args || typeof args.name !== 'string') throw new Error('Invalid remote tool call');
    const run = async () => {
      signal.throwIfAborted();
      if (!shareAll && !allowed.has(args.name) || args.name.startsWith('peer_') || args.name === 'run_code') throw new Error('Tool is not shared');
      const agent = availableTools().get(args.name)?.agent;
      if (!agent) throw new Error('设备仍保持连接，但此工具当前不可用。请在对方设备打开启用该工具的会话后再调用。');
      const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({ callId: 'peer:' + randomUUID(), name: args.name, arguments: args.arguments, agent, signal }));
      const content = [];
      for (const block of result.content) {
        if (block.type === 'text') content.push(block);
        else if (block.type === 'image') {
          const store = ctx.get('attachments');
          if (!store) throw new Error('Image attachment store unavailable');
          const image = await store.readImage(block.attachment, signal);
          content.push({ type: 'image', mediaType: image.ref.mediaType, name: image.ref.name ?? 'remote-screen', data: Buffer.from(image.data).toString('base64') });
        } else content.push({ type: 'text', text: 'Remote output contains an unsupported attachment type.' });
      }
      return { isError: result.isError, content };
    };
    const result = executionQueue.then(run);
    executionQueue = result.catch(() => {});
    return result;
  };
  const stop = async () => {
    allowed.clear(); shareAll = false; hostingShortCode = undefined;
    const old = peer; peer = undefined; await old?.close();
  };
  ctx.on('dispose', stop);
  const textOutput = { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] };
  const register = (toolName, description, parameters, execute, output = textOutput) => ctx.tools.register(defineTool({ name: toolName, description, parameters, output, execute }));
  const string = description => ({ type: 'string', required: true, description });
  const sharingPolicy = tools => {
    if (tools === undefined) return { all: true, names: [] };
    if (typeof tools !== 'string') throw new Error('Shared tools must be a comma-separated string');
    const names = tools.split(',').map(item => item.trim()).filter(Boolean);
    if (names.some(item => item.startsWith('peer_') || item === '*' || item === 'run_code')) throw new Error('Share individual tools only. peer_* and unrestricted run_code cannot be shared.');
    const available = availableTools();
    if (names.some(name => !available.has(name))) throw new Error('Some tools are unavailable. Use native tool mode and enable the named tools.');
    return { all: false, names };
  };
  const connect = async (pair, role, exec, tools, iceServersJson) => {
    if (config.relayOnly === true && pair.mode === 'relay') throw new Error('relayOnly requires TURN; disable relayOnly to use encrypted WebSocket relay');
    const iceServers = iceServersJson ? JSON.parse(iceServersJson) : config.iceServers ?? [];
    if (!Array.isArray(iceServers) || iceServers.length > 8) throw new Error('ICE servers must be a JSON array with at most eight entries');
    for (const server of iceServers) {
      const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || url.length > 2048 || !/^(stun|turn|turns):[^\s]+$/i.test(url))) throw new Error('Invalid ICE server URL');
      if (urls.some(url => /^turns?:/i.test(url)) && (typeof server.username !== 'string' || typeof server.credential !== 'string')) throw new Error('TURN requires username and credential');
    }
    const policy = sharingPolicy(tools);
    const hostAddresses = await androidHostAddresses(exec.signal);
    await stop();
    allowed = new Set(policy.names); shareAll = policy.all;
    peer = new Peer({ pair, role, iceServers, hostAddresses, relayOnly: config.relayOnly === true, dispatch });
  };
  const status = () => ({
    ...(peer?.status() ?? { state: 'disconnected' }),
    sharedTools: peer ? schemas().map(schema => schema.name) : [],
    sharingMode: shareAll ? 'all-available' : 'allowlist',
    scope: 'device',
    hosting: Boolean(hostingShortCode),
    shortCode: hostingShortCode ?? null,
    signalingServer: resolveSignalingServer(config.signalingServer),
  });
  const resolveSignalingUrl = (input, pairServer) => resolveSignalingServer(input?.signalingUrl, config.signalingServer, pairServer);
  const startHost = async (input, exec) => {
    const server = resolveSignalingServer(input.server, config.signalingServer);
    const pair = createPair(server, input.allowHttp !== false);
    pair.mode = input.connectionMode ?? config.connectionMode ?? 'auto';
    pair.signalingAddress = input.signalingAddress ?? config.signalingAddress;
    if (pair.signalingAddress !== undefined && !isIP(pair.signalingAddress)) throw new Error('Invalid signaling address');
    if (!['auto', 'relay', 'p2p'].includes(pair.mode)) throw new Error('Invalid connection mode');
    const tools = input.tools;
    const shortCode = await registerShortPair(pair, exec?.signal ?? AbortSignal.timeout(15000));
    await connect(pair, 'host', { signal: exec?.signal ?? AbortSignal.timeout(15000) }, tools, input.iceServersJson);
    hostingShortCode = shortCode;
    const qrBuffer = await QRCode.toBuffer(shortCode, { width: 640, margin: 4, errorCorrectionLevel: 'M' });
    const store = ctx.get('attachments');
    const qr = store ? await store.saveImage({ data: qrBuffer, mediaType: 'image/png', name: 'DSH-pairing-QR.png' }) : null;
    return { shortCode, qr, qrDataUrl: 'data:image/png;base64,' + qrBuffer.toString('base64') };
  };
  // Device pairing outlives sessions. Each incoming call resolves live tools and uses their local permission pipeline.
  ctx.inject(['webServer', 'connection'], scope => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: '/peer/settings', async handler(req, res) {
      if (!scope.connection.authorizeIndex(req, res)) return;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/json; charset=utf-8');
      try {
        if (req.method === 'POST') {
          if (!acceptSettingsWrite(req)) { res.writeHead(403); res.end(JSON.stringify({ error: '请求来源无效' })); return; }
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('请求内容过长'); }
          const input = JSON.parse(body);
          if (input.action === 'disconnect') await stop();
          else if (input.action === 'host') {
            const hosted = await startHost(input);
            res.end(JSON.stringify({ ...status(), ...hosted }));
            return;
          }
          else if (input.action === 'join') {
            if (typeof input.code !== 'string') throw new Error('配对信息无效');
            const tools = input.tools;
            const signalingUrl = resolveSignalingUrl(input);
            if (!signalingUrl && !input.code.trim().startsWith('dsh-peer:')) throw new Error('未配置配对服务器');
            const pair = await resolvePair(input.code.trim(), { signalingUrl, signalingAddress: config.signalingAddress, allowHttp: input.allowHttp !== false, signal: AbortSignal.timeout(15000) });
            await connect(pair, 'guest', { signal: AbortSignal.timeout(15000) }, tools);
          } else throw new Error('未知连接操作');
        } else if (req.method !== 'GET') { res.writeHead(405); res.end('{}'); return; }
        res.end(JSON.stringify({ ...status(), availableTools: [...availableTools().keys()] }));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    } }), 'Peer connection settings');
  });
  register('peer_host', 'Create a one-use P2P pairing code and share only the named local tools. Only run after the user requests pairing. Keep the code private; it grants remote access.', {
    server: { type: 'string', description: 'Optional signaling server URL; defaults to the configured server or the DSHAN pairing service' }, tools: string('Comma-separated local tool names to share; empty string disables incoming calls'),
    ice_servers_json: { type: 'string', description: 'Optional JSON array of STUN/TURN servers with urls, username and credential; otherwise uses plugin configuration' },
    allow_http_signaling: { type: 'boolean', description: 'Explicitly allow ws:// signaling for a user-configured HTTP FRP entrance. Signaling metadata is visible; tool data stays encrypted and peer descriptions stay authenticated.' },
    connection_mode: { type: 'string', enum: ['auto', 'relay', 'p2p'], description: 'Default auto: prefer P2P and fall back to encrypted FRP relay. relay forces encrypted relay; p2p disables fallback.' },
    signaling_address: { type: 'string', description: 'Optional actual FRP server IPv4/IPv6 address supplied by the user. Keeps domain Host/TLS verification while avoiding broken or VPN fake-IP DNS.' },
  }, async (args, exec) => {
    const hosted = await startHost({
      server: args.server,
      tools: args.tools,
      iceServersJson: args.ice_servers_json,
      allowHttp: args.allow_http_signaling === true,
      connectionMode: args.connection_mode ?? config.connectionMode ?? 'auto',
      signalingAddress: args.signaling_address ?? config.signalingAddress,
    }, exec);
    const content = [{ type: 'text', text: 'Pairing code (expires in 2 minutes): ' + hosted.shortCode + '\nOn DSHAN open Settings → 连接, scan this QR or enter the 8-character code.\nShared tools: ' + schemas().map(schema => schema.name).join(', ') }];
    if (hosted.qr) content.push({ type: 'image', attachment: hosted.qr });
    return { content };
  }, { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => result.content });
  register('peer_join', 'Join another Harness using its private pairing code. Share only the specified local tools. Only run after the user requests pairing.', {
    code: string('Eight-character pairing code or legacy dsh-peer: code'), tools: string('Comma-separated local tool names to share; empty string disables incoming calls'),
    ice_servers_json: { type: 'string', description: 'Optional JSON array of STUN/TURN servers; configure on both ends for cross-network access' },
    allow_http_signaling: { type: 'boolean', description: 'Explicitly allow a user-configured HTTP FRP entrance; tool data remains encrypted' },
  }, async (args, exec) => {
    const signalingUrl = resolveSignalingUrl({}, config.signalingServer);
    const pair = await resolvePair(args.code.trim(), { signalingUrl, signalingAddress: config.signalingAddress, allowHttp: args.allow_http_signaling === true, signal: exec.signal });
    await connect(pair, 'guest', exec, args.tools, args.ice_servers_json);
    return 'Connecting. Use peer_status before calling remote tools.';
  });
  register('peer_status', 'Show P2P connection status and tools shared by this device.', {}, async () => JSON.stringify(status()));
  register('peer_disconnect', 'Disconnect and revoke remote access to all local tools.', {}, async () => { await stop(); return 'Disconnected; sharing revoked.'; });
  const requirePeer = exec => {
    if (!peer || peer.state !== 'connected') throw new Error('Peer is not connected');
    return peer;
  };
  register('peer_tools', 'List tools explicitly shared by the connected Harness, including parameter schemas.', {}, async (_args, exec) => JSON.stringify(await requirePeer(exec).request('list', {}, exec.signal)));
  register('peer_call', 'Call one explicitly shared remote Harness tool. Read peer_tools first. Use remote screenshots and snapshot IDs for phone actions. Never automatically retry after timeout/disconnection: an action may already have happened.', {
    name: string('Remote tool name'), arguments_json: string('JSON object matching the remote tool parameter schema'),
  }, async (args, exec) => {
    const argumentsValue = JSON.parse(args.arguments_json);
    if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== 'object') throw new Error('Tool arguments must be a JSON object');
    const result = await requirePeer(exec).request('call', { name: args.name, arguments: argumentsValue }, exec.signal);
    if (!result || !Array.isArray(result.content) || typeof result.isError !== 'boolean') throw new Error('Invalid remote tool result');
    const content = [];
    for (const block of result.content) {
      if (block.type === 'text') content.push({ type: 'text', text: String(block.text) });
      else if (block.type === 'image' && typeof block.data === 'string') {
        const store = ctx.get('attachments');
        if (!store) throw new Error('Local image store unavailable');
        content.push({ type: 'image', attachment: await store.saveImage({ data: Buffer.from(block.data, 'base64'), mediaType: block.mediaType, name: block.name }) });
      }
    }
    return { isError: result.isError, content };
  }, {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, result) => [{ type: 'text', text: result.isError ? 'Remote tool reported an error.' : 'Remote tool result:' }, ...result.content],
  });
}
