import {createHash} from 'node:crypto';
import {AccountError,checkedBalance} from './account-core.mjs';
const LEASE_MS=120000;
const fail=(code,status,message)=>{throw new AccountError(code,status,message);};
function releaseExpired(data,now){
 checkedBalance(data);
 const holds={...(data.creditHolds||{})};let free=data.freeRemaining,paid=data.paidRemaining;
 for(const [id,h] of Object.entries(holds)){
  if(!h||!['free','paid'].includes(h.kind)||!Number.isSafeInteger(h.expiresAt))fail('BALANCE_UNAVAILABLE',503,'이용 횟수를 확인할 수 없습니다.');
  if(h.expiresAt<=now){if(h.kind==='free')free++;else paid++;delete holds[id];}
 }
 const updated={...data,freeRemaining:free,paidRemaining:paid,creditHolds:holds};checkedBalance(updated);return updated;
}
export function createCreditLedger({db,now=Date.now}){
 const account=key=>db.collection('aiCreditAccounts').doc(key);
 const operation=(key,id)=>db.collection('aiCreditRequests').doc(createHash('sha256').update(key+':'+id).digest('hex'));
 return {
  async recover(key){return db.runTransaction(async tx=>{const ref=account(key),s=await tx.get(ref);if(!s.exists||s.data().deletionState==='complete')return;const data=releaseExpired(s.data(),now());tx.set(ref,data);});},
  async reserve(key,id,fingerprint){
   if(!/^[a-f0-9-]{36}$/.test(id||''))fail('REQUEST_ID_REQUIRED',400,'앱을 업데이트한 뒤 다시 시도해주세요.');
   return db.runTransaction(async tx=>{
    const ar=account(key),op=operation(key,id),a=await tx.get(ar),o=await tx.get(op);
    if(!a.exists)fail('SESSION_REQUIRED',409,'Google 로그인 연결을 먼저 확인해주세요.');
    if(o.exists)fail('REQUEST_ALREADY_HANDLED',409,'이미 처리한 분석 요청입니다. 횟수를 새로고침한 뒤 다시 시도해주세요.');
    const data=releaseExpired(a.data(),now()),holds=data.creditHolds;
    if(Object.keys(holds).length>=2)fail('ANALYSIS_IN_PROGRESS',409,'진행 중인 분석이 있습니다. 잠시 기다려주세요.');
    const kind=data.freeRemaining>0?'free':data.paidRemaining>0?'paid':null;
    if(!kind)fail('NO_CREDITS',402,'남은 AI 분석 횟수가 없습니다. 수동 사정과 기록 저장은 계속 이용할 수 있어요.');
    if(kind==='free')data.freeRemaining--;else data.paidRemaining--;
    holds[id]={kind,expiresAt:now()+LEASE_MS};
    tx.set(ar,data);tx.create(op,{schemaVersion:1,accountKey:key,status:'pending',kind,fingerprint,createdAtMs:now()});
    return {key,id};
   });
  },
  async settle({key,id},success){
   return db.runTransaction(async tx=>{
    const ar=account(key),op=operation(key,id),a=await tx.get(ar),o=await tx.get(op);
    if(!a.exists||!o.exists)fail('BALANCE_UNAVAILABLE',503,'분석 횟수 처리를 확인할 수 없습니다.');
    const previous=o.data();if(previous.status!=='pending')return previous.status==='succeeded';
    const data=releaseExpired(a.data(),now()),hold=data.creditHolds[id];
    if(!hold){tx.set(ar,data);tx.set(op,{...previous,status:'expired'});return false;}
    delete data.creditHolds[id];
    if(!success){if(hold.kind==='free')data.freeRemaining++;else data.paidRemaining++;}
    checkedBalance(data);tx.set(ar,data);tx.set(op,{...previous,status:success?'succeeded':'failed',finishedAtMs:now()});return success;
   });
  }
 };
}
