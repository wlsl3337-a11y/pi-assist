import {hasDeletionNotice,dismissDeletionNotice} from './deletion-feedback.mjs';
import React,{useEffect,useState} from 'react';
import {Capacitor,registerPlugin} from '@capacitor/core';
import {bindRecordProfile,nativeRecordProfile,inspectLegacy,migrateLegacy,LEGACY_OWNER_EMAIL} from './profile-storage.mjs';
import {createRawRecordStorage} from './profile-raw-storage.mjs';
import './profile.css';
const auth=registerPlugin('FirebaseAuthentication');
const available=()=>Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('FirebaseAuthentication');
let initialUid;
export async function verifyRecordIdentity(user){
 if(initialUid===undefined)return;
 if((user?.uid||null)!==initialUid){
  window.dispatchEvent(new Event('pressure-profile-changing'));
  window.location.reload();
  // Never continue publishing a new account into the old record tree while navigation is pending.
  await new Promise(()=>{});
 }
}
export default function ProfileApp(){
 const [state,setState]=useState({phase:'loading'}),[retry,setRetry]=useState(0),[confirmed,setConfirmed]=useState(false);
 useEffect(()=>{let active=true,handle;initialUid=undefined;setState({phase:'loading'});
  const onChange=()=>{if(active)setState({phase:'loading'});};window.addEventListener('pressure-profile-changing',onChange);
  async function prepare(){try{
   if(hasDeletionNotice()){if(active)setState({phase:'deleted'});return;}
   const user=available()?(await auth.getCurrentUser()).user:null;
   const profile=await nativeRecordProfile(user);initialUid=user?.uid||null;
   if(!globalThis.indexedDB)throw Error('영구 기록 저장소를 사용할 수 없습니다. 기록을 보호하기 위해 열기를 중단했습니다.');
   const raw=createRawRecordStorage();const legacy=await inspectLegacy(raw,profile);
   if(available()){const latest=(await auth.getCurrentUser()).user;if((latest?.uid||null)!==(user?.uid||null)){window.location.reload();return;}}
   bindRecordProfile(profile);
   if(!active)return;
   if(profile.guest){setState({phase:'guest',profile});return;}
   if(legacy.needed){setState({phase:'migrate',profile,raw});return;}
   await launch(profile);
  }catch(e){if(active)setState({phase:'error',error:e.message});}}
  async function launch(profile){const app=await import('./App.jsx');if(active)setState({phase:'ready',App:app.default,profile});}
  prepare();
  const recheck=async()=>{try{if(available())await verifyRecordIdentity((await auth.getCurrentUser()).user);}catch{if(active)setState({phase:'error',error:'계정 상태를 확인하지 못했습니다. 다시 열어주세요.'});}};
  const visible=()=>{if(document.visibilityState==='visible')recheck();};window.addEventListener('focus',recheck);document.addEventListener('visibilitychange',visible);
  if(available())auth.addListener('authStateChange',e=>{void verifyRecordIdentity(e.user);}).then(h=>{if(active)handle=h;else h.remove();}).catch(()=>{});
  return()=>{active=false;handle?.remove();window.removeEventListener('pressure-profile-changing',onChange);window.removeEventListener('focus',recheck);document.removeEventListener('visibilitychange',visible);};
 },[retry]);
 async function connect(){if(!confirmed)return;const previous=state;setState({...previous,phase:'copying',error:''});try{await migrateLegacy(previous.raw,previous.profile,true);window.location.reload();}catch(e){setState({...previous,phase:'migrate',error:e.message});}}
 async function switchAccount(){try{await auth.signOut();window.location.reload();}catch{setState(s=>({...s,error:'로그아웃하지 못했습니다. 다시 시도해주세요.'}));}}
 async function guestContinue(){try{const app=await import('./App.jsx');setState({phase:'ready',App:app.default,profile:state.profile});}catch(e){setState({phase:'error',error:e.message});}}
 async function signIn(){try{await auth.signInWithGoogle();window.location.reload();}catch{setState(s=>({...s,error:'로그인을 완료하지 못했습니다. 다시 시도해주세요.'}));}}
 if(state.phase==='deleted')return <main className="pl-profile-gate"><h1>회원 탈퇴가 완료되었습니다</h1><p role="status">Pressure Lens의 앱 로그인 계정과 서버 이용권 정보, 이 계정에 연결된 분석 요청 이력의 삭제가 완료되었습니다.</p><p>Google 계정 자체는 삭제되지 않았습니다. 기기에 저장된 사정 기록과 사진도 자동으로 삭제되지 않습니다.</p><p>무료 체험 중복 지급을 막는 최소 정보는 남습니다. 계정에 연결되지 않은 과거 기술 처리 이력과 외부 AI 제공업체의 데이터는 별도 보관 안내가 적용됩니다.</p><button onClick={()=>{dismissDeletionNotice();window.location.reload();}}>확인</button></main>;
 if(state.phase==='guest')return <main className="pl-profile-gate"><h1>기록 보관함 선택</h1><p>로그인하면 해당 Google 계정의 기록만 표시합니다. 계정을 바꾸거나 로그아웃하면 그 계정의 기록은 숨겨집니다.</p><button disabled={!available()} onClick={signIn}>Google 계정으로 로그인</button><p>비로그인 기록은 이 기기의 공용 보관함에 저장됩니다. 다른 계정의 기록은 표시하지 않습니다. 비로그인 상태에서 작성하다 로그인하면 보관함이 바뀌므로, AI 분석을 사용할 때는 먼저 로그인해주세요.</p><button onClick={guestContinue}>비로그인 보관함으로 계속</button><p>업데이트 전 기존 기록은 이전에 사용하던 계정에서 연결할 수 있습니다.</p>{state.error&&<p role="alert">{state.error}</p>}</main>;
 if(state.phase==='ready'){const App=state.App;return <App/>;}
 if(state.phase==='migrate'||state.phase==='copying')return <main className="pl-profile-gate"><h1>기존 기록을 내 계정에 연결</h1><p>업데이트 전 이 기기에 저장한 기록이 있습니다. 현재 로그인 계정은 아래와 같습니다.</p><strong className="pl-profile-email">{state.profile.email}</strong><p>이전에 작성한 개인 기록의 소유 계정인지 확인해주세요. 사진·사정 기록·임시저장을 함께 연결하며 원본도 기기에 보존합니다. 다른 계정에는 공개하지 않습니다.</p><label><input type="checkbox" checked={confirmed} disabled={state.phase==='copying'} onChange={e=>setConfirmed(e.target.checked)}/>기존 기록을 작성한 계정이 맞습니다.</label><button disabled={!confirmed||state.phase==='copying'} onClick={connect}>{state.phase==='copying'?'기록 연결 중…':'기존 기록을 이 계정에 연결'}</button><button disabled={state.phase==='copying'} onClick={switchAccount}>계정을 바꾸기 위해 로그아웃</button>{state.error&&<p role="alert">{state.error}</p>}</main>;
 if(state.phase==='error')return <main className="pl-profile-gate"><h1>기록 보관함 확인 필요</h1><p role="alert">{state.error}</p><p>기존 기록은 삭제하지 않았습니다.</p><button onClick={()=>window.location.reload()}>다시 확인</button></main>;
 return <main className="pl-profile-gate" role="status"><h1>기록 보관함 확인 중</h1><p>로그인 계정에 맞는 기록을 준비하고 있어요.</p></main>;
}
