import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { apply } from '../index.js';
import { createSignalServer } from '../signal-server.js';

function harness(id) {
  const agent = { id }, other = { id: id + '-other' };
  const tools = new Map(), events = new Map(), pipeline = [], saved = [];
  let live = agent;
  const ctx = {
    agents: { get: key => key === live?.id ? live : undefined, withInitiator: (_agent, action) => action() },
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
  };
  apply(ctx);
  const call = (name, args = {}, caller = agent) => tools.get(name).execute(args, { agent: caller, signal: new AbortController().signal });
  return { agent, other, tools, events, pipeline, saved, call, disposeAgent: async () => { live = undefined; await events.get('agent/disposed')({ agent }); } };
}
test('plugin binds sharing to a live session, enforces allowlist and executes through local permission pipeline', { timeout: 30000 }, async t => {
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const phone = harness('phone'), desktop = harness('desktop');
  t.after(async () => { await phone.call('peer_disconnect'); await desktop.call('peer_disconnect'); await server.close(); });
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  await assert.rejects(phone.call('peer_host', { server: url, tools: 'run_code' }), /individual tools/);
  await assert.rejects(phone.call('peer_host', { server: url, tools: 'hidden' }), /unavailable/);
  const output = await phone.call('peer_host', { server: url, tools: 'screen,denied' });
  const code = output.match(/dsh-peer:[A-Za-z0-9_-]+/)[0];
  await desktop.call('peer_join', { code, tools: '' });
  for (let i = 0; i < 100; i++) {
    if (JSON.parse(await desktop.call('peer_status')).state === 'connected') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(JSON.parse(await desktop.call('peer_status')).state, 'connected');
  assert.deepEqual(JSON.parse(await desktop.call('peer_tools')).map(tool => tool.name), ['screen', 'denied']);
  await assert.rejects(desktop.call('peer_tools', {}, desktop.other), /another local session/);
  await assert.rejects(desktop.call('peer_call', { name: 'hidden', arguments_json: '{}' }), /not shared/);
  assert.equal(phone.pipeline.length, 0);
  const result = await desktop.call('peer_call', { name: 'screen', arguments_json: '{}' });
  assert.equal(phone.pipeline.length, 1); assert.equal(phone.pipeline[0].agent, phone.agent);
  assert.equal(result.content[0].attachment.attachmentId, 'desktop-new');
  assert.equal(desktop.saved[0].data.toString(), 'image-bytes');
  const denied = await desktop.call('peer_call', { name: 'denied', arguments_json: '{}' });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /permission denied/);
  await phone.disposeAgent();
  assert.equal(JSON.parse(await phone.call('peer_status')).state, 'disconnected');
});
