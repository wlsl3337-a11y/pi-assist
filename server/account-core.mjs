import {createHash} from 'node:crypto';

export class AccountError extends Error {
  constructor(code, status, message) {super(message);this.code=code;this.status=status;}
}

// Use Google's stable subject instead of a reinstall ID or a deletable Firebase UID.
// A Firebase-account recreation must not mint another trial or discard purchases.
export function identityKey(claims) {
  const google = claims?.firebase?.identities?.['google.com'];
  if (claims?.firebase?.sign_in_provider !== 'google.com' || claims.email_verified !== true ||
      !Array.isArray(google) || google.length !== 1 || typeof google[0] !== 'string' || !google[0]) {
    throw new AccountError('GOOGLE_REQUIRED',403,'인증된 Google 계정으로 로그인해주세요.');
  }
  return createHash('sha256').update('pressure-lens:google:'+google[0]).digest('hex');
}

export function checkedBalance(record) {
  if (record?.schemaVersion !== 1 || ![record.freeRemaining,record.paidRemaining].every(n=>Number.isSafeInteger(n)&&n>=0) ||
      record.freeRemaining > 1 || !Number.isSafeInteger(record.freeRemaining+record.paidRemaining)) {
    throw new AccountError('BALANCE_UNAVAILABLE',503,'이용 횟수를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.');
  }
  return {status:'verified',freeRemaining:record.freeRemaining,paidRemaining:record.paidRemaining,
    purchasesEnabled:false,creditEnforcementActive:false};
}

export function createAccountService({db,verifyIdToken,now=Date.now}) {
  async function authenticate(header) {
    const match=/^Bearer ([^\s]{1,16000})$/.exec(header||'');
    if(!match)throw new AccountError('SIGN_IN_REQUIRED',401,'Google 로그인 후 이용 횟수를 확인해주세요.');
    let claims;
    try { claims=await verifyIdToken(match[1],true); }
    catch {throw new AccountError('SIGN_IN_REQUIRED',401,'로그인이 만료되었습니다. 다시 로그인해주세요.');}
    return identityKey(claims);
  }
  return {
    async session(header) {
      const key=await authenticate(header);
      const ref=db.collection('aiCreditAccounts').doc(key);
      return db.runTransaction(async tx=>{
        const snapshot=await tx.get(ref);
        if(snapshot.exists)return checkedBalance(snapshot.data());
        const initial={schemaVersion:1,freeRemaining:1,paidRemaining:0,createdAtMs:now()};
        tx.create(ref,initial);
        return checkedBalance(initial);
      });
    },
    async balance(header) {
      const key=await authenticate(header);
      const snapshot=await db.collection('aiCreditAccounts').doc(key).get();
      if(!snapshot.exists)throw new AccountError('SESSION_REQUIRED',409,'로그인 연결을 다시 확인해주세요.');
      return checkedBalance(snapshot.data());
    }
  };
}
