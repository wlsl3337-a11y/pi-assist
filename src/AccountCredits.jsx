import AccountPrivacy from './AccountPrivacy.jsx';
import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Capacitor,registerPlugin} from '@capacitor/core';
import {createAccountClient} from './account-client.mjs';

const nativeAuth=registerPlugin('FirebaseAuthentication');
const account=createAccountClient({
  auth:nativeAuth,isAvailable:()=>Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('FirebaseAuthentication'),
  request:(...args)=>fetch(...args),base:'https://pi-assist.onrender.com'
});

export async function getAnalysisHeaders(){
  const result=await nativeAuth.getCurrentUser();
  if(!result.user)throw Error('Google 로그인 후 AI 분석을 이용해주세요. 수동 사정은 로그인 없이 이용할 수 있어요.');
  const {token}=await nativeAuth.getIdToken();
  if(!token)throw Error('Google 로그인을 다시 확인해주세요.');
  return {Authorization:'Bearer '+token};
}
export function refreshAnalysisCredits(){return account.refresh();}
const offers=[{credits:1,price:400},{credits:5,price:1900},{credits:10,price:3500}];
function useNoBack() {}
export default function AccountCredits({useBack=useNoBack,compact=false}) {
  const [showPlans,setShowPlans]=useState(false);
  useBack(showPlans,()=>setShowPlans(false),130);
  const state=useSyncExternalStore(account.subscribe,account.getSnapshot,account.getSnapshot);
  useEffect(()=>{account.start();},[]);
  const {phase,user,balance,error}=state;
  const loading=phase==='loading'||phase==='idle';
  if(compact)return <><section className="pl-account-credit pl-account-compact" aria-label="계정 및 AI 이용 횟수">
    <div className="pl-account-compact-row">
      <strong aria-live="polite">{balance?`AI 분석 ${balance.freeRemaining+balance.paidRemaining}회 남음`:loading?'AI 이용 횟수 확인 중…':user?'AI 이용 횟수 확인 필요':'AI 분석 · 최초 1회 무료'}</strong>
      {user?<button type="button" disabled={loading} onClick={()=>balance?setShowPlans(true):account.refresh()}>{balance?'이용권 보기':'다시 확인'}</button>:
        <button type="button" disabled={loading||phase==='unsupported'} onClick={()=>account.signIn()}>Google 로그인</button>}
    </div>
    {error&&<p role="alert" className="pl-account-error">{error}</p>}
    {phase==='unsupported'&&<p className="pl-account-error">Google 로그인은 Android 앱에서 이용해주세요.</p>}
  </section>{showPlans&&<CreditPlans onClose={()=>setShowPlans(false)}/>}</>;

  return <><section className="pl-account-credit" aria-label="계정 및 AI 이용 횟수">
    <div className="pl-account-credit-main">
      <div><span className="pl-credit-eyebrow">AI 이용권</span>
        <strong aria-live="polite">{balance?`남은 AI 분석 ${balance.freeRemaining+balance.paidRemaining}회`:
          loading?'이용 횟수 확인 중…':user?'남은 횟수 확인 필요':'Google 계정으로 이용 횟수 확인'}</strong>
        <p>{balance?`무료 ${balance.freeRemaining}회 · 구매 ${balance.paidRemaining}회`:
          '수동 사정과 저장된 기록 열람은 로그인 없이 이용할 수 있어요.'}</p>
      </div>
      <button type="button" className="pl-credit-plans" onClick={()=>setShowPlans(true)}>이용권 보기</button>
    </div>
    {user&&<p className="pl-account-email">{user.email||'Google 계정 연결됨'}</p>}
    {error&&<p role="alert" className="pl-account-error">{error}</p>}
    {phase==='unsupported'?<p>Google 로그인은 Android 앱에서 이용해주세요.</p>:
      <div className="pl-account-actions">
        {user?<><button type="button" disabled={loading} onClick={()=>account.refresh()}>횟수 새로고침</button>
          <button type="button" disabled={loading} onClick={()=>account.signOut()}>로그아웃</button></>:
          <button type="button" disabled={loading} onClick={()=>account.signIn()}>Google로 로그인</button>}
      </div>}
    {!user&&<p className="pl-account-note">로그인 시 Google 계정 식별정보와 이용권 정보를 Firebase에서 처리합니다. 사정 기록은 기기에 저장하며, AI 분석을 선택하면 선택한 사진과 필요한 사정 정보가 외부 서버로 전송됩니다.</p>}
    {balance?.creditEnforcementActive===true&&<p className="pl-account-note">AI 분석 성공 시 1회 차감됩니다. 분석 실패 또는 사진 분석 불가 결과는 차감하지 않습니다. 처리 중인 횟수는 최대 2분 동안 보류될 수 있습니다. 결제는 아직 준비 중입니다.</p>}
    {balance?.creditEnforcementActive===false&&<p className="pl-account-note">이용권 기능 준비 중입니다. 현재 분석 횟수 차감과 결제는 적용되지 않습니다.</p>}
  </section><AccountPrivacy useBack={useBack} user={user} balance={balance} onDelete={()=>account.deleteAccount()}/>{showPlans&&<CreditPlans onClose={()=>setShowPlans(false)}/>}</>;
}

function CreditPlans({onClose}) {
  const ref=useRef(null);
  useEffect(()=>{
    const previous=document.activeElement;
    const dialog=ref.current;
    dialog.showModal();
    return ()=>{if(dialog.open)dialog.close();if(previous?.isConnected)previous.focus?.();};
  },[]);
  return <dialog ref={ref} className="pl-account-plans" aria-labelledby="pl-account-plans-title"
    onCancel={e=>{e.preventDefault();onClose();}}>
    <div className="pl-account-plans-head"><h2 id="pl-account-plans-title">AI 분석 이용권</h2>
      <button type="button" onClick={onClose} aria-label="이용권 안내 닫기">닫기</button></div>
    <p>처음 이용하는 계정에 AI 분석 1회 무료 체험</p>
    <p role="status">결제 준비 중입니다. 아래 버튼으로 결제되거나 횟수가 추가되지 않습니다.</p>
    {offers.map(offer=><article key={offer.credits}>
      <div><h3>{offer.credits}회권</h3><small>1회당 {offer.price/offer.credits}원</small></div>
      <strong>{offer.price.toLocaleString('ko-KR')}원</strong>
      <button type="button" disabled>결제 준비 중</button>
    </article>)}
    <p>구매한 횟수는 월이 바뀌어도 이월되며 자동 소멸하지 않습니다. 무료 체험은 계정당 최초 1회입니다.</p>
    <p>여러 상처를 일괄 분석하면 분석에 성공한 상처마다 1회씩 차감됩니다. 실패하거나 사진을 분석할 수 없는 결과는 차감하지 않습니다.</p>
    <a href="mailto:nurseinsight.support@gmail.com?subject=Pressure%20Lens%20support">이용권 문의</a>
  </dialog>;
}
