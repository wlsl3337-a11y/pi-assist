import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createAccountService,identityKey} from './account-core.mjs';
import {createCreditLedger} from './credit-ledger.mjs';
import {createChargedAnalysis} from './credit-ai-route.mjs';
function dbFixture(){
 const records=new Map();let queue=Promise.resolve();
 const snap=(map,id)=>({exists:map.has(id),data:()=>structuredClone(map.get(id))});
 const db={records,collection:name=>({doc:id=>({id:name+'/'+id,get:async()=>snap(records,name+'/'+id)})}),runTransaction(fn){
  const task=queue.then(async()=>{const stage=new Map([...records].map(([k,v])=>[k,structuredClone(v)]));const value=await fn({get:async r=>snap(stage,r.id),set:(r,data)=>stage.set(r.id,structuredClone(data)),create:(r,data)=>{assert(!stage.has(r.id));stage.set(r.id,structuredClone(data));}});records.clear();for(const [k,v]of stage)records.set(k,v);return value;});queue=task.catch(()=>{});return task;
 }};return db;
}
const claims={email_verified:true,firebase:{sign_in_provider:'google.com',identities:{'google.com':['google']}}};
async function fixture(){let time=1000;const db=dbFixture(),service=createAccountService({db,verifyIdToken:async token=>{if(token!=='valid')throw Error();return claims;}});service.ledger=createCreditLedger({db,now:()=>time});await service.session('Bearer valid');return {db,service,key:identityKey(claims),tick:n=>time+=n,balance:()=>service.balance('Bearer valid')};}
test('concurrent requests cannot overspend the single trial; repeats cannot mint credits',async()=>{
 const f=await fixture(),id=randomUUID();const results=await Promise.allSettled([f.service.ledger.reserve(f.key,id,'hash'),f.service.ledger.reserve(f.key,randomUUID(),'hash')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.balance()).freeRemaining,0);
 await assert.rejects(()=>f.service.ledger.reserve(f.key,id,'other'),e=>e.code==='REQUEST_ALREADY_HANDLED');
 await f.service.ledger.settle(results.find(r=>r.status==='fulfilled').value,false);
 await f.service.ledger.settle(results.find(r=>r.status==='fulfilled').value,false);
 assert.equal((await f.balance()).freeRemaining,1);
});
test('crash recovery refunds expired holds; late success cannot charge a refunded trial',async()=>{
 const f=await fixture();const hold=await f.service.ledger.reserve(f.key,randomUUID(),'hash');f.tick(120001);await f.service.ledger.recover(f.key);
 assert.equal((await f.balance()).freeRemaining,1);assert.equal(await f.service.ledger.settle(hold,true),false);assert.equal((await f.balance()).freeRemaining,1);
});
test('free first, paid carry-over and two concurrent hold limit',async()=>{
 const f=await fixture(),ref='aiCreditAccounts/'+f.key;f.db.records.get(ref).paidRemaining=5;
 const a=await f.service.ledger.reserve(f.key,randomUUID(),'hash'),b=await f.service.ledger.reserve(f.key,randomUUID(),'hash');
 await assert.rejects(()=>f.service.ledger.reserve(f.key,randomUUID(),'hash'),e=>e.code==='ANALYSIS_IN_PROGRESS');
 await f.service.ledger.settle(a,true);await f.service.ledger.settle(b,false);
 assert.equal((await f.balance()).freeRemaining,0);assert.equal((await f.balance()).paidRemaining,5);
});
async function httpFixture(provider,timeoutMs=40000){
 const f=await fixture();let calls=0;const app=express();app.use(express.json());
 app.post('/analysis',createChargedAnalysis({getAccounts:()=>f.service,key:'test-only',timeoutMs,request:async(...args)=>{calls++;return provider(...args);}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const send=(body={},auth='Bearer valid')=>fetch('http://127.0.0.1:'+server.address().port+'/analysis',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({images:['a'.repeat(100)],prompt:'synthetic test',requestId:randomUUID(),...body})});
 return {...f,send,calls:()=>calls,close:()=>new Promise(r=>server.close(r))};
}
const result=(value,extra={})=>({ok:true,json:async()=>({content:[{type:'text',text:JSON.stringify(value)}],stop_reason:'end_turn',...extra})});
test('HTTP auth, invalid input and exhausted credits never call the paid provider',async()=>{
 const f=await httpFixture(()=>result({canAssess:true}));try{
 assert.equal((await f.send({},'Bearer invalid')).status,401);assert.equal((await f.send({images:[]})).status,400);assert.equal(f.calls(),0);
 assert.equal((await f.send()).status,200);assert.equal((await f.send()).status,402);assert.equal(f.calls(),1);assert.equal((await f.balance()).freeRemaining,0);
 }finally{await f.close();}
});
for(const [name,provider] of [
 ['provider failure',()=>{throw Error('secret response must never be exposed');}],
 ['malformed output',()=>result({})],['truncated output',()=>result({canAssess:true},{stop_reason:'max_tokens'})]
])test(name+' refunds the reserved credit',async()=>{
 const f=await httpFixture(provider);try{const r=await f.send();assert.equal(r.status,503);assert(!(await r.text()).includes('secret'));assert.equal((await f.balance()).freeRemaining,1);}finally{await f.close();}
});
test('unassessable photo returns the caution result without consuming a trial',async()=>{
 const f=await httpFixture(()=>result({canAssess:false,photoQuality:{adequate:false}}));try{assert.equal((await f.send()).status,200);assert.equal((await f.balance()).freeRemaining,1);}finally{await f.close();}
});
test('same request cannot call the provider or charge twice',async()=>{
 const f=await httpFixture(()=>result({canAssess:true}));try{const requestId=randomUUID();assert.equal((await f.send({requestId})).status,200);assert.equal((await f.send({requestId})).status,409);assert.equal(f.calls(),1);}finally{await f.close();}
});

test('provider timeout aborts work and restores the held credit',async()=>{
 const f=await httpFixture((_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true})),15);
 try {assert.equal((await f.send()).status,503);assert.equal((await f.balance()).freeRemaining,1);}finally{await f.close();}
});
