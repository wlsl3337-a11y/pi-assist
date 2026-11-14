const ROOT='pl:records-profile:v1:';
const META='pl:legacy-owner:v1';
export const LEGACY_OWNER_EMAIL='wlsl3337@gmail.com';
export const recordKey=k=>k==='pi:index:v1'||k.startsWith('pi:a:')||k.startsWith('pi:draft:v1:');
let bound=null;
const deletionLocks=new Set();
export function lockRecordProfile(key){if(!/^[a-f0-9]{64}$/.test(key))throw Error('삭제할 기록 보관함을 확인하지 못했습니다.');deletionLocks.add(key);}
export function unlockRecordProfile(key){deletionLocks.delete(key);}
export const recordProfileWritable=key=>!deletionLocks.has(key);
export function bindRecordProfile(profile){
 if(bound&&bound.key!==profile.key)throw Error('계정 변경 후 화면을 다시 열어주세요.');
 bound=Object.freeze({...profile});return bound;
}
export function currentRecordProfile(){if(!bound)throw Error('계정 저장소를 아직 확인하지 못했습니다.');return bound;}
export async function nativeRecordProfile(user){
 if(!user)return {key:'guest',uid:null,email:'',guest:true};
 const provider=user.providerData?.find(x=>x.providerId==='google.com');
 // Do not use the email or last active account as the record-storage key.
 const identity=provider?.uid?'google:'+provider.uid:'firebase:'+user.uid;
 if(!identity||!user.uid)throw Error('로그인 계정을 확인하지 못했습니다.');
 if(!globalThis.crypto?.subtle)throw Error('안전한 계정 식별 기능을 사용할 수 없습니다.');
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('pressure-lens:local:'+identity));
 return {key:Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join(''),uid:user.uid,email:user.email||'',guest:false};
}
export function createProfileStorage(raw,profile=currentRecordProfile()){
 if(!raw||!/^(guest|[a-f0-9]{64})$/.test(profile.key))throw Error('기록 보관함을 확인하지 못했습니다.');
 const prefix=ROOT+profile.key+':';
 const key=k=>{if(typeof k!=='string'||!recordKey(k))throw Error('지원하지 않는 기록 키입니다.');return prefix+k;};
 return Object.freeze({
  async getItem(k){return raw.getItem(key(k));},
  async setItem(k,v){
   const writable=()=>recordProfileWritable(profile.key);
   if(!writable())throw Error('회원 탈퇴 처리 중에는 기록을 저장할 수 없습니다.');
   return raw.setItem(key(k),v,writable);
  },
  async removeItem(k){return raw.removeItem(key(k));},
  async listKeys(p){if(typeof p!=='string'||!p.startsWith('pi:'))throw Error('지원하지 않는 기록 목록입니다.');return(await raw.listKeys(prefix+p)).filter(k=>k.startsWith(prefix)&&recordKey(k.slice(prefix.length))).map(k=>k.slice(prefix.length));},
  async clearLegacyBackup(){
   const meta=JSON.parse(await raw.getItem(META)||'null');
   if(meta?.status==='complete'&&meta.profileKey===profile.key){
    const keys=(await raw.listKeys('pi:')).filter(recordKey);
    for(const k of keys.filter(k=>k!=='pi:index:v1'))await raw.removeItem(k);
    await raw.removeItem('pi:index:v1');
    // Keep the owner mapping so another account cannot claim remnants after a partial failure.
   }
  },
  profileKey:profile.key,guest:profile.guest===true
 });
}
export async function inspectLegacy(raw,profile){
 const meta=JSON.parse(await raw.getItem(META)||'null');
 if(meta&&(!['copying','complete'].includes(meta.status)||typeof meta.profileKey!=='string'))throw Error('기존 기록 이전 상태를 확인하지 못했습니다.');
 if(meta?.status==='complete')return {needed:false};
 const keys=(await raw.listKeys('pi:')).filter(recordKey);
 if(!keys.length)return {needed:false};
 const allowed=!profile.guest&&profile.email.trim().toLowerCase()===LEGACY_OWNER_EMAIL&&(!meta||meta.profileKey===profile.key);
 return {needed:allowed,protected:!allowed,count:keys.length};
}
export async function migrateLegacy(raw,profile,confirmed){
 if(confirmed!==true)throw Error('기존 기록 소유 계정을 먼저 확인해주세요.');
 const inspection=await inspectLegacy(raw,profile);
 if(!inspection.needed){if(inspection.protected)throw Error('기존 기록은 이전에 사용하던 계정에서만 연결할 수 있습니다.');return;}
 const target=createProfileStorage(raw,profile),keys=(await raw.listKeys('pi:')).filter(recordKey);
 const entries=[];
 // Read and validate everything before writing; never replace another account's or an existing different record.
 for(const k of keys){const value=await raw.getItem(k);if(typeof value!=='string')throw Error('기존 기록을 읽지 못했습니다. 원본은 보존했습니다.');JSON.parse(value);const existing=await target.getItem(k);if(existing!==null&&existing!==value)throw Error('현재 계정에 다른 기록이 있어 자동 이전하지 않았습니다. 기존 기록은 보존했습니다.');entries.push([k,value]);}
 await raw.setItem(META,JSON.stringify({status:'copying',profileKey:profile.key}));
 for(const [k,v]of entries.filter(([k])=>k!=='pi:index:v1')){await target.setItem(k,v);if(await target.getItem(k)!==v)throw Error('기록 이전을 검증하지 못했습니다. 원본은 보존했습니다.');}
 const index=entries.find(([k])=>k==='pi:index:v1');
 if(index){await target.setItem(...index);if(await target.getItem(index[0])!==index[1])throw Error('기록 목록 이전을 검증하지 못했습니다.');}
 await raw.setItem(META,JSON.stringify({status:'complete',profileKey:profile.key}));
 // Original records remain as a hidden local recovery copy. Only their owner may clear this backup via explicit record deletion.
}
