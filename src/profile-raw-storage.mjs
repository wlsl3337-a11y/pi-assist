// Same IndexedDB database and store as existing builds, without reading or exposing record contents at login.
export function createRawRecordStorage(){
 const DB='pi-assist',STORE='kv';let dbp;
 const open=()=>dbp||(dbp=new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>{dbp=null;reject(r.error);};}));
 const tx=async(mode,fn)=>{const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode),r=fn(t.objectStore(STORE));t.oncomplete=()=>resolve(r.result);t.onabort=t.onerror=()=>reject(t.error||Error('기기 기록 저장소에 접근할 수 없습니다.'));});};
 return {getItem:async k=>(await tx('readonly',s=>s.get(k)))??null,setItem:(k,v)=>tx('readwrite',s=>s.put(v,k)),removeItem:k=>tx('readwrite',s=>s.delete(k)),listKeys:async p=>(await tx('readonly',s=>s.getAllKeys())).filter(k=>typeof k==='string'&&k.startsWith(p))};
}
