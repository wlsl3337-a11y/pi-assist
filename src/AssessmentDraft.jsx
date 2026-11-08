import React,{useEffect,useRef,useState} from 'react';
import {createDraftWriter,draftKey,newDraftId,parseDraft} from './draft-store.mjs';
export {draftValue} from './draft-store.mjs';

export function AssessmentDraftGate({storage,woundId,resumeDraftId,idx,onHome,children}) {
  const key=draftKey(woundId);
  const [state,setState]=useState({phase:'loading',draft:null,error:''});
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;setState({phase:'loading',draft:null,error:''});
    (async()=>{
      try {
        const draft=parseDraft(await storage.getItem(key));
        // If final saving succeeded but draft deletion failed, do not offer it again.
        const completed=draft&&Object.values(idx.assess).some(a=>a.draftId===draft.id);
        if(active)setState({phase:draft&&!completed&&draft.id!==resumeDraftId?'choose':'ready',draft:completed?null:draft,error:''});
      }catch(error){if(active)setState({phase:'error',draft:null,error:error.message||'임시저장을 불러오지 못했습니다.'});}
    })();return()=>{active=false;};
  },[key,storage,attempt]);
  async function discard() {
    setState(s=>({...s,phase:'discarding',error:''}));
    try {await storage.removeItem(key);setState({phase:'ready',draft:null,error:''});}
    catch {setState(s=>({...s,phase:'choose',error:'기존 임시저장을 지우지 못했습니다. 잠시 후 다시 시도해주세요.'}));}
  }
  if(state.phase==='ready')return children(state.draft,key);
  return <div className="p-5 space-y-4" style={{paddingTop:24}}>
    <button type="button" className="pl-draft-button" onClick={onHome}>홈으로</button>
    {state.phase==='choose'||state.phase==='discarding'?<>
      <h2 className="text-xl font-bold">작성 중인 사정이 있어요</h2>
      <p className="text-sm text-slate-600">기기에 임시저장한 {state.draft.values.step}단계부터 이어서 작성할 수 있습니다.</p>
      <div className="flex gap-3"><button type="button" className="pl-draft-button" disabled={state.phase==='discarding'} onClick={()=>setState(s=>({...s,phase:'ready'}))}>이어서 작성</button>
        <button type="button" className="pl-draft-button" disabled={state.phase==='discarding'} onClick={discard}>임시저장 삭제 후 새로 작성</button></div>
    </>:state.phase==='error'?<><h2 className="text-xl font-bold">임시저장 확인 필요</h2><button type="button" className="pl-draft-button" onClick={()=>setAttempt(n=>n+1)}>다시 불러오기</button></>:<p role="status">임시저장 확인 중…</p>}
    {state.error&&<p role="alert" className="text-sm text-red-700">{state.error}</p>}
  </div>;
}

export function useAssessmentDraft({storage,key,initialDraft,values,meaningful}) {
  const [status,setStatus]=useState(initialDraft?'saved':'idle');
  const [,rerender]=useState(0);
  const mounted=useRef(true),latest=useRef(null),writerRef=useRef(null),timer=useRef(null);
  if(!writerRef.current){
    writerRef.current=createDraftWriter({storage,key,onStatus:s=>{if(mounted.current)setStatus(s);}});
    writerRef.current.setId(initialDraft?.id||newDraftId());
  }
  latest.current={values,meaningful};
  const serialized=JSON.stringify(values);
  const flush=()=>{clearTimeout(timer.current);const s=latest.current;return writerRef.current.write(s.values,s.meaningful);};
  useEffect(()=>{
    timer.current=setTimeout(flush,300);
    return()=>clearTimeout(timer.current);
  },[serialized,meaningful]);
  useEffect(()=>{
    mounted.current=true;
    const background=()=>{if(document.visibilityState==='hidden')flush();};
    const hide=()=>flush();
    document.addEventListener('visibilitychange',background);window.addEventListener('pagehide',hide);
    return()=>{mounted.current=false;clearTimeout(timer.current);flush();document.removeEventListener('visibilitychange',background);window.removeEventListener('pagehide',hide);};
  },[]);
  return {id:writerRef.current.id,status,flush,
    async complete(){clearTimeout(timer.current);return writerRef.current.complete();},
    restart(){writerRef.current.restart();setStatus('idle');rerender(n=>n+1);}
  };
}
export function DraftStatus({status}) {
  return <p className={'pl-draft-status '+(status==='error'?'pl-draft-error':'')} role={status==='error'?'alert':'status'}>
    {status==='error'?'임시저장에 실패했습니다. 입력 내용을 유지한 채 저장 공간을 확인해주세요.':status==='saving'?'기기에 임시저장 중…':status==='saved'?'기기에 임시저장됨 · 홈으로 나가도 이어서 작성할 수 있어요.':'작성 중인 사정은 이 기기에 임시저장됩니다.'}
  </p>;
}
