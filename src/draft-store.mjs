export const draftKey = woundId => 'pi:draft:v1:'+(woundId?'follow:'+encodeURIComponent(woundId):'new');
export const newDraftId = () => globalThis.crypto?.randomUUID?.() || Date.now()+'-'+Math.random().toString(36).slice(2);
export function parseDraft(raw) {
  if(raw==null)return null;
  const d=JSON.parse(raw);
  if(d?.version!==1||typeof d.id!=='string'||!d.values||typeof d.values!=='object'||
    !Number.isInteger(d.values.step)||d.values.step<1||d.values.step>6||typeof d.values.pid!=='string')
    throw Error('임시저장 내용을 읽지 못했습니다. 기존 내용을 덮어쓰지 않았습니다.');
  return d;
}
export function draftValue(draft,name,fallback) {
  const value=draft?.values?.[name];
  if(value===undefined)return fallback();
  // Work in progress is never restored as an active AI/network request.
  if((name==='aiStatus'||name==='batchStatus')&&value==='loading')return 'idle';
  if(name==='autoRulerStatus'&&value==='detecting')return 'idle';
  return value;
}
export function createDraftWriter({storage,key,onStatus=()=>{}}) {
  let tail=Promise.resolve(),closed=false,id=newDraftId();
  return {
    setId(value){id=value;},get id(){return id;},
    write(values,meaningful=true) {
      if(closed||!meaningful)return tail.then(()=>true);
      const payload=JSON.stringify({version:1,id,updatedAt:Date.now(),values});
      onStatus('saving');
      const task=tail.then(async()=>{
        try {await storage.setItem(key,payload);onStatus('saved');return true;}
        catch {onStatus('error');return false;}
      });
      tail=task;return task;
    },
    async complete(){closed=true;await tail;try{await storage.removeItem(key);return true;}catch{return false;}},
    restart(){id=newDraftId();closed=false;}
  };
}
