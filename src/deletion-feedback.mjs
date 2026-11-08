const KEY='pl:account-deletion-confirmed:v1';
export function rememberDeletion(){
 try{globalThis.sessionStorage.setItem(KEY,'confirmed');return;}catch{}
 globalThis.alert?.('회원 탈퇴가 완료되었습니다. Google 계정 자체와 기기에 저장된 기록은 삭제되지 않았습니다.');
}
export function hasDeletionNotice(){try{return globalThis.sessionStorage.getItem(KEY)==='confirmed';}catch{return false;}}
export function dismissDeletionNotice(){try{globalThis.sessionStorage.removeItem(KEY);}catch{}}
export function deletionError(error){
 if(error?.name==='AbortError')return '서버 응답이 지연되어 탈퇴 완료를 확인하지 못했습니다. 잠시 후 다시 확인해주세요.';
 if(/cancel|canceled|cancelled|12501/i.test(String(error?.code||'')+' '+String(error?.message||'')))return 'Google 계정 확인을 취소했습니다. 탈퇴는 진행되지 않았습니다.';
 const message=error?.message||'';
 return /[가-힣]/.test(message)?message:'본인 확인 또는 탈퇴 처리를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.';
}
