// Same IndexedDB database and store as existing builds.
const recordKey=k=>k==='pi:index:v1'||k.startsWith('pi:a:')||k.startsWith('pi:draft:v1:');
export function createRawRecordStorage(){
 const DB='pi-assist',STORE='kv';let dbp;
 const open=()=>dbp||(dbp=new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>{dbp=null;reject(r.error);};}));
 const tx=async(mode,fn)=>{const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode);let request;try{request=fn(t.objectStore(STORE));}catch(e){t.abort();reject(e);return;}t.oncomplete=()=>resolve(request?.result);t.onabort=t.onerror=()=>reject(t.error||Error('기기 기록 저장소에 접근할 수 없습니다.'));});};
 return {
  getItem:async k=>(await tx('readonly',s=>s.get(k)))??null,
  setItem:(k,v,writable)=>tx('readwrite',s=>{if(writable&&!writable())throw Error('회원 탈퇴 처리 중에는 기록을 저장할 수 없습니다.');return s.put(v,k);}),
  removeItem:k=>tx('readwrite',s=>s.delete(k)),
  listKeys:async p=>(await tx('readonly',s=>s.getAllKeys())).filter(k=>typeof k==='string'&&k.startsWith(p)),
  async purgeRecordProfile(profileKey){
   if(!/^[a-f0-9]{64}$/.test(profileKey))throw Error('삭제할 기록 보관함을 확인하지 못했습니다.');
   const prefix='pl:records-profile:v1:'+profileKey+':';
   const db=await open();
   return new Promise((resolve,reject)=>{
    const t=db.transaction(STORE,'readwrite'),s=t.objectStore(STORE);
    const keys=s.getAllKeys(),meta=s.get('pl:legacy-owner:v1');let ready=0;
    const erase=()=>{if(++ready!==2)return;let owner;try{owner=JSON.parse(meta.result||'null');}catch{t.abort();return;}
     const ownsLegacy=['copying','complete'].includes(owner?.status)&&owner.profileKey===profileKey;
     for(const k of keys.result){if(typeof k==='string'&&(k.startsWith(prefix)||(ownsLegacy&&recordKey(k))))s.delete(k);}
     if(ownsLegacy)s.delete('pl:legacy-owner:v1');
    };
    keys.onsuccess=erase;meta.onsuccess=erase;
    t.oncomplete=()=>resolve();
    t.onabort=t.onerror=()=>reject(t.error||Error('기기 기록 삭제를 완료하지 못했습니다.'));
   });
  }
 };
}
