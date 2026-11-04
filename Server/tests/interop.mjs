import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Peer } from '../../runtime/dsh-peer/peer.js';
import { createPair, mac } from '../../runtime/dsh-peer/protocol.js';
import WebSocket from '../../runtime/node_modules/ws/index.js';

const port = 16584;
const processHandle = spawn(process.env.DSH_TEST_PYTHON || 'python', ['Server/app.py'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
processHandle.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
try {
 let health;
 for(let attempt=0;attempt<80;attempt++){
  try {health=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)}); if(health.ok)break;}catch{}
  if(processHandle.exitCode !== null)throw Error('Python service failed: '+stderr);
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(health?.ok);assert.equal(health.headers.get('x-dsh-peer-relay'),'1');
 for(const [path,mode] of [['/peer','relay'],['/peer','auto'],['/peer','p2p'],['/','relay']]){
  const pair={...createPair(`ws://127.0.0.1:${port}${path}`),mode};
  const dispatch=async(method,args,signal)=>{
   if(method==='slow'){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw Error('canceled');}
   return args;
  };
  const host=new Peer({pair,role:'host',dispatch,timeout:10000,fallbackDelay:0,reconnectDelay:30});
  const guest=new Peer({pair,role:'guest',dispatch,timeout:10000,fallbackDelay:0,reconnectDelay:30});
  try {
   await Promise.all([host.ready,guest.ready]);
   assert.equal(await host.request('echo','desktop-to-phone'),'desktop-to-phone');
   assert.equal(await guest.request('echo','phone-to-desktop'),'phone-to-desktop');
   const image={content:[{type:'image',data:'Q'.repeat(2000000)}]};
   assert.deepEqual(await host.request('echo',image),image);
   const controller=new AbortController();const slow=host.request('slow',{},controller.signal);controller.abort();await assert.rejects(slow,/canceled/);
   if(mode!=='p2p')assert.match(host.status().transport,/relay/);
   else assert.match(host.status().transport,/ICE/);
   const previous=host.ws;host.ws.terminate();
   const deadline=Date.now()+25000;
   while(host.ws===previous||host.state!=='connected'||guest.state!=='connected'){
    if(Date.now()>deadline)throw Error('Python relay reconnect timed out');
    await new Promise(resolve=>setTimeout(resolve,30));
   }
   assert.equal(await host.request('echo','after-network-change'),'after-network-change');
   const closed=once(host.ws,'close');await guest.close();await closed;
   await assert.rejects(host.request('echo',{}),/not connected/);
   console.log(`PASS ${path} ${mode}: bidirectional RPC, 2 MB image, cancellation, automatic reconnect, disconnect`);
  }finally{await host.close();await guest.close();}
 }
 const pair=createPair(`ws://127.0.0.1:${port}/peer`);
 const good=new WebSocket(pair.server);await once(good,'open');
 good.send(JSON.stringify({type:'join',room:pair.room,role:'host',access:mac(pair.secret,'join:'+pair.room)}));
 await once(good,'message');
 const bad=new WebSocket(pair.server);await once(bad,'open');
 bad.send(JSON.stringify({type:'join',room:pair.room,role:'guest',access:'0'.repeat(64)}));
 const [code]=await once(bad,'close');assert.equal(code,1008);good.close();
 console.log('PASS wrong room access rejected');
}finally{processHandle.kill();}
