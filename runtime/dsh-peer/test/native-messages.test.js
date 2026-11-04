import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeMessages, mirrorId } from '../native-messages.js';
import { ClientAssistantStream } from '../../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/assistant-stream.js';

test('an already-open native client receives a valid live text block and publishes the completed reply without refreshing',async()=>{
 const chat={id:'live',owner:'phone',sessionId:'owner',members:['pc','phone'],title:'live',updatedAt:1,events:[],livePosition:{turn:3,step:2}};
 const controller={async *follow(){}};
 const linked={data:{deviceId:'pc',chats:{live:chat}}};
 const dispose=installNativeMessages({get:name=>name==='sessionController'?controller:undefined,emit(){}},linked);
 const abort=new AbortController(),source=controller.follow({address:{kind:'session',sessionId:mirrorId(chat)},assistantStream:true},abort.signal);
 const client=new ClientAssistantStream(), published=[];
 try {
  const snapshot=(await source.next()).value;client.replace(snapshot.records,snapshot.assistantStream);
  chat.events.push({seq:10,type:'turn/start',time:1,data:{turn:3}},{seq:12,type:'step/start',time:2,data:{turn:3,step:2}});
  for(let i=0;i<2;i++)client.acceptDurable({type:'event',event:(await source.next()).value.event});
  chat.live='hello';
  const start=(await source.next()).value.frame;assert.equal(start.turn,3);assert.equal(start.step,2);client.acceptFrame(start);
  const block=(await source.next()).value.frame;assert.equal(block.chunk.type,'block-start');assert.notEqual(client.acceptFrame(block)?.type,'rebaseline');
  const text=(await source.next()).value.frame;assert.equal(text.chunk.index,0);assert.equal(client.acceptFrame(text).entry.event.data.chunk.text,'hello');
  chat.live='';chat.events.push({seq:15,type:'assistant/message',time:3,data:{turn:3,step:2,message:{role:'assistant',content:[{type:'text',text:'hello'}]}},surfaceOp:'append'}, {seq:16,type:'step/end',time:4,data:{turn:3,step:2}}, {seq:17,type:'turn/end',time:5,data:{turn:3,reason:{kind:'completed'}}});
  assert.equal(client.acceptFrame((await source.next()).value.frame).type,'abandonment');
  for(let i=0;i<3;i++){const result=client.acceptDurable({type:'event',event:(await source.next()).value.event});assert.notEqual(result?.type,'rebaseline');if(result?.entry)published.push(result.entry.event);}
  assert.deepEqual(published.map(e=>e.type),['assistant/message','step/end','turn/end']);
  chat.journalEpoch=1;
  assert.equal((await source.next()).value.type,'snapshot');
 }finally{abort.abort();await source.return();dispose();}
});

test('native Session adapter uses cached selected journal and forwards model, prompt and upload to the owner', async () => {
  const calls = [], chat = { id: 'shared', owner: 'owner', members: ['here','owner'], sessionId: 'private-owner-id', title: 'Shared', updatedAt: 1, version: 'v1', events: [{seq:2,type:'user/message',data:{message:{content:[{type:'text',text:'history'}]}}}], nativeProjections: { values: { modelSelection: { next: {provider:'p',model:'m'} } } } };
  const controller = { async list() { return { items: [{ sessionId: 'private-local' }] }; }, async prompt() { return 'local'; }, async projections() { return 'local'; }, async selectModel() { return 'local'; }, async attachment() { return 'local'; }, async page() { return 'local'; }, async *follow() { yield 'local'; }, async modelCatalog() { return {groups:[]}; }, async *control(signal) { yield {type:'baseline',value:{projections:{}}}; await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})); } };
  const original = controller.prompt, uploads = { async uploadStream(){return 'local';} };
  const linked = { data: { deviceId:'here',chats:{shared:chat} }, async init(){}, async action(input){calls.push(['prompt',input]);}, async nativeCall(item,method,request){calls.push([method,request]);return {accepted:true};} };
  const emitted=[];
  const dispose = installNativeMessages({get:name=>name==='sessionController'?controller:uploads,emit(...args){emitted.push(args);}},linked);
  try {
    const id=mirrorId(chat);const list=await controller.list({});assert.equal(list.items.length,2);assert.equal(list.items[1].sessionId,id);
    assert.equal(await controller.prompt({sessionId:'private-local'}),'local');
    await controller.prompt({sessionId:id,requestId:'request',content:[{type:'image',data:'aQ==',mediaType:'image/png'},{type:'text',text:'hello'}]});
    assert.equal(calls[0][1].content.length,2);assert.equal(calls[0][1].id,'shared');
    await controller.selectModel({sessionId:id,provider:'p',model:'m',reasoningEffort:'high'});
    assert.equal(calls[1][0],'selectModel');assert.equal(calls[1][1].reasoningEffort,'high');
    const projection=await controller.projections({sessionId:id});assert.equal(projection.values.modelSelection.next.model,'m');
    const controlAbort=new AbortController(); const controls=controller.control(controlAbort.signal); const baseline=await controls.next(); assert.equal(baseline.value.value.projections[id].values.modelSelection.next.model,'m'); controlAbort.abort(); await controls.return();
    const abort=new AbortController();const source=controller.follow({address:{kind:'session',sessionId:id}},abort.signal);const first=await source.next();assert.equal(first.value.type,'snapshot');assert.equal(first.value.records[0].event.seq,0);abort.abort();await source.return();
    const streamAbort=new AbortController(), stream=controller.follow({address:{kind:'session',sessionId:id},assistantStream:true},streamAbort.signal); await stream.next(); chat.live='hello'; assert.equal((await stream.next()).value.frame.type,'start'); const opening=(await stream.next()).value.frame; assert.equal(opening.chunk.type,'block-start'); const one=(await stream.next()).value.frame; assert.equal(one.index,1); assert.equal(one.chunk.text,'hello'); chat.live='hello world';const two=(await stream.next()).value.frame;assert.equal(two.type,'chunk');assert.equal(two.index,2);assert.equal(two.chunk.text,' world'); chat.live='';const end=(await stream.next()).value.frame;assert.equal(end.type,'end');assert.equal(end.index,3);streamAbort.abort();await stream.return();
    await uploads.uploadStream({sessionId:id,name:'test.txt',data:(async function*(){yield Buffer.from('data');})()});assert.equal(calls[2][0],'upload');assert.equal(calls[2][1].data,'ZGF0YQ==');
    chat.removed=true;assert.equal((await controller.list({})).items.length,1);
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(emitted.filter(([type,removedId])=>type==='api-session/removed'&&removedId===id).length,1);
  } finally {dispose();}
  assert.equal(controller.prompt,original);
});
