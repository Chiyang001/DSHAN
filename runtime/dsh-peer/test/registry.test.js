import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { apply } from '../index.js';

test('real Harness registry accepts plugin schemas, scoped tools, result rendering and permission guards', async () => {
  const ctx = new Context();
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx);
  const agent = { id: 'registry-test' };
  const scope = createScope(ctx, agent);
  ctx.agents = { get: id => id === agent.id ? agent : undefined };
  apply(ctx);
  let invoked = false;
  scope.ctx.tools.register(defineTool({ name: 'local_test', description: 'test scoped native tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { invoked = true; return 'done'; },
  }));
  assert.equal(ctx.tools.schemas().some(item => item.name === 'local_test'), false);
  assert.equal(ctx.tools.schemas(agent).some(item => item.name === 'local_test'), true);
  assert.equal(ctx.tools.schemas(agent).filter(item => item.name.startsWith('peer_')).length, 6);
  const signal = new AbortController().signal;
  const status = await ctx.tools.execute({ callId: 'status', name: 'peer_status', arguments: {}, agent, signal });
  assert.equal(status.isError, false); assert.match(status.content[0].text, /disconnected/);
  const removeGuard = ctx.tools.guard(exec => exec.name === 'local_test' ? 'permission denied' : undefined);
  const denied = await ctx.tools.execute({ callId: 'denied', name: 'local_test', arguments: {}, agent, signal });
  assert.equal(denied.isError, true); assert.equal(invoked, false);
  removeGuard();
  const result = await ctx.tools.execute({ callId: 'allowed', name: 'local_test', arguments: {}, agent, signal });
  assert.equal(result.isError, false); assert.equal(result.content[0].text, 'done');
  const stop = await ctx.tools.execute({ callId: 'stop', name: 'peer_disconnect', arguments: {}, agent, signal });
  assert.equal(stop.isError, false);
  await scope.dispose();
});
