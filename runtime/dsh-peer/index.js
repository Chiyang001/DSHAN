import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { Peer } from './peer.js';
import { createPair, encodePair, decodePair } from './protocol.js';
import { androidHostAddresses } from './network.js';

export const name = 'dsh-peer';
export const inject = ['tools', 'agents'];

export function apply(ctx, config = {}) {
  let peer, owner, allowed = new Set(), executionQueue = Promise.resolve();
  const liveOwner = () => {
    if (!owner || ctx.agents.get(owner.id) !== owner) throw new Error('Shared session is closed. Enable sharing again in a live session.');
    return owner;
  };
  const schemas = () => {
    const agent = liveOwner();
    return ctx.tools.schemas(agent).filter(schema => allowed.has(schema.name) && !schema.name.startsWith('peer_') && ctx.tools.resolveExecution(schema.name, agent, false));
  };
  const dispatch = async (method, args, signal) => {
    if (method === 'list') return schemas();
    if (method !== 'call' || !args || typeof args.name !== 'string') throw new Error('Invalid remote tool call');
    const run = async () => {
      signal.throwIfAborted();
      const agent = liveOwner();
      if (!schemas().some(schema => schema.name === args.name)) throw new Error('Tool is not shared or not callable in this session');
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
  const stop = async () => { owner = undefined; allowed.clear(); const old = peer; peer = undefined; await old?.close(); };
  ctx.on('dispose', stop);
  ctx.on('agent/disposed', ({ agent }) => { if (agent === owner) void stop(); });
  const textOutput = { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] };
  const register = (toolName, description, parameters, execute, output = textOutput) => ctx.tools.register(defineTool({ name: toolName, description, parameters, output, execute }));
  const string = description => ({ type: 'string', required: true, description });
  const bindOwner = (exec, tools) => {
    if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) throw new Error('Open a Harness session first');
    const names = tools.split(',').map(item => item.trim()).filter(Boolean);
    if (names.some(item => item.startsWith('peer_') || item === '*' || item === 'run_code')) throw new Error('Share individual tools only. peer_* and unrestricted run_code cannot be shared.');
    owner = exec.agent; allowed = new Set(names);
    const available = new Set(schemas().map(item => item.name));
    if (names.some(item => !available.has(item))) { owner = undefined; allowed.clear(); throw new Error('Some tools are unavailable in this session. Use native tool mode and choose enabled tools.'); }
  };
  const connect = async (pair, role, exec, tools, iceServersJson) => {
    const iceServers = iceServersJson ? JSON.parse(iceServersJson) : config.iceServers ?? [];
    if (!Array.isArray(iceServers) || iceServers.length > 8) throw new Error('ICE servers must be a JSON array with at most eight entries');
    for (const server of iceServers) {
      const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || url.length > 2048 || !/^(stun|turn|turns):[^\s]+$/i.test(url))) throw new Error('Invalid ICE server URL');
      if (urls.some(url => /^turns?:/i.test(url)) && (typeof server.username !== 'string' || typeof server.credential !== 'string')) throw new Error('TURN requires username and credential');
    }
    const hostAddresses = await androidHostAddresses(exec.signal);
    await stop(); bindOwner(exec, tools);
    peer = new Peer({ pair, role, iceServers, hostAddresses, relayOnly: config.relayOnly === true, dispatch });
  };
  register('peer_host', 'Create a one-use P2P pairing code and share only the named local tools. Only run after the user requests pairing. Keep the code private; it grants remote access.', {
    server: string('Signaling server wss:// URL (ws:// loopback allowed for tests)'), tools: string('Comma-separated local tool names to share; empty string disables incoming calls'),
    ice_servers_json: { type: 'string', description: 'Optional JSON array of STUN/TURN servers with urls, username and credential; otherwise uses plugin configuration' },
  }, async (args, exec) => {
    const pair = createPair(args.server); await connect(pair, 'host', exec, args.tools, args.ice_servers_json);
    return 'Pairing code (expires in 2 minutes): ' + encodePair(pair) + '\nShared tools: ' + [...allowed].join(', ');
  });
  register('peer_join', 'Join another Harness using its private pairing code. Share only the specified local tools. Only run after the user requests pairing.', {
    code: string('Complete dsh-peer: pairing code'), tools: string('Comma-separated local tool names to share; empty string disables incoming calls'),
    ice_servers_json: { type: 'string', description: 'Optional JSON array of STUN/TURN servers; configure on both ends for cross-network access' },
  }, async (args, exec) => {
    await connect(decodePair(args.code.trim()), 'guest', exec, args.tools, args.ice_servers_json);
    return 'Connecting. Use peer_status before calling remote tools.';
  });
  register('peer_status', 'Show P2P connection status and tools shared by this device.', {}, async () => JSON.stringify({ ...(peer?.status() ?? { state: 'disconnected' }), sharedTools: [...allowed], sessionId: owner?.id ?? null }));
  register('peer_disconnect', 'Disconnect and revoke remote access to all local tools.', {}, async () => { await stop(); return 'Disconnected; sharing revoked.'; });
  const requirePeer = exec => {
    if (!peer || peer.state !== 'connected') throw new Error('Peer is not connected');
    if (exec.agent !== liveOwner()) throw new Error('Connection belongs to another local session');
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
