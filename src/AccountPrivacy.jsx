import React,{useEffect,useRef,useState} from 'react';
import './account-privacy.css';
const SUPPORT='nurseinsight.support@gmail.com';
function useNoBack(){}
export default function AccountPrivacy({useBack=useNoBack,user=null,balance=null,onDelete}){
  const [panel,setPanel]=useState(null),[busy,setBusy]=useState(false);
  useBack(Boolean(panel),()=>{if(!busy)setPanel(null);},140);
  return <section className="pl-privacy-tools" aria-label="계정 및 개인정보 관리">
    <h3>계정 · 개인정보 관리</h3>
    <p>로그아웃, 기기 기록 삭제, 회원 탈퇴는 서로 다른 기능입니다.</p>
    <div className="pl-privacy-actions"><button type="button" onClick={()=>setPanel('delete')}>회원 탈퇴</button><button type="button" onClick={()=>setPanel('privacy')}>개인정보 처리 안내</button></div>
    {panel&&<PrivacyDialog kind={panel} user={user} balance={balance} onDelete={onDelete} onBusy={setBusy} onClose={()=>setPanel(null)}/>}
  </section>;
}
function PrivacyDialog({kind,user,balance,onDelete,onBusy,onClose}){
  const ref=useRef(null),[phase,setPhase]=useState('ready'),[agreed,setAgreed]=useState(false),[message,setMessage]=useState('');
  const pending=phase==='deleting',done=phase==='done';
  useEffect(()=>{const before=document.activeElement;const d=ref.current;d.showModal();return()=>{if(d.open)d.close();if(before?.isConnected)before.focus?.();};},[]);
  const deletion=kind==='delete';
  async function remove(){
    if(!agreed||pending||!user)return;
    setPhase('deleting');onBusy(true);setMessage('');
    try{const result=await onDelete();setPhase('done');setMessage(result.signoutFailed?'서버 계정 탈퇴는 완료됐습니다. 기기의 로그인 상태를 정리하려면 앱을 다시 열어주세요.':'탈퇴가 완료됐습니다.');}
    catch(e){setPhase('ready');setMessage(e.message||'탈퇴 완료를 확인하지 못했습니다.');}
    finally{onBusy(false);}
  }
  return <dialog ref={ref} className="pl-privacy-dialog" aria-labelledby="pl-privacy-title" onCancel={e=>{e.preventDefault();if(!pending)onClose();}}>
    <div className="pl-privacy-head"><h2 id="pl-privacy-title">{deletion?'회원 탈퇴':'개인정보 처리 안내'}</h2><button type="button" disabled={pending} onClick={onClose} aria-label="계정 및 개인정보 안내 닫기">닫기</button></div>
    {deletion?(done?<><p role="status">{message}</p><p>Google 계정 자체는 삭제되지 않습니다. 기기에 저장된 사정 기록은 별도이며, 필요하면 정보·설정에서 삭제할 수 있습니다.</p><button type="button" onClick={onClose}>확인</button></>:<>
      <p>운영자의 메일 승인 없이 앱에서 직접 탈퇴할 수 있습니다. 마지막 단계에서 탈퇴할 Google 계정을 다시 확인합니다.</p>
      <p className="pl-privacy-address">{user?.email||'탈퇴하려면 먼저 Google로 로그인해주세요.'}</p>
      <h3>삭제되는 정보</h3><ul><li>Firebase 앱 로그인 계정</li><li>서버의 이용권 잔액과 계정 정보</li><li>서버에서 이 계정과 연결할 수 있는 분석 요청 이력</li></ul>
      <p>재가입을 반복해 무료 체험을 받는 것을 방지하기 위한 최소 계정 해시는 남습니다. 재가입해도 무료 체험이 다시 지급되지 않습니다. 사진·프롬프트·분석 결과 본문은 이 정보에 포함되지 않습니다. 계정과 직접 연결할 수 없는 과거 기술 처리 이력은 작성일로부터 30일이 지나면 자동 정리 대상이 됩니다. 서버가 중지된 동안에는 정리가 지연될 수 있습니다.</p>
      <h3>남은 이용권</h3><p>{balance?`무료 ${balance.freeRemaining}회 · 유료 ${balance.paidRemaining}회`:'서버에서 잔여 횟수를 다시 확인합니다.'}</p>
      <p>탈퇴 시 자동 환불은 이루어지지 않습니다. 법령 및 Google Play 정책에 따른 환불 권리는 별도로 적용됩니다. 현재 유료 결제는 준비 중이며, 유료 잔액이 확인되면 정산 기능이 준비되기 전까지 탈퇴를 완료하지 않습니다.</p>
      <h3>기기 기록은 자동으로 지우지 않습니다</h3><p>환자·상처 기록과 사진, 임시저장은 기기에 저장됩니다. 로그인 계정과 별도로 관리되며, 필요한 기록을 보관한 뒤 정보·설정에서 기기 데이터를 삭제할 수 있습니다. 외부 AI 제공업체의 처리 데이터도 이번 탈퇴로 즉시 삭제되는 것은 아닙니다.</p>
      <p>진행 중인 분석이 있으면 분석을 마친 뒤 탈퇴할 수 있습니다. 탈퇴한 계정은 복구할 수 없습니다.</p>
      <label className="pl-delete-agreement"><input type="checkbox" checked={agreed} disabled={pending} onChange={e=>setAgreed(e.target.checked)}/><span>삭제 범위와 남는 정보를 확인했고, 이 계정에서 탈퇴하겠습니다.</span></label>
      {message&&<p role="alert">{message}</p>}
      <button className="pl-delete-primary" type="button" disabled={!agreed||pending||!user||!onDelete} onClick={remove}>{pending?'본인 확인 및 탈퇴 처리 중…':'Google 계정 확인 후 탈퇴'}</button>
    </>):<>
      <p><strong>널스담</strong><br/>문의: {SUPPORT}</p>
      <h3>기기에 보관되는 사정 기록</h3><p>입력한 환자 구분 정보, 상처 부위·사진·측정값·소견·메모 및 임시저장은 현재 기기에 저장됩니다. 기관 지침에 따라 환자 식별정보를 최소화해 주세요.</p>
      <h3>Google 로그인과 이용권</h3><p>Firebase Authentication으로 Google 로그인 정보를 확인합니다. 서버는 Google 계정 식별정보를 해시한 값과 AI 이용 횟수·요청 처리 상태 등을 Firestore에 저장합니다. 탈퇴하면 앱 로그인 계정과 잔액·연결된 이력을 삭제하고, 무료 체험 중복 지급 방지를 위한 최소 해시 정보는 별도로 유지합니다.</p>
      <h3>AI 분석을 선택할 때</h3><p>선택한 사진과 필요한 사정 정보는 Render 운영 서버를 거쳐 Anthropic API로 전송됩니다. 전송 전 안내에서 동의하지 않으면 수동 사정을 이용할 수 있습니다. 외부 서비스의 보관 데이터는 기기 기록 삭제나 앱 계정 탈퇴만으로 함께 지워지지 않습니다.</p>
      <h3>문의 및 권리 행사</h3><p>외부 처리 데이터의 열람·삭제 등은 문의 이메일로 요청할 수 있습니다. 실제 보유 여부와 제공업체 절차를 확인해 안내합니다. 비밀번호, 인증번호 및 환자 식별정보는 보내지 마세요.</p>
      <p className="pl-privacy-review">출시 준비 중인 처리 안내입니다. 정식 개인정보처리방침의 보유기간·국외 이전·처리업체 세부사항은 출시 전에 확정해야 합니다.</p>
    </>}
  </dialog>;
}
