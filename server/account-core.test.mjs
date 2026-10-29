import test from 'node:test';
import assert from 'node:assert/strict';
import {identityKey,checkedBalance,createAccountService} from './account-core.mjs';

const claims=(uid='firebase-uid',google='stable-google-sub')=>({uid,email_verified:true,
  firebase:{sign_in_provider:'google.com',identities:{'google.com':[google]}}});
function fakeDb() {
  const records=new Map();let queue=Promise.resolve();
  const ref=id=>({id,get:async()=>({exists:records.has(id),data:()=>records.get(id)})});
  return {records,collection:()=>({doc:ref}),runTransaction(fn){
    const next=queue.then(()=>fn({get:r=>r.get(),create(r,data){assert(!records.has(r.id));records.set(r.id,data);}}));
    queue=next.catch(()=>{});return next;
  }};
}
test('reject missing, invalid, revoked and non-Google credentials before touching storage',async()=>{
  const db=fakeDb();let revokedCheck;
  const service=createAccountService({db,verifyIdToken:async(t,revoked)=>{revokedCheck=revoked;if(t==='bad')throw Error();return {...claims(),email_verified:false};}});
  for(const header of [undefined,'Bearer bad','Bearer good'])await assert.rejects(()=>service.session(header));
  assert.equal(db.records.size,0);assert.equal(revokedCheck,true);
});
test('concurrent session calls grant exactly one persistent trial',async()=>{
  const db=fakeDb();const service=createAccountService({db,verifyIdToken:async()=>claims()});
  const results=await Promise.all(Array.from({length:12},()=>service.session('Bearer valid')));
  assert.equal(db.records.size,1);assert(results.every(r=>r.freeRemaining===1&&r.paidRemaining===0));
  const record=db.records.get(identityKey(claims()));record.freeRemaining=0;record.paidRemaining=10;
  assert.deepEqual(await service.balance('Bearer valid'),checkedBalance(record));
  assert.equal((await service.session('Bearer valid')).freeRemaining,0);
});
test('Firebase UID recreation keeps Google identity and existing credit balance',async()=>{
  assert.equal(identityKey(claims('old')),identityKey(claims('new')));
  assert.notEqual(identityKey(claims('old','a')),identityKey(claims('old','b')));
});
test('corrupt and unknown balances fail closed without silently resetting credits',()=>{
  for(const value of [null,{}, {schemaVersion:1,freeRemaining:2,paidRemaining:0},
    {schemaVersion:1,freeRemaining:1,paidRemaining:-1},{schemaVersion:1,freeRemaining:1,paidRemaining:Number.MAX_SAFE_INTEGER}])
    assert.throws(()=>checkedBalance(value));
});
test('GET never grants a trial and cannot select another account through request data',async()=>{
  const db=fakeDb();const service=createAccountService({db,verifyIdToken:async t=>claims(t,t)});
  await assert.rejects(()=>service.balance('Bearer a'),e=>e.code==='SESSION_REQUIRED');
  assert.equal(db.records.size,0);
  await service.session('Bearer a');
  await assert.rejects(()=>service.balance('Bearer b'),e=>e.code==='SESSION_REQUIRED');
});
