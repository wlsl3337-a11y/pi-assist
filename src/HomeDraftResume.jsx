import React,{useEffect,useState} from 'react';
import {parseDraft} from './draft-store.mjs';
import './home-draft.css';
export default function HomeDraftResume({storage,idx,go}) {
 const [drafts,setDrafts]=useState([]),[error,setError]=useState(false);
 useEffect(()=>{let active=true;
  async function refresh(){
   try{
    const keys=await storage.listKeys('pi:draft:v1:');
    const done=new Set(Object.values(idx.assess||{}).map(a=>a.draftId).filter(Boolean));
    const entries=await Promise.all(keys.map(async key=>{
     try {const draft=parseDraft(await storage.getItem(key));return draft&&!done.has(draft.id)?{key,draft}:null;}
     catch{return {invalid:true};}
    }));
    if(active){setDrafts(entries.filter(x=>x&&!x.invalid).sort((a,b)=>(b.draft.updatedAt||0)-(a.draft.updatedAt||0)));setError(entries.some(x=>x?.invalid));}
   }catch{if(active)setError(true);}
  }
  refresh();const visible=()=>{if(document.visibilityState==='visible')refresh();};
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);};
 },[storage,idx]);
 const entry=drafts[0];
 if(!entry)return error?<p className="pl-home-draft pl-home-draft-warning" role="status">임시저장을 확인하지 못했어요. 새 사정에서 확인해주세요.</p>:null;
 const {values,id}=entry.draft;
 const followWoundId=entry.key.startsWith('pi:draft:v1:follow:')?decodeURIComponent(entry.key.slice('pi:draft:v1:follow:'.length)):undefined;
 return <button type="button" className="pl-home-draft" onClick={()=>go({name:'new',followWoundId,resumeDraftId:id})} aria-label="작성 중인 사정 이어서 작성">
  <span className="pl-home-draft-copy"><strong>작성 중인 사정{drafts.length>1?' '+drafts.length+'건':''}</strong><small>{['','환자 정보 입력 중','사진 선택 중','크기 측정 중','AI 분석 화면 작성 중','상처 소견 입력 중','요약 확인 중'][values.step] || '사정 작성 중'}</small></span>
  <span className="pl-home-draft-action">이어서 작성 <span aria-hidden="true">›</span></span>
 </button>;
}
