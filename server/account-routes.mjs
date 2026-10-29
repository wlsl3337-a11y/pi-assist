import {Router} from 'express';
import {initializeApp,applicationDefault,getApps} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {AccountError,createAccountService} from './account-core.mjs';

// Lazy initialization: a missing Firebase config must not crash the existing AI proxy.
let service;
function accounts() {
  if(!service) {
    const app=getApps().find(a=>a.name==='pressure-lens-accounts')||initializeApp({
      credential:applicationDefault(),projectId:'pressure-lens'
    },'pressure-lens-accounts');
    const auth=getAuth(app);
    service=createAccountService({db:getFirestore(app),verifyIdToken:(token,revoked)=>auth.verifyIdToken(token,revoked)});
  }
  return service;
}
export const accountRouter=Router();
accountRouter.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
function endpoint(action) {
  return async (req,res)=>{
    try {res.json(await accounts()[action](req.get('authorization')));}
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
