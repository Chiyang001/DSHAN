import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { apply, DEFAULT_SIGNALING_SERVER, resolveSignalingServer } from '../index.js';
import { createSignalServer } from '../signal-server.js';
import { SHORT_CODE_RE } from '../protocol.js';

function harness(id, config = {}) {
  const agent = { id }, other = { id: id + '-other' };
  const tools = new Map(), events = new Map(), pipeline = [], saved = [];
  let live = agent;
  const ctx = {
    agents: { get: key => key === live?.id ? live : undefined, list: () => live ? [live] : [], withInitiator: (_agent, action) => action() },
    tools: {
      register: tool => tools.set(tool.name, tool),
      schemas: () => ['screen', 'denied', 'hidden', 'run_code'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
      resolveExecution: name => name !== 'hidden',
      execute: async exec => {
        pipeline.push(exec);
        if (exec.name === 'denied') return { isError: true, content: [{ type: 'text', text: 'Local permission denied' }] };
        return { isError: false, content: [{ type: 'image', attachment: { attachmentId: 'local-only', mediaType: 'image/png' } }] };
      },
    },
    get: name => name === 'attachments' ? {
      readImage: async ref => ({ ref, data: Buffer.from('image-bytes') }),
      saveImage: async input => { saved.push(input); return { attachmentId: id + '-new', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }; },
    } : undefined,
    on: (name, action) => events.set(name, action),
    inject: (_names, setup) => setup({ effect: fn => fn(), webServer: { register: route => { ctx.route = route; return () => {}; } }, connection: { authorizeIndex: (req, res) => { if (!req.authorized) { res.writeHead(401); res.end('{}'); } return req.authorized; } } }),
  };
  apply(ctx, config);
  const call = (name, args = {}, caller = agent) => tools.get(name).execute(args, { agent: caller, signal: new AbortController().signal });
  const request = async (method = 'GET', input = {}, origin = 'http://localhost:3080', authorized = true) => {
    const res = { status: 200, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await ctx.route.handler({ method, authorized, headers: { host: 'localhost:3080', origin }, async *[Symbol.asyncIterator]() { yield JSON.stringify(input); } }, res);
    return res;
  };
  return { agent, other, tools, events, pipeline, saved, call, request, addAgent: id => { live = { id }; return live; }, disposeAgent: async () => { live = undefined; await events.get('agent/disposed')?.({ agent }); } };
}

function shortCodeFromOutput(output) {
  const match = output.content[0].text.match(/\b([A-HJ-NP-Z2-9]{8})\b/);
  assert.ok(match, output.content[0].text);
  assert.match(match[1], SHORT_CODE_RE);
  return match[1];
}

test('device sharing survives session deletion while enforcing allowlist and local permissions', { timeout: 30000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const phone = harness('phone', { signalingServer: url }), desktop = harness('desktop', { signalingServer: url });
  t.after(async () => { await phone.call('peer_disconnect'); await desktop.call('peer_disconnect'); await server.close(); });
  await assert.rejects(phone.call('peer_host', { server: url, tools: 'run_code' }), /individual tools/);
  await assert.rejects(phone.call('peer_host', { server: url, tools: 'hidden' }), /unavailable/);
  const output = await phone.call('peer_host', { server: url, tools: 'screen,denied' });
  const code = shortCodeFromOutput(output);
  assert.equal(output.content[1].type, 'image');
  assert.equal(phone.saved[0].data.subarray(1, 4).toString(), 'PNG');
  await desktop.call('peer_join', { code, tools: '' });
  for (let i = 0; i < 100; i++) {
    if (JSON.parse(await desktop.call('peer_status')).state === 'connected') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(JSON.parse(await desktop.call('peer_status')).state, 'connected');
  assert.deepEqual(JSON.parse(await desktop.call('peer_tools')).map(tool => tool.name), ['screen', 'denied']);
  assert.ok(JSON.parse(await desktop.call('peer_tools', {}, desktop.other)).some(tool => tool.name === 'screen'));
  await assert.rejects(desktop.call('peer_call', { name: 'hidden', arguments_json: '{}' }), /not shared/);
  assert.equal(phone.pipeline.length, 0);
  const result = await desktop.call('peer_call', { name: 'screen', arguments_json: '{}' });
  assert.equal(phone.pipeline.length, 1); assert.equal(phone.pipeline[0].agent, phone.agent);
  assert.equal(result.content[0].attachment.attachmentId, 'desktop-new');
  assert.equal(desktop.saved[0].data.toString(), 'image-bytes');
  const denied = await desktop.call('peer_call', { name: 'denied', arguments_json: '{}' });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /permission denied/);
  await phone.disposeAgent();
  assert.equal(JSON.parse(await phone.call('peer_status')).state, 'connected');
  assert.deepEqual(JSON.parse(await desktop.call('peer_tools')), []);
  await assert.rejects(desktop.call('peer_call', { name: 'screen', arguments_json: '{}' }), /设备仍保持连接/);
  const replacement = phone.addAgent('replacement');
  const restored = await desktop.call('peer_call', { name: 'screen', arguments_json: '{}' }, desktop.other);
  assert.equal(restored.isError, false);
  assert.equal(phone.pipeline.at(-1).agent, replacement);
  assert.equal(JSON.parse(await phone.call('peer_status')).state, 'connected');
});

test('settings pairing authenticates writes and preserves session allowlist and revocation', { timeout: 30000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const phone = harness('phone-ui', { signalingServer: url }), desktop = harness('desktop-ui', { signalingServer: url });
  t.after(async () => { await phone.call('peer_disconnect'); await desktop.call('peer_disconnect'); await server.close(); });
  assert.equal((await phone.request('GET', {}, undefined, false)).status, 401);
  assert.equal((await phone.request('POST', { action: 'disconnect' }, 'https://other.example')).status, 403);
  const snapshot = JSON.parse((await phone.request()).body);
  assert.deepEqual(snapshot.availableTools, ['screen', 'denied']);
  const hosted = await desktop.call('peer_host', { server: url, tools: 'screen', connection_mode: 'relay' });
  const code = shortCodeFromOutput(hosted);
  assert.equal((await phone.request('POST', { action: 'join', code: 'bad', tools: '', sessionId: phone.agent.id })).status, 400);
  assert.equal((await phone.request('POST', { action: 'join', code, tools: 'screen,denied', sessionId: phone.agent.id })).status, 200);
  for (let i = 0; i < 100 && JSON.parse((await phone.request()).body).state !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(JSON.parse((await phone.request()).body).state, 'connected');
  assert.deepEqual(JSON.parse(await desktop.call('peer_tools')).map(tool => tool.name), ['screen', 'denied']);
  await desktop.call('peer_call', { name: 'screen', arguments_json: '{}' });
  assert.equal(phone.pipeline[0].agent, phone.agent);
  const denied = await desktop.call('peer_call', { name: 'denied', arguments_json: '{}' });
  assert.equal(denied.isError, true);
  assert.equal((await phone.request('POST', { action: 'disconnect' })).status, 200);
  assert.equal(JSON.parse((await phone.request()).body).scope, 'device');
});


test('devices pair with no sessions and restore tools without reconnecting', { timeout: 30000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const phone = harness('idle-phone', { signalingServer: url }), desktop = harness('idle-desktop', { signalingServer: url });
  t.after(async () => { await phone.call('peer_disconnect'); await desktop.call('peer_disconnect'); await server.close(); });
  await phone.disposeAgent(); await desktop.disposeAgent();
  const hosted = JSON.parse((await desktop.request('POST', { action: 'host', connectionMode: 'relay' })).body);
  assert.match(hosted.shortCode, SHORT_CODE_RE);
  assert.equal((await phone.request('POST', { action: 'join', code: hosted.shortCode })).status, 200);
  for (let i = 0; i < 100 && JSON.parse((await phone.request()).body).state !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(JSON.parse((await phone.request()).body).state, 'connected');
  assert.deepEqual(JSON.parse(await desktop.call('peer_tools')), []);
  const replacement = phone.addAgent('new-phone-session');
  assert.deepEqual(JSON.parse(await desktop.call('peer_tools')).map(tool => tool.name), ['screen', 'denied']);
  const result = await desktop.call('peer_call', { name: 'screen', arguments_json: '{}' });
  assert.equal(result.isError, false);
  assert.equal(phone.pipeline.at(-1).agent, replacement);
  await phone.disposeAgent();
  assert.equal(JSON.parse((await phone.request()).body).state, 'connected');
  assert.equal(JSON.parse((await desktop.request()).body).state, 'connected');
});


test('missing and blank profile settings use a consistent default pairing server', async () => {
  for (const value of [undefined, null, '', '   ']) {
    const device = harness('defaults', { signalingServer: value });
    assert.equal(JSON.parse((await device.request()).body).signalingServer, DEFAULT_SIGNALING_SERVER);
    assert.equal(resolveSignalingServer(value), DEFAULT_SIGNALING_SERVER);
  }
  assert.equal(resolveSignalingServer(' ', ' wss://custom.example/peer '), 'wss://custom.example/peer');
  assert.equal(resolveSignalingServer('wss://override.example/peer', 'wss://custom.example/peer'), 'wss://override.example/peer');
});

test('blank host input retains the configured server and pairing works without sessions', async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const device = harness('blank-server', { signalingServer: url });
  t.after(async () => { await device.call('peer_disconnect'); await server.close(); });
  await device.disposeAgent();
  const result = await device.request('POST', { action: 'host', server: '  ', tools: '' });
  assert.equal(result.status, 200);
  assert.match(JSON.parse(result.body).shortCode, SHORT_CODE_RE);
});
