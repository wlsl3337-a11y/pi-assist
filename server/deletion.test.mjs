import test from 'node:test';import assert from 'node:assert/strict';
import {createAccountDeletion} from './account-deletion.mjs';import {createAccountService,identityKey} from './account-core.mjs';import {createCreditLedger} from './credit-ledger.mjs';
import {randomUUID} from 'node:crypto';
function database(){
 const records=new Map();let queue=Promise.resolve();
 const snapshot=(map,id)=>({exists:map.has(id),data:()=>structuredClone(map.get(id))});
 const db={records,collection:n=>({doc:id=>({id:n+'/'+id,get:async()=>snapshot(records,n+'/'+id)})}),runTransaction(fn){const next=queue.then(async()=>{const stage=new Map([...records].map(([k,v])=>[k,structuredClone(v)]));const out=await fn({get:async r=>snapshot(stage,r.id),create:(r,v)=>{assert(!stage.has(r.id));stage.set(r.id,structuredClone(v));},set:(r,v)=>stage.set(r.id,structuredClone(v))});records.clear();for(const [k,v]of stage)records.set(k,v);return out;});queue=next.catch(()=>{});return next;}};return db;
}
const claims=(sub='g',uid='uid')=>({uid,auth_time:1000,email_verified:true,firebase:{sign_in_provider:'google.com',identities:{'google.com':[sub]}}});
async function fixture(){
 let time=1000000,removed=false,authFailure=false,cleanupFailure=false;
 const db=database(),auth={verifyIdToken:async(t,revoked)=>{if(t==='invalid')throw Error();if(revoked&&removed)throw Error('deleted');return t==='other'?claims('other','other-uid'):t==='old'?{...claims(),auth_time:100}:claims();},getUser:async()=>{if(removed)throw Object.assign(Error(),{code:'auth/user-not-found'});return{};},deleteUser:async uid=>{assert.equal(uid,'uid');if(authFailure)throw Error('admin temporarily unavailable');removed=true;}};
 const account=createAccountService({db,verifyIdToken:auth.verifyIdToken,now:()=>time});await account.session('Bearer valid');
 const ledger=createCreditLedger({db,now:()=>time}),key=identityKey(claims());
 const service=createAccountDeletion({db,auth,now:()=>time,deleteLinkedRequests:async key=>{if(cleanupFailure)throw Error('db temporarily unavailable');for(const [id,v]of db.records)if(id.startsWith('aiCreditRequests/')&&v.accountKey===key)db.records.delete(id);}});
 return {db,auth,account,ledger,service,key,record:()=>db.records.get('aiCreditAccounts/'+key),removed:()=>removed,setAuthFailure:v=>authFailure=v,setCleanupFailure:v=>cleanupFailure=v};
}
test('recent verified Google identity and explicit confirmation are required; body cannot target another account',async()=>{
 const f=await fixture();for(const [h,c]of [['Bearer invalid','DELETE_ACCOUNT'],['Bearer old','DELETE_ACCOUNT'],['Bearer valid',''],[null,'DELETE_ACCOUNT']])await assert.rejects(()=>f.service.remove(h,c));
 assert(!f.removed());assert.equal(f.record().freeRemaining,1);
 await f.service.remove('Bearer other','DELETE_ACCOUNT').catch(()=>{});assert.equal(f.record().freeRemaining,1);
});
test('direct deletion removes Auth, balances and own linked requests, retaining only a minimal anti-trial marker',async()=>{
 const f=await fixture(),hold=await f.ledger.reserve(f.key,randomUUID(),'synthetic');await f.ledger.settle(hold,true);
 f.db.records.set('aiCreditRequests/other',{accountKey:'other'});
 assert.deepEqual(await f.service.remove('Bearer valid','DELETE_ACCOUNT'),{status:'deleted'});assert(f.removed());
 assert.deepEqual(f.record(),{schemaVersion:1,deletionState:'complete',trialUsed:true});
 assert.deepEqual([...f.db.records.keys()].filter(x=>x.startsWith('aiCreditRequests/')),['aiCreditRequests/other']);
});
test('remaining paid credits or active analysis block deletion without mutating balances or Auth',async()=>{
 const f=await fixture();f.record().paidRemaining=5;
 await assert.rejects(()=>f.service.remove('Bearer valid','DELETE_ACCOUNT'),e=>e.code==='REFUND_REQUIRED');assert.equal(f.record().paidRemaining,5);assert(!f.removed());
 f.record().paidRemaining=0;await f.ledger.reserve(f.key,randomUUID(),'synthetic');
 await assert.rejects(()=>f.service.remove('Bearer valid','DELETE_ACCOUNT'),e=>e.code==='ANALYSIS_IN_PROGRESS');assert(!f.removed());
});
test('deletion lock prevents new analysis and session grants while failed cleanup is recoverable',async()=>{
 const f=await fixture();f.setCleanupFailure(true);
 await assert.rejects(()=>f.service.remove('Bearer valid','DELETE_ACCOUNT'));
 assert.equal(f.record().deletionState,'pending');assert(!f.removed());
 await assert.rejects(()=>f.ledger.reserve(f.key,randomUUID(),'synthetic'),e=>e.code==='DELETION_IN_PROGRESS');
 await assert.rejects(()=>f.account.session('Bearer valid'),e=>e.code==='DELETION_IN_PROGRESS');
 f.setCleanupFailure(false);assert.equal((await f.service.finish(f.key,'uid')).status,'deleted');
});
test('failed Firebase deletion remains durable and retries; duplicate completion is idempotent',async()=>{
 const f=await fixture();f.setAuthFailure(true);await assert.rejects(()=>f.service.remove('Bearer valid','DELETE_ACCOUNT'));assert.equal(f.record().deletionState,'pending');
 f.setAuthFailure(false);await f.service.finish(f.key,'uid');await f.service.finish(f.key,'uid');assert(f.removed());assert.equal(f.record().deletionState,'complete');
});
test('re-registration cannot claim a second trial; wrong Firebase UID cannot finish another pending job',async()=>{
 const f=await fixture();f.setCleanupFailure(true);await assert.rejects(()=>f.service.remove('Bearer valid','DELETE_ACCOUNT'));
 await assert.rejects(()=>f.service.finish(f.key,'other-uid'));assert(!f.removed());
 f.setCleanupFailure(false);await f.service.finish(f.key,'uid');
 const other=createAccountService({db:f.db,verifyIdToken:async()=>claims('g','new-uid')});assert.equal((await other.session('Bearer new')).freeRemaining,0);
});
test('corrupt paid balance is never silently deleted',async()=>{
 const f=await fixture();f.record().paidRemaining=-1;await assert.rejects(()=>f.service.remove('Bearer valid','DELETE_ACCOUNT'));assert(!f.removed());assert.equal(f.record().paidRemaining,-1);
});

import {expiredLegacyRequest} from './legacy-retention.mjs';
test('legacy technical retention targets only unlinked expired operational metadata',()=>{
 const now=40*86400000;
 assert(expiredLegacyRequest({createdAtMs:1},now));
 assert(!expiredLegacyRequest({createdAtMs:39*86400000},now));
 assert(!expiredLegacyRequest({accountKey:'another-account',createdAtMs:1},now));
 assert(!expiredLegacyRequest({},now));
 assert(!expiredLegacyRequest({createdAtMs:-1},now));
});
