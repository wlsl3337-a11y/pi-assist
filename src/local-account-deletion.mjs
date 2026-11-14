import {currentRecordProfile,nativeRecordProfile,lockRecordProfile,unlockRecordProfile} from './profile-storage.mjs';
import {createRawRecordStorage} from './profile-raw-storage.mjs';
const KEY='pl:pending-local-deletion:v1';
const unavailable=()=>Error('기기 삭제 준비 정보를 저장하지 못했습니다. 탈퇴를 시작하지 않았습니다.');
export function createLocalDeletion({marker=globalThis.localStorage,raw=createRawRecordStorage(),getBound=currentRecordProfile,identify=nativeRecordProfile,lock=lockRecordProfile,unlock=unlockRecordProfile}={}){
 function read(){const value=marker.getItem(KEY);if(!value)return null;const p=JSON.parse(value);if(p?.version!==1||!['prepared','confirmed'].includes(p.phase)||!/^[a-f0-9]{64}$/.test(p.key))throw Error('기기 삭제 준비 정보를 확인하지 못했습니다.');return p;}
 function save(p){marker.setItem(KEY,JSON.stringify(p));if(marker.getItem(KEY)!==JSON.stringify(p))throw unavailable();}
 async function prepare(user){
  const bound=getBound(),profile=await identify(user);
  if(bound.guest||profile.guest||!user?.uid||bound.uid!==user.uid||bound.key!==profile.key)throw Error('탈퇴할 계정의 기록 보관함이 다릅니다. 다시 로그인해주세요.');
  const existing=read();if(existing)throw Error('이전 탈퇴의 기기 정리가 남아 있습니다. 앱을 다시 열어주세요.');
  const job={version:1,phase:'prepared',key:profile.key};
  try{save(job);}catch{throw unavailable();}
  lock(job.key);return job;
 }
 async function complete(job){
  const current=read();if(!current||current.key!==job.key)throw Error('기기 삭제 준비 정보를 확인하지 못했습니다.');
  save({...current,phase:'confirmed'});
  await raw.purgeRecordProfile(job.key);
  marker.removeItem(KEY);
  // Keep this session's fence closed; queued saves must never recreate deleted records.
 }
 function cancel(job){if(!job)return;const current=read();if(current?.phase==='prepared'&&current.key===job.key){marker.removeItem(KEY);unlock(job.key);}}
 async function resume(){const job=read();if(!job)return false;if(job.phase==='prepared'){marker.removeItem(KEY);unlock(job.key);return false;}lock(job.key);await raw.purgeRecordProfile(job.key);marker.removeItem(KEY);return true;}
 return {prepare,complete,cancel,resume};
}
let instance;
const local=()=>instance||(instance=createLocalDeletion());
export const localAccountDeletion={prepare:user=>local().prepare(user),complete:job=>local().complete(job),cancel:job=>local().cancel(job),resume:()=>local().resume()};
