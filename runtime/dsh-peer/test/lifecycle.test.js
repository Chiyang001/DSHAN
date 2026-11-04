import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLinkedWorkspace, installLinkedDeletion, installLinkedThemeActions } from '../lifecycle.js';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { mirrorId } from '../native-messages.js';

function fixture() {
  const chat = { id: 'shared', owner: 'there', sessionId: 'owner-session', events: [], members: ['here', 'there'] };
  const registry = { pinnedSessionIds: ['local'], archivedSessionIds: [] }, calls = [];
  const service = {};
  for (const [method, field] of [['pinSession','pinnedSessionIds'],['unpinSession','pinnedSessionIds'],['archiveSession','archivedSessionIds'],['unarchiveSession','archivedSessionIds']]) service[method] = async request => {
    calls.push([method, request]); assert.equal(request.sessionId, 'local');
    return { [field]: registry[field] };
  };
  service.follow = async function* (signal) { yield { type:'baseline',value:{items:[],...registry} }; await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})); };
  const linked = { data:{ deviceId:'here',chats:{shared:chat} }, async init(){}, async save(){}, touch(){}, async nativeCall(...args){calls.push(args);} };
  return { chat, registry, service, calls, linked, ctx:{get:name=>({workspaceController:service,workspaceRegistry:registry})[name]} };
}

test('mirror pin/archive sets persist, merge real IDs, publish live updates and survive a fresh baseline', async () => {
  const f=fixture(), previous=f.service.pinSession, dispose=installLinkedWorkspace(f.ctx,f.linked), id=mirrorId(f.chat);
  const abort=new AbortController(), feed=f.service.follow(abort.signal);
  try {
    assert.deepEqual((await feed.next()).value.value.pinnedSessionIds,['local']);
    assert.deepEqual(await f.service.pinSession({sessionId:id}),{pinnedSessionIds:['local',id]});
    assert.equal(f.calls.length,0); assert.equal(f.chat.pinned,true);
    assert.deepEqual((await feed.next()).value,{type:'pinned',pinnedSessionIds:['local',id]});
    const otherAbort=new AbortController(), other=f.service.follow(otherAbort.signal);
    assert.deepEqual((await other.next()).value.value.pinnedSessionIds,['local',id]);otherAbort.abort();await other.return();
    assert.deepEqual(await f.service.pinSession({sessionId:'local'}),{pinnedSessionIds:['local',id]});
    await f.service.archiveSession({sessionId:id});assert.equal(f.chat.pinned,false);assert.equal(f.chat.archived,true);
    await assert.rejects(f.service.pinSession({sessionId:id}),/取消归档/);
    await f.service.unarchiveSession({sessionId:id}); await f.service.unpinSession({sessionId:id});
    assert.equal(f.chat.archived,false);assert.equal(f.chat.pinned,false);
  } finally {abort.abort();await feed.return();dispose();}
  assert.equal(f.service.pinSession,previous);
});

test('running mirror must stop successfully before archive changes local state', async()=>{
  const f=fixture();f.chat.running=true;f.linked.nativeCall=async()=>{throw Error('offline');};
  const dispose=installLinkedWorkspace(f.ctx,f.linked);
  try {await assert.rejects(f.service.archiveSession({sessionId:mirrorId(f.chat),stopActivity:true}),/offline/);assert.equal(f.chat.archived,undefined);}finally{dispose();}
});

test('theme permanent deletion routes mirror ID to owner, preserves confirmation and leaves ordinary sessions native',async()=>{
  const f=fixture(), calls=[], service={async deleteSession(request){calls.push(request);return{deleted:true};}};
  f.linked.deleteChat=async(chat)=>{assert.equal(chat,f.chat);return{deleted:true,sessionId:mirrorId(chat)};};
  f.linked.forget=async chat=>{chat.removed=true;};
  const original=service.deleteSession, dispose=installLinkedThemeActions({get:()=>service},f.linked);
  try {
    await assert.rejects(service.deleteSession({sessionId:mirrorId(f.chat)}),/确认/);
    assert.equal((await service.deleteSession({sessionId:mirrorId(f.chat),confirm:true})).deleted,true);assert.equal(calls.length,0);
    await service.deleteSession({sessionId:'ordinary',confirm:true});assert.equal(calls[0].sessionId,'ordinary');
  }finally{dispose();} assert.equal(service.deleteSession,original);
});

test('Android owner deletion drains its exact Agent and removes only a validated session directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-peer-delete-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const id='test-session', folder=join(root,id);await mkdir(folder);await writeFile(join(folder,'journal.jsonl'),'test');await writeFile(join(root,'keep'),'private');
  const live=new Map(), order=[], registry={archivedSessionIds:[],async archiveSession(){order.push('archive');},async unarchiveSession(){order.push('unarchive');}};
  const agents={async create(){const agent={id,session:{id}};live.set(id,agent);return{agent,async dispose(){order.push('dispose');live.delete(id);}};}};
  const persistence={config:{root},async stat(){return{header:{id}};},async list(){return[];},locate(){return{kind:'jsonl',path:join(folder,'journal.jsonl')};},async open(){order.push('lease');return{async close(){order.push('close');}};}};
  const linked={}, ctx={get:name=>({agents,sessionPersistence:persistence,workspaceRegistry:registry,sessions:{get:key=>live.get(key)}})[name],async parallel(){order.push('stop');},emit(){order.push('removed');}};
  const previous=agents.create, dispose=installLinkedDeletion(ctx,linked);
  try {
    await agents.create();await assert.rejects(linked.deleteSession({sessionId:id}),/确认/);
    const result=await linked.deleteSession({sessionId:id,confirm:true});assert.equal(result.deleted,true);
    assert.deepEqual(order,['archive','stop','dispose','lease','close','unarchive','removed']);
    await assert.rejects(stat(folder),{code:'ENOENT'});assert.ok(await stat(join(root,'keep')));
  }finally{dispose();}assert.equal(agents.create,previous);
});

test('owner rejects an out-of-root session location before stopping anything',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-peer-delete-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=join(root,'store'), outside=join(root,'outside');await mkdir(store);await mkdir(outside);
  const persistence={config:{root:store},async stat(){return{header:{id:'outside'}};},async list(){return[];},locate(){return{kind:'jsonl',path:join(outside,'journal.jsonl')};}};
  let stops=0;const linked={},dispose=installLinkedDeletion({get:name=>({sessionPersistence:persistence,workspaceRegistry:{},sessions:{}})[name],async parallel(){stops++;}},linked);
  try{await assert.rejects(linked.deleteSession({sessionId:'outside',confirm:true}),/路径校验失败/);assert.equal(stops,0);assert.ok(await stat(outside));}finally{dispose();}
});

test('a stuck session stop times out and cannot continue to physical deletion when it eventually resolves',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-peer-stuck-delete-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='stuck-session',folder=join(root,id);await mkdir(folder);await writeFile(join(folder,'journal.jsonl'),'keep until released');
 let release, opened=false;const stopped=new Promise(resolve=>release=resolve);
 const persistence={config:{root},async stat(){return{header:{id}};},async list(){return[];},locate(){return{kind:'jsonl',path:join(folder,'journal.jsonl')};},async open(){opened=true;return{async close(){}};}};
 const registry={archivedSessionIds:[],async archiveSession(){},async unarchiveSession(){}};
 const linked={},dispose=installLinkedDeletion({get:name=>({sessionPersistence:persistence,workspaceRegistry:registry,sessions:{get(){}}})[name],parallel:()=>stopped,emit(){}},linked);
 try {
  await assert.rejects(linked.deleteSession({sessionId:id,confirm:true},AbortSignal.timeout(100)),{name:'TimeoutError'});
  release();await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(opened,false);assert.ok(await stat(folder));
 } finally {release();dispose();}
});

test('a write lease arriving after deletion timeout is released without deleting the journal',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-peer-late-lease-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='late-lease',folder=join(root,id);await mkdir(folder);await writeFile(join(folder,'journal.jsonl'),'keep');
 let release,closed=0;const opening=new Promise(resolve=>release=resolve);
 const persistence={config:{root},async stat(){return{header:{id}};},async list(){return[];},locate(){return{kind:'jsonl',path:join(folder,'journal.jsonl')};},open(){return opening;}};
 const registry={archivedSessionIds:[],async archiveSession(){},async unarchiveSession(){}};
 const linked={},dispose=installLinkedDeletion({get:name=>({sessionPersistence:persistence,workspaceRegistry:registry,sessions:{get(){}}})[name],async parallel(){},emit(){}},linked);
 try {
  await assert.rejects(linked.deleteSession({sessionId:id,confirm:true},AbortSignal.timeout(100)),{name:'TimeoutError'});
  release({async close(){closed++;}});await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(closed,1);assert.ok(await stat(folder));
 } finally {dispose();}
});

test('canonical root aliases are accepted for valid session directories',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-peer-alias-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=join(root,'store'), alias=join(root,'alias'), id='linked-session';await mkdir(join(store,'project',id),{recursive:true});
  await symlink(store,alias,process.platform==='win32'?'junction':'dir');
  const persistence={config:{root:store},async stat(){return{header:{id}};},async list(){return[];},locate(){return{kind:'jsonl',path:join(alias,'project',id,'v4.jsonl')};},async open(){return{async close(){}};}};
  const registry={archivedSessionIds:[],async archiveSession(){},async unarchiveSession(){}};
  const linked={},dispose=installLinkedDeletion({get:name=>({sessionPersistence:persistence,workspaceRegistry:registry,sessions:{get(){}}})[name],async parallel(){},emit(){}},linked);
  try{assert.equal((await linked.deleteSession({sessionId:id,confirm:true})).deleted,true);await assert.rejects(stat(join(store,'project',id)),{code:'ENOENT'});}finally{dispose();}
});

test('a session leaf pointing to another directory is refused even within the store',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-peer-leaf-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const real=join(root,'private-session'),leaf=join(root,'shared-session');await mkdir(real);await symlink(real,leaf,process.platform==='win32'?'junction':'dir');
  const persistence={config:{root},async stat(){return{header:{id:'shared-session'}};},async list(){return[];},locate(){return{kind:'jsonl',path:join(leaf,'v4.jsonl')};}};
  let stopped=false;const linked={},dispose=installLinkedDeletion({get:name=>({sessionPersistence:persistence,workspaceRegistry:{},sessions:{}})[name],async parallel(){stopped=true;}},linked);
  try{await assert.rejects(linked.deleteSession({sessionId:'shared-session',confirm:true}),/路径校验失败/);assert.equal(stopped,false);assert.ok(await stat(real));}finally{dispose();}
});

test('owned linked sessions pin offline without looking up a native Session and unpin keeps unrelated pins',async()=>{
 const f=fixture();f.chat.owner='here';f.registry.pinnedSessionIds=['local','owner-session'];
 const dispose=installLinkedWorkspace(f.ctx,f.linked);
 try{
  await f.service.pinSession({sessionId:'owner-session'});assert.equal(f.chat.pinned,true);assert.equal(f.calls.length,0);
  assert.deepEqual(await f.service.unpinSession({sessionId:'owner-session'}),{pinnedSessionIds:['local']});assert.equal(f.calls.length,0);
 }finally{dispose();}
});

test('permanent deletion works with the real Harness JSONL layout and retains an unrelated real journal',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-peer-real-journal-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const context=new Context(), backend=context.plugin(JsonlSessionPersistence,{root,compression:'none'});
 await backend.await();t.after(()=>backend.dispose());
 const persistence=context.sessionPersistence;
 for(const id of ['shared-real','private-real']){
  const handle=await persistence.create({version:4,id,createdAt:Date.now(),isSeeded:false,cwd:root});await handle.flush();await handle.close();
 }
 const linked={},registry={archivedSessionIds:[],async archiveSession(){},async unarchiveSession(){}};
 const dispose=installLinkedDeletion({get:name=>({sessionPersistence:persistence,workspaceRegistry:registry,sessions:{get(){}}})[name],async parallel(){},emit(){}},linked);
 try{
  assert.equal((await linked.deleteSession({sessionId:'shared-real',confirm:true})).deleted,true);
  assert.equal(await persistence.stat('shared-real'),undefined);assert.ok(await persistence.stat('private-real'));
  assert.equal((await linked.deleteSession({sessionId:'shared-real',confirm:true})).deleted,true);
 }finally{dispose();}
});
