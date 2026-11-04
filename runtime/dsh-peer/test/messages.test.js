import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LinkedMessages, visibleEvent } from '../messages.js';
import { Peer } from '../peer.js';
import { createPair } from '../protocol.js';
import { createSignalServer } from '../signal-server.js';

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Message synchronization timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function controller() {
  const sessions = new Map(), calls = [];
  let messages;
  return {
    sessions, calls, bind(value) { messages = value; },
    async create(request = {}) { const sessionId = request.sessionId ?? randomUUID(); sessions.set(sessionId, []); return { sessionId }; },
    async inspect(id) { if (!sessions.has(id)) throw new Error('Session missing'); return { meta: { id }, events: sessions.get(id) }; },
    async list() { return { items: [...sessions.keys()].map(sessionId => ({ sessionId, blank: false })) }; },
    append(id, type, data, surfaceOp) {
      const events = sessions.get(id), event = { seq: events.length, type, data, time: Date.now(), ...(surfaceOp ? { surfaceOp } : {}) };
      events.push(event); messages?.observeEvent(id, event); return event;
    },
    async prompt(request) {
      calls.push(request);
      this.append(request.sessionId, 'user/message', { message: { id: randomUUID(), role: 'user', content: request.content, source: { kind: 'user', rpcId: request.requestId } } });
      return { accepted: true };
    },
    cancel(request) { return { accepted: true, ...request }; },
    async attachment(request) { return { attachment: { attachmentId: request.attachmentId, mediaType: 'image/png' }, data: 'aW1hZ2U=' }; },
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-linked-messages-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  const server = createSignalServer({ port: 0 }); await once(server.http, 'listening');
  const pair = { ...createPair(`ws://127.0.0.1:${server.http.address().port}`), mode: 'relay' };
  const a = controller(), b = controller(); let host, guest;
  const left = new LinkedMessages({ file: join(directory, 'left.json'), controller: () => a, peer: () => host, interval: 20, label: '电脑' });
  const right = new LinkedMessages({ file: join(directory, 'right.json'), controller: () => b, peer: () => guest, interval: 20, label: 'Android 手机' });
  a.bind(left); b.bind(right);
  host = new Peer({ pair, role: 'host', dispatch: (...args) => left.dispatch(...args), reconnectDelay: 20 });
  guest = new Peer({ pair, role: 'guest', dispatch: (...args) => right.dispatch(...args), reconnectDelay: 20 });
  t.after(async () => { await Promise.all([left.dispose(), right.dispose()]); await Promise.all([host.close(), guest.close()]); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await Promise.all([host.ready, guest.ready]); left.start(); right.start();
  await until(() => left.remoteId && right.remoteId);
  return { left, right, a, b, host, guest, directory };
}

test('rapid create requests reuse one empty linked conversation; retries stay idempotent after messages and restart',async t=>{
 const {left,a,directory}=await fixture(t);let creates=0;const original=a.create.bind(a);a.create=async request=>{creates++;await new Promise(r=>setTimeout(r,10));return original(request);};
 const firstId=randomUUID();
 const results=await Promise.all(Array.from({length:30},(_,i)=>left.action({action:'create',requestId:i<10?firstId:randomUUID()})));
 assert.equal(new Set(results.map(r=>r.id)).size,1);assert.equal(creates,1);assert.equal(a.sessions.size,1);assert.match(results[0].sessionId,/^peer-owned-/);
 const id=results[0].id;
 await left.action({action:'send',id,requestId:randomUUID(),text:'This conversation is no longer empty'});
 const next=await left.action({action:'create',requestId:randomUUID()});assert.notEqual(next.id,id);assert.equal(creates,2);
 assert.equal((await left.action({action:'create',requestId:firstId})).id,id);assert.equal(creates,2);
 await left.save();const restarted=new LinkedMessages({file:join(directory,'left.json'),controller:()=>a,peer:()=>({state:'connected'})});await restarted.init();restarted.remoteId=left.remoteId;
 assert.equal((await restarted.action({action:'create',requestId:firstId})).id,id);assert.equal(creates,2);await restarted.dispose();
});

test('native journal reconciliation backfills messages when the runtime misses live callbacks',async t=>{
 const {left,right,a}=await fixture(t);const{id,sessionId}=await left.action({action:'create'});await until(()=>right.data.chats[id]);
 a.bind(undefined);
 await a.prompt({sessionId,requestId:randomUUID(),content:[{type:'text',text:'native input outside observer scope'}]});
 a.append(sessionId,'assistant/message',{message:{role:'assistant',content:[{type:'text',text:'reconciled reply'}]}});
 await until(()=>right.data.chats[id].events.some(e=>JSON.stringify(e.data).includes('reconciled reply')));
 assert.deepEqual(left.data.chats[id].events,right.data.chats[id].events);
 assert.equal(right.data.chats[id].events.filter(e=>e.type==='user/message').length,1);
});

test('remote deletion targets only the authorized owner session and tombstones survive restart and retry', async t => {
  const { left, right, a, directory } = await fixture(t);
  const shared=await a.create(), privateSession=await a.create();
  const {id}=await left.action({action:'share',sessionId:shared.sessionId});
  await until(()=>right.data.chats[id]);
  const deleted=[];left.deleteSession=async request=>{deleted.push(request);a.sessions.delete(request.sessionId);return{deleted:true};};
  right.data.outbox.pending={chatId:id,requestId:'pending',text:'must not replay',status:'uncertain'};
  await assert.rejects(right.action({action:'delete',id}),/确认/);
  const result=await right.action({action:'delete',id,confirm:true});
  assert.equal(result.deleted,true);await until(()=>left.data.chats[id].deletion?.status==='done' && right.data.chats[id].deletion?.status==='done');assert.deepEqual(deleted,[{sessionId:shared.sessionId,confirm:true}]);
  assert.ok(a.sessions.has(privateSession.sessionId));assert.equal(a.sessions.has(shared.sessionId),false);
  assert.equal(left.data.chats[id].removed,true);assert.equal(right.data.chats[id].removed,true);assert.equal(right.data.outbox.pending,undefined);
  await left.dispatch('messages.native',{deviceId:right.data.deviceId,id,method:'deleteSession',request:{sessionId:privateSession.sessionId,confirm:true}});
  assert.equal(deleted.length,1);
  await left.pump();await right.pump();assert.equal((await right.overview()).chats.length,0);
  const stored=JSON.parse(await readFile(join(directory,'right.json'),'utf8'));assert.equal(stored.chats[id].removed,true);assert.deepEqual(stored.chats[id].events,[]);
  await assert.rejects(right.action({action:'send',id,requestId:randomUUID(),text:'late'}),/找不到/);
});

test('failed physical deletion stays hidden, records an actionable error and retries without resending messages', async t=>{
  const {left,right,a}=await fixture(t);const session=await a.create();const{id}=await left.action({action:'share',sessionId:session.sessionId});await until(()=>right.data.chats[id]);
  left.deleteSession=async()=>{throw Error('storage busy');};
  await right.action({action:'delete',id,confirm:true});
  await until(()=>left.data.chats[id].deletion?.error==='storage busy');
  assert.equal(left.data.chats[id].removed,true);assert.equal(right.data.chats[id].removed,true);assert.ok(a.sessions.has(session.sessionId));
  assert.equal((await left.overview()).deletions[0].error,'storage busy');
  left.deleteSession=async request=>{a.sessions.delete(request.sessionId);};
  await left.action({action:'retry-delete',id});
  await until(()=>right.data.chats[id].deletion?.status==='done');
  assert.equal(a.sessions.has(session.sessionId),false);assert.equal(a.calls.length,0);
});

test('offline mirror deletion persists across restart, waits for the correct peer and completes once after reconnection',async t=>{
  const {left,right,a,directory}=await fixture(t);const session=await a.create();const{id}=await left.action({action:'share',sessionId:session.sessionId});await until(()=>right.data.chats[id]);
  const originalPeer=right.peer; right.peer=()=>undefined;right.disconnected();
  right.data.outbox.draft={chatId:id,requestId:'draft',text:'never send',status:'pending'};
  const result=await right.action({action:'delete',id,confirm:true});assert.equal(result.pending,true);
  assert.equal((await right.overview()).chats.length,0);assert.equal(right.data.outbox.draft,undefined);
  const restarted=new LinkedMessages({file:join(directory,'right.json'),controller:()=>controller(),peer:()=>undefined});await restarted.init();
  assert.equal(restarted.data.chats[id].removed,true);assert.equal(restarted.data.chats[id].deletion.status,'pending');await restarted.dispose();
  let calls=0;left.deleteSession=async request=>{calls++;a.sessions.delete(request.sessionId);};
  right.peer=originalPeer;right.remoteId='unrelated-device';await right.flushDeletions();assert.equal(calls,0);right.disconnected();
  await until(()=>left.data.chats[id].deletion?.status==='done' && right.data.chats[id].deletion?.status==='done');
  assert.equal(calls,1);assert.equal(a.calls.length,0);await right.pump();assert.equal((await right.overview()).chats.length,0);
});

test('owner can delete while completely offline and deleted native sessions are not admitted again',async t=>{
  const {left,right,a}=await fixture(t);const session=await a.create();const{id}=await left.action({action:'share',sessionId:session.sessionId});await until(()=>right.data.chats[id]);
  const savedPeer=left.peer;left.peer=()=>undefined;left.disconnected();
  left.deleteSession=async request=>{a.sessions.delete(request.sessionId);};
  await left.action({action:'delete',id,confirm:true});await until(()=>left.data.chats[id].deletion.status==='done');
  await assert.rejects(left.action({action:'send',id,requestId:randomUUID(),text:'late'}),/找不到/);
  left.peer=savedPeer;await until(()=>right.data.chats[id].removed);assert.equal(a.sessions.has(session.sessionId),false);
});

test('a blocked physical deletion never blocks confirmation, another deletion, or message synchronization',async t=>{
 const {left,right,a}=await fixture(t);
 const first=await a.create(), second=await a.create(), live=await a.create();
 const one=await left.action({action:'share',sessionId:first.sessionId});
 const two=await left.action({action:'share',sessionId:second.sessionId});
 const third=await left.action({action:'share',sessionId:live.sessionId});
 await until(()=>right.data.chats[third.id]);
 let release; const blocked=new Promise(resolve=>release=resolve);
 left.deleteSession=async()=>blocked;
 try {
  const result=await Promise.race([left.action({action:'delete',id:one.id,confirm:true}),new Promise((_,reject)=>setTimeout(()=>reject(Error('confirmation blocked')),500))]);
  assert.equal(result.pending,true);assert.equal(left.data.chats[one.id].removed,true);
  const other=await left.action({action:'delete',id:two.id,confirm:true});assert.equal(other.pending,true);
  const stored=JSON.parse(await readFile(join(left.file),'utf8'));assert.equal(stored.chats[two.id].removed,true);
  await left.action({action:'send',id:third.id,requestId:randomUUID(),text:'still usable'});
  await until(()=>right.data.chats[third.id].events.some(e=>JSON.stringify(e.data).includes('still usable')));
 } finally {release();await until(()=>!left.flushingDeletes);}
});

test('only selected conversations synchronize, and both endpoints continue one owner session', async t => {
  const { left, right, a, b } = await fixture(t);
  const visible = await a.create(), privateSession = await a.create();
  a.append(visible.sessionId, 'user/message', { message: { content: [{ type: 'text', text: 'history' }] } });
  a.append(visible.sessionId, 'request/header', { secret: 'provider-secret' });
  a.append(visible.sessionId, 'user/message', { message: { content: [{ type: 'text', text: 'internal runtime prompt' }], source: { kind: 'runtime-context' } } });
  a.append(privateSession.sessionId, 'user/message', { message: { content: [{ type: 'text', text: 'private conversation' }] } });
  assert.equal((await right.overview()).chats.length, 0);
  const { id } = await left.action({ action: 'share', sessionId: visible.sessionId, title: '共同讨论' });
  await until(async () => (await right.overview()).chats.length === 1);
  const initial = await right.action({ action: 'view', id });
  assert.equal(initial.events.length, 1); assert.match(JSON.stringify(initial), /history/);
  assert.doesNotMatch(JSON.stringify(initial), /provider-secret|private conversation|internal runtime prompt/);
  const one = randomUUID(), two = randomUUID();
  await left.action({ action: 'send', id, requestId: one, text: 'from desktop' });
  await right.action({ action: 'send', id, requestId: two, text: 'from phone' });
  await until(() => a.calls.length === 2 && right.data.chats[id].events.length === 3);
  assert.equal(b.calls.length, 0);
  assert.equal(a.calls[1].sessionId, visible.sessionId);
  assert.equal(new Set(a.calls.map(call => call.requestId)).size, 2);
  a.append(visible.sessionId, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'one shared reply' }] } });
  await until(() => right.data.chats[id].events.some(event => event.type === 'assistant/message'));
  assert.equal((await right.action({ action: 'view', id })).outbox.length, 0);
});

test('streaming text, tool output and durable settlement appear on the other device', async t => {
  const { left, right, a } = await fixture(t);
  const { id } = await left.action({ action: 'create' });
  await until(() => right.data.chats[id]);
  const sessionId = left.data.chats[id].sessionId;
  left.observeStream(sessionId, { type: 'start', attemptId: 'attempt' });
  left.observeStream(sessionId, { type: 'chunk', attemptId: 'attempt', chunk: { type: 'text-delta', text: 'hello ' } });
  left.observeStream(sessionId, { type: 'chunk', attemptId: 'attempt', chunk: { type: 'text-delta', text: 'phone' } });
  await until(() => right.data.chats[id].live === 'hello phone');
  a.append(sessionId, 'tool/call', { name: 'read', arguments: '{"file_path":"test.txt"}' });
  a.append(sessionId, 'tool/result', { message: { isError: false, content: [{ type: 'text', text: 'tool output' }] }, meta: { localOnly: true } });
  a.append(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'hello phone' }] } });
  await until(() => right.data.chats[id].events.length === 3 && right.data.chats[id].live === '');
  assert.doesNotMatch(JSON.stringify(right.data.chats[id]), /localOnly/);
});

test('native reply step boundaries synchronize live and older cached transcripts are backfilled without a reload',async t=>{
 const {left,right,a}=await fixture(t);const {id}=await left.action({action:'create'});await until(()=>right.data.chats[id]);
 const sessionId=left.data.chats[id].sessionId;
 a.append(sessionId,'turn/start',{turn:1});a.append(sessionId,'step/start',{turn:1,step:1});
 a.append(sessionId,'assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'visible reply'}]}},'append');
 a.append(sessionId,'step/end',{turn:1,step:1});a.append(sessionId,'turn/end',{turn:1,reason:{kind:'completed'}});
 await until(()=>right.data.chats[id].events.some(e=>e.type==='step/end'));
 assert.deepEqual(right.data.chats[id].events.map(e=>e.type),['turn/start','step/start','assistant/message','step/end','turn/end']);
 const mirror=right.data.chats[id];mirror.events=mirror.events.filter(e=>!e.type.startsWith('step/'));delete mirror.historyVersion;delete mirror.syncedVersion;
 await until(()=>mirror.historyVersion===2&&mirror.events.some(e=>e.type==='step/start'));
 assert.ok(mirror.journalEpoch>0);assert.equal(mirror.events.filter(e=>e.type==='assistant/message').length,1);
});

test('network interruption backfills history, sends an offline draft once, and preserves cached records after restart', async t => {
  const { left, right, a, b, host, guest, directory } = await fixture(t);
  const { id } = await left.action({ action: 'create' });
  await until(() => right.data.chats[id]);
  const paused = right.pump.bind(right); right.pump = async () => {};
  guest.ws.terminate();
  await until(() => guest.state === 'reconnecting');
  const requestId = randomUUID();
  await right.action({ action: 'send', id, requestId, text: 'offline draft' });
  a.append(left.data.chats[id].sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'reply while disconnected' }] } });
  await until(() => host.state === 'connected' && guest.state === 'connected');
  right.pump = paused;
  await until(() => a.calls.length === 1 && right.data.chats[id].events.length === 2);
  assert.equal(a.calls[0].requestId, requestId); assert.equal(b.calls.length, 0);
  await right.dispose();
  const reopened = new LinkedMessages({ file: join(directory, 'right.json'), controller: () => b, peer: () => undefined });
  t.after(() => reopened.dispose());
  const overview = await reopened.overview();
  assert.equal(overview.chats.length, 1); assert.equal(overview.connection, 'disconnected');
  assert.equal((await reopened.action({ action: 'view', id })).events.length, 2);
});

test('lost send acknowledgement is checked without replay; changed request content is rejected', async t => {
  const { left, right, a, guest } = await fixture(t);
  const { id } = await left.action({ action: 'create' }); await until(() => right.data.chats[id]);
  const request = guest.request.bind(guest);
  guest.request = async (method, args, signal) => {
    const result = await request(method, args, signal);
    if (method === 'messages.send') throw new Error('Acknowledgement lost');
    return result;
  };
  const requestId = randomUUID();
  await right.action({ action: 'send', id, requestId, text: 'execute only once' });
  await until(() => a.calls.length === 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(a.calls.length, 1);
  await assert.rejects(left.admit(left.data.chats[id], requestId, 'different text'), /其他内容/);
  assert.equal((await left.admit(left.data.chats[id], requestId, 'execute only once')).accepted, true);
  assert.equal(a.calls.length, 1);
});

test('other paired devices cannot read old linked chats or command private session IDs; stopping sharing removes the mirror', async t => {
  const { left, right, a } = await fixture(t);
  const { id } = await left.action({ action: 'create' }); await until(() => right.data.chats[id]);
  const privateSession = await a.create();
  await assert.rejects(left.dispatch('messages.read', { deviceId: right.data.deviceId, id: privateSession.sessionId }), /未授权/);
  const original = left.remoteId; left.remoteId = randomUUID();
  assert.deepEqual(await left.dispatch('messages.index', { deviceId: left.remoteId }), []);
  await assert.rejects(left.dispatch('messages.read', { deviceId: left.remoteId, id }), /未授权/);
  left.remoteId = original;
  await left.action({ action: 'remove', id });
  await until(async () => (await right.overview()).chats.length === 0);
  assert.ok(a.sessions.has(left.data.chats[id].sessionId));
});

test('history is paginated and credentials/system headers are excluded from synchronized events', async t => {
  const { left, right, a } = await fixture(t);
  const { sessionId } = await a.create();
  for (let index = 0; index < 220; index++) a.append(sessionId, 'user/message', { message: { content: [{ type: 'text', text: 'message ' + index }] } });
  a.append(sessionId, 'system/message', { message: { content: [{ type: 'text', text: 'private system prompt' }] } });
  const { id } = await left.action({ action: 'share', sessionId });
  await until(() => right.data.chats[id]?.events.length === 220);
  const recent = await right.action({ action: 'view', id });
  assert.equal(recent.events.length, 100); assert.equal(recent.hasMore, true);
  const earlier = await right.action({ action: 'view', id, before: recent.events[0].seq });
  assert.equal(earlier.events.length, 100); assert.ok(earlier.events.at(-1).seq < recent.events[0].seq);
  assert.equal(visibleEvent({ seq: 1, type: 'request/header', data: { apiKey: 'secret' } }), null);
  assert.doesNotMatch(await readFile(left.file, 'utf8'), /private system prompt/);
});

test('native operations stay on the selected owner and preserve attachments and request identities', async t => {
  const { left, right, a } = await fixture(t);
  const { id } = await left.action({ action: 'create' }); await until(() => right.data.chats[id]);
  const requests = [];
  a.selectModel = async request => { requests.push(request); return { selected: true }; };
  const response = await right.nativeCall(right.data.chats[id], 'selectModel', { sessionId: 'unshared-private-id', provider: 'test', model: 'shared', reasoningEffort: 'high' });
  assert.equal(response.selected, true); assert.equal(requests[0].sessionId, left.data.chats[id].sessionId);
  await assert.rejects(right.nativeCall(right.data.chats[id], 'inspect', { sessionId: 'unshared-private-id' }), /未授权/);
  const requestId = randomUUID(), content = [{ type: 'text', text: 'native composer' }, { type: 'image', mediaType: 'image/png', data: 'aQ==' }];
  await right.action({ action: 'send', id, requestId, text: 'native composer', content, mode: 'steer', clientTimeZone: 'Asia/Shanghai' });
  await until(() => a.calls.length === 1); assert.deepEqual(a.calls[0].content, content); assert.equal(a.calls[0].mode, 'steer');assert.equal(a.calls[0].clientTimeZone,'Asia/Shanghai');
  await until(() => !right.data.outbox[requestId]);
  await right.action({ action: 'send', id, requestId, text: 'native composer', content });
  await until(() => right.data.outbox[requestId]?.status === 'accepted' || !right.data.outbox[requestId]);assert.equal(a.calls.length,1);
});

test('linked tool RPCs validate exact chat membership independently of ordinary tool sharing',async t=>{
 const {left,right,a}=await fixture(t);const{id}=await left.action({action:'create'});await until(()=>right.data.chats[id]);
 const calls=[];right.executeLinkedTool=async(chat,method,args)=>{calls.push({id:chat.id,method,name:args.name});return[{name:'read'}];};
 const result=await right.dispatch('messages.tools',{deviceId:left.data.deviceId,id});assert.equal(result[0].name,'read');assert.equal(calls.length,1);
 await assert.rejects(right.dispatch('messages.tool',{deviceId:left.data.deviceId,id:'not-shared',name:'read'}),/未授权/);
 await assert.rejects(right.dispatch('messages.tools',{deviceId:'different-device',id}),/身份/);
 await left.action({action:'remove',id});await until(()=>right.data.chats[id].removed);
 await assert.rejects(right.dispatch('messages.tools',{deviceId:left.data.deviceId,id}),/未授权/);
});
