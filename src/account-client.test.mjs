import test from 'node:test';import assert from 'node:assert/strict';import {createAccountClient} from './account-client.mjs';
const user={uid:'uid',email:'synthetic@example.invalid'};
async function fixture({wrongUser=false,status=200,reply={status:'deleted'}}={}){
 let signedOut=0,calls=[];
 const auth={getCurrentUser:async()=>({user}),getIdToken:async options=>{if(options)assert.equal(options.forceRefresh,true);return{token:'synthetic-token'};},signInWithGoogle:async()=>({user:wrongUser?{uid:'other'}:user}),signOut:async()=>{signedOut++;}};
 const account=createAccountClient({auth,isAvailable:()=>true,base:'https://example.invalid',request:async(url,options)=>{calls.push({url,options});if(options.method==='DELETE')return{ok:status===200,status,json:async()=>reply};return{ok:true,json:async()=>({status:'verified',freeRemaining:0,paidRemaining:0})};}});
 await account.start();return{account,calls,signedOut:()=>signedOut};
}
test('verified deletion clears client state only after server confirms completion',async()=>{
 const f=await fixture();assert.equal((await f.account.deleteAccount()).status,'deleted');assert.equal(f.signedOut(),1);assert.equal(f.account.getSnapshot().user,null);
 const call=f.calls.find(c=>c.options.method==='DELETE');assert.equal(call.url,'https://example.invalid/api/account/');assert.deepEqual(JSON.parse(call.options.body),{confirmation:'DELETE_ACCOUNT'});assert(!call.options.body.includes('uid'));assert(!call.options.body.includes('synthetic@'));
});
test('selecting another Google account never sends the deletion request',async()=>{
 const f=await fixture({wrongUser:true});await assert.rejects(()=>f.account.deleteAccount(),/다른 Google/);assert.equal(f.calls.filter(c=>c.options.method==='DELETE').length,0);assert.equal(f.signedOut(),0);
});
for(const [name,status,reply]of [['old server',404,{}],['pending',503,{code:'DELETION_PENDING',error:'처리 중'}],['paid protection',409,{code:'REFUND_REQUIRED',error:'유료 잔액 확인 필요'}],['malformed success',200,{}]])test(name+' never displays a completed deletion',async()=>{
 const f=await fixture({status,reply});await assert.rejects(()=>f.account.deleteAccount());assert.equal(f.signedOut(),0);assert.notEqual(f.account.getSnapshot().phase,'signedout');
});
