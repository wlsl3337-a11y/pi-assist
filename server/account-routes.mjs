import {expiredTechnicalRequest} from './request-retention.mjs';
import {createAccountDeletion} from './account-deletion.mjs';
import {createCreditLedger} from './credit-ledger.mjs';
import {Router} from 'express';
import {initializeApp,applicationDefault,getApps} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore,FieldPath} from 'firebase-admin/firestore';
import {AccountError,createAccountService} from './account-core.mjs';

// Lazy initialization: a missing Firebase config must not crash the existing AI proxy.
let service;
export function accounts() {
  if(!service) {
    const app=getApps().find(a=>a.name==='pressure-lens-accounts')||initializeApp({
      credential:applicationDefault(),projectId:'pressure-lens'
    },'pressure-lens-accounts');
    const auth=getAuth(app);
    const db=getFirestore(app);
    service=createAccountService({db,verifyIdToken:(token,revoked)=>auth.verifyIdToken(token,revoked)});
    service.ledger=createCreditLedger({db});
    const deleteLinkedRequests=async key=>{
      for(let batchNo=0;batchNo<100;batchNo++){
        const items=await db.collection('aiCreditRequests').where('accountKey','==',key).limit(300).get();
        if(items.empty)return;
        const batch=db.batch();for(const item of items.docs)batch.delete(item.ref);await batch.commit();
      }
      throw new AccountError('DELETION_IN_PROGRESS',503,'기록 삭제를 계속 진행하고 있습니다. 잠시 후 다시 확인해주세요.');
    };
    service.deletion=createAccountDeletion({db,auth,deleteLinkedRequests});
    let retentionCursor=null;
    const sweepRequests=async()=>{
      let query=db.collection('aiCreditRequests').orderBy(FieldPath.documentId()).limit(100);
      if(retentionCursor)query=query.startAfter(retentionCursor);
      const page=await query.get();
      const expired=page.docs.filter(item=>expiredTechnicalRequest(item.data()));
      if(expired.length){const batch=db.batch();for(const item of expired)batch.delete(item.ref);await batch.commit();}
      retentionCursor=page.size===100?page.docs[page.docs.length-1].id:null;
    };
    const resume=async()=>{
      try{
        const pending=await db.collection('aiCreditAccounts').where('deletionState','==','pending').limit(10).get();
        for(const item of pending.docs){try{await service.deletion.finish(item.id,item.data().deletionUid);}catch{console.error('[account-deletion] retry pending');}}
        await sweepRequests();
      }catch{console.error('[account-deletion] recovery unavailable');}
    };
    void resume();const worker=setInterval(()=>void resume(),60000);worker.unref?.();
  }
  return service;
}
export const accountRouter=Router();
accountRouter.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
function endpoint(action) {
  return async (req,res)=>{
    try {
      const service=accounts();
      const key=await service.authenticate(req.get('authorization'));
      await service.ledger.recover(key);
      res.json(await service[action](req.get('authorization')));
    }
    catch(error) {
      if(error instanceof AccountError)return res.status(error.status).json({code:error.code,error:error.message});
      // Do not log tokens, account identifiers, credentials, or Firestore payloads.
      console.error('[account-service] unavailable');
      res.status(503).json({code:'ACCOUNT_UNAVAILABLE',error:'계정 연결을 확인할 수 없습니다. 잠시 후 다시 시도해주세요.'});
    }
  };
}
accountRouter.post('/session',endpoint('session'));
accountRouter.get('/credits',endpoint('balance'));

// Identity always comes from verified Firebase claims; request data cannot choose another UID or account.
accountRouter.delete('/',async(req,res)=>{
 try{res.json(await accounts().deletion.remove(req.get('authorization'),req.body?.confirmation));}
 catch(error){
  if(error instanceof AccountError)return res.status(error.status).json({code:error.code,error:error.message});
  console.error('[account-deletion] retry pending');
  res.status(503).json({code:'DELETION_PENDING',error:'탈퇴 완료를 아직 확인하지 못했습니다. 다시 확인해주세요. 접수된 처리는 서버에서 계속 시도합니다.'});
 }
});
