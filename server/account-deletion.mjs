import {AccountError,identityKey,checkedBalance} from './account-core.mjs';
const error=(code,status,message)=>{throw new AccountError(code,status,message);};
export function createAccountDeletion({db,auth,now=Date.now,deleteLinkedRequests}){
 const ref=key=>db.collection('aiCreditAccounts').doc(key);
 async function claimsFor(header){
  const token=/^Bearer ([^\s]{1,16000})$/.exec(header||'')?.[1];
  if(!token)error('SIGN_IN_REQUIRED',401,'탈퇴할 Google 계정으로 로그인해주세요.');
  let claims;try{claims=await auth.verifyIdToken(token,false);}catch{error('SIGN_IN_REQUIRED',401,'다시 로그인해주세요.');}
  const key=identityKey(claims);
  if(typeof claims.uid!=='string'||!claims.uid||claims.uid.length>128)error('SIGN_IN_REQUIRED',401,'다시 로그인해주세요.');
  if(!Number.isSafeInteger(claims.auth_time)||claims.auth_time*1000>now()+30000||now()-claims.auth_time*1000>300000)
   error('RECENT_LOGIN_REQUIRED',401,'안전한 탈퇴를 위해 Google 계정을 다시 확인해주세요.');
  try{await auth.verifyIdToken(token,true);}catch{
   // Only finish an already-authorized deletion after Auth was removed. Never start a new one with a revoked token.
   let absent=false;try{await auth.getUser(claims.uid);}catch(e){absent=e.code==='auth/user-not-found';}
   if(!absent)error('SIGN_IN_REQUIRED',401,'다시 로그인해주세요.');
   const s=await ref(key).get(),v=s.exists?s.data():null;
   if(v?.deletionState!=='complete'&&!(v?.deletionState==='pending'&&v.deletionUid===claims.uid))error('SIGN_IN_REQUIRED',401,'다시 로그인해주세요.');
  }
  return {key,uid:claims.uid};
 }
 async function finish(key,uid){
  const s=await ref(key).get();if(!s.exists)error('DELETION_UNAVAILABLE',503,'탈퇴 처리를 확인하지 못했습니다.');
  if(s.data().deletionState==='complete')return {status:'deleted'};
  if(s.data().deletionState!=='pending'||s.data().deletionUid!==uid)error('DELETION_UNAVAILABLE',503,'탈퇴 처리를 확인하지 못했습니다.');
  await deleteLinkedRequests(key);
  try{await auth.deleteUser(uid);}catch(e){if(e.code!=='auth/user-not-found')throw e;}
  await db.runTransaction(async tx=>{
   const r=ref(key),a=await tx.get(r);
   if(a.exists&&a.data().deletionState==='complete')return;
   if(!a.exists||a.data().deletionState!=='pending'||a.data().deletionUid!==uid)error('DELETION_UNAVAILABLE',503,'탈퇴 처리를 확인하지 못했습니다.');
   // No email, Firebase UID, balance, timestamps or usage data survive in this minimal anti-repeat trial marker.
   // The one-way Google identity key prevents re-registering to repeatedly claim a free trial.
   tx.set(r,{schemaVersion:1,deletionState:'complete',trialUsed:true});
  });
  return {status:'deleted'};
 }
 return {
  finish,
  async remove(header,confirmation){
   if(confirmation!=='DELETE_ACCOUNT')error('CONFIRMATION_REQUIRED',400,'탈퇴 안내를 확인하고 다시 선택해주세요.');
   const {key,uid}=await claimsFor(header);
   await db.runTransaction(async tx=>{
    const r=ref(key),s=await tx.get(r);
    if(!s.exists){tx.create(r,{schemaVersion:1,deletionState:'pending',deletionUid:uid,requestedAtMs:now()});return;}
    const v=s.data();
    if(v.deletionState==='complete'){
     // A newly created Firebase UID for the same Google identity must also be removed on a fresh request.
     tx.set(r,{schemaVersion:1,deletionState:'pending',deletionUid:uid,requestedAtMs:now()});return;
    }
    if(v.deletionState==='pending'){
     if(v.deletionUid!==uid)error('DELETION_IN_PROGRESS',409,'이전 탈퇴 처리를 마무리하고 있습니다. 잠시 후 다시 확인해주세요.');
     return;
    }
    checkedBalance(v);
    const holds=Object.values(v.creditHolds||{});
    if(holds.some(h=>!h||!Number.isSafeInteger(h.expiresAt)))error('BALANCE_UNAVAILABLE',503,'이용권 정보를 확인하지 못했습니다.');
    if(holds.some(h=>h.expiresAt>now()))error('ANALYSIS_IN_PROGRESS',409,'진행 중인 분석이 있습니다. 분석을 마친 뒤 탈퇴해주세요.');
    if(v.paidRemaining>0||holds.some(h=>h.kind==='paid'))error('REFUND_REQUIRED',409,'남은 유료 이용권이 있습니다. 환불 처리가 완료되기 전에는 계정을 삭제하지 않습니다.');
    tx.set(r,{schemaVersion:1,deletionState:'pending',deletionUid:uid,requestedAtMs:now()});
   });
   return finish(key,uid);
  }
 };
}
