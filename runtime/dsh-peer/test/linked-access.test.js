import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installLinkedAccess, enableAndroidLinkedControl, linkedDeviceContext } from '../linked-access.js';

test('normal linked requests receive current device/tool instructions, private and deleted sessions receive none',()=>{
 const linked={label:'Android 手机',remoteLabel:'电脑',remoteId:'pc',data:{deviceId:'phone',chats:{one:{owner:'phone',sessionId:'session',members:['phone','pc']}}}};
 const agent={session:{id:'session'}};
 const connected=linkedDeviceContext(linked,{state:'connected'},agent);
 assert.match(connected,/已经配对并连接/);assert.match(connected,/peer_status/);assert.match(connected,/peer_tools/);assert.match(connected,/peer_call/);
 assert.match(linkedDeviceContext(linked,{state:'disconnected'},agent),/离线/);
 assert.equal(linkedDeviceContext(linked,{state:'connected'},{id:'private'}),'');
 linked.data.chats.one.removed=true;assert.equal(linkedDeviceContext(linked,{state:'connected'},agent),'');
});

test('linked execution uses local defaults and full permission without changing ordinary sessions', async () => {
  const session = { id: 'linked' }, privateSession = { id: 'private' }, changes = [];
  const agent = { id: 'linked', session }, services = {
    sessions: { get: id => id === 'linked' ? session : privateSession },
    agents: { get: id => id === 'linked' ? agent : undefined },
    permissionPresets: { set: (item, preset) => changes.push([item.id, preset]) }, sessionController: {},
  };
  const linked = {}; const dispose = installLinkedAccess({ get: name => services[name] }, linked, false);
  try {
    assert.ok(linked.createDefaults().cwd); assert.equal(await linked.prepareSession('linked'), agent);
    assert.deepEqual(changes, [['linked', 'danger-full-access']]);
  } finally { dispose(); }
});

test('a mirrored conversation gets an independent local tool context with the Android preset', async () => {
  const sessions = new Map(), agents = new Map(), creates = [], presets = [];
  const services = { sessions: { get: id => sessions.get(id) }, agents: { get: id => agents.get(id) },
    permissionPresets: { set: (session, preset) => presets.push([session.id,preset]) },
    sessionController: { async create(request) { creates.push(request); const session = { id: request.sessionId }; sessions.set(session.id, session); agents.set(session.id, { id: session.id, session }); } },
  };
  const linked = { data: { deviceId:'here' } }, dispose = installLinkedAccess({ get: name => services[name] }, linked, true);
  try {
    const chat = { id:'selected',owner:'other',sessionId:'remote-original' };
    const agent = await linked.toolContext(chat); await linked.toolContext(chat);
    assert.equal(agent.id,'peer-toolhost-selected');assert.equal(creates.length,1);
    assert.deepEqual(creates[0], { sessionId:'peer-toolhost-selected',cwd:'/storage/emulated/0',agentPreset:'android' });
    assert.ok(presets.every(([id,preset])=>id==='peer-toolhost-selected'&&preset==='danger-full-access'));
  } finally { dispose(); }
});

test('Android linked defaults enable app control and shell without requesting root or altering system grants', async()=>{
  const calls=[];
  await enableAndroidLinkedControl(async(url,options)=>{calls.push({url,body:JSON.parse(options.body),token:options.headers['x-bridge-token']});return{ok:true,json:async()=>({})};},'test-token');
  assert.deepEqual(calls,[{url:'http://127.0.0.1:3981/rpc',token:'test-token',body:{method:'updateAndroidSettings',controlEnabled:true,shellEnabled:true}}]);
});
