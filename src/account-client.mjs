// Tokens stay in the native Firebase SDK. Only the current request gets a token;
// neither tokens nor credit balances are persisted in browser storage.
export function createAccountClient({auth,isAvailable,request,base}) {
  let state={phase:'idle',user:null,balance:null,error:''};
  let generation=0,started=false,busy=false;
  const listeners=new Set();
  const publish=patch=>{state={...state,...patch};listeners.forEach(fn=>fn());};
  const checked=data=>{
    if(data?.status!=='verified'||![data.freeRemaining,data.paidRemaining].every(n=>Number.isSafeInteger(n)&&n>=0)||
       !Number.isSafeInteger(data.freeRemaining+data.paidRemaining))throw Error('이용 횟수를 확인할 수 없습니다.');
    return data;
  };
  async function load(user,method,ticket) {
    const {token}=await auth.getIdToken();
    if(ticket!==generation)return;
    if(!token)throw Error('다시 로그인해주세요.');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),65000);
    try {
      const res=await request(base+'/api/account/'+(method==='POST'?'session':'credits'),{
        method,headers:{Authorization:'Bearer '+token},signal:controller.signal,cache:'no-store'
      });
      const data=await res.json().catch(()=>null);
      if(ticket!==generation)return;
      if(!res.ok)throw Error(res.status===401?'로그인이 만료되었습니다. 다시 로그인해주세요.':
        '이용 횟수를 불러오지 못했습니다. 잠시 후 다시 확인해주세요.');
      publish({phase:'ready',user,balance:checked(data),error:''});
    } finally {clearTimeout(timer);}
  }
  async function run(action) {
    if(busy)return;
    if(!isAvailable()){publish({phase:'unsupported',error:''});return;}
    busy=true;const ticket=++generation;
    publish({phase:'loading',balance:null,error:''});
    try {
      if(action==='signout') {
        await auth.signOut();
        if(ticket===generation)publish({phase:'signedout',user:null,balance:null,error:''});
        return;
      }
      const result=action==='signin'?await auth.signInWithGoogle():await auth.getCurrentUser();
      if(ticket!==generation)return;
      if(!result.user){publish({phase:'signedout',user:null,balance:null,error:''});return;}
      publish({user:{uid:result.user.uid,email:result.user.email||''}});
      await load(state.user,action==='refresh'?'GET':'POST',ticket);
    } catch(error) {
      if(ticket===generation)publish({phase:'error',balance:null,
        error:error.name==='AbortError'?'서버 연결이 지연됩니다. 잠시 후 다시 확인해주세요.':
          (error.message?.startsWith('이용 횟수')||error.message?.startsWith('로그인이 만료')?error.message:
          '로그인을 완료하지 못했습니다. 취소했다면 다시 로그인할 수 있어요.')});
    } finally {if(ticket===generation)busy=false;}
  }
  async function deleteAccount(){
    if(busy)throw Error('진행 중인 계정 처리를 마친 뒤 다시 시도해주세요.');
    if(!isAvailable())throw Error('Android 앱에서 Google 계정을 확인해주세요.');
    const original=state.user?.uid;
    if(!original)throw Error('탈퇴할 계정으로 먼저 로그인해주세요.');
    busy=true;const ticket=++generation;
    publish({phase:'loading',error:''});
    try{
      const verified=await auth.signInWithGoogle();
      if(!verified.user||verified.user.uid!==original)throw Error('탈퇴할 계정과 다른 Google 계정을 선택했습니다. 계정을 확인한 뒤 다시 시도해주세요.');
      const {token}=await auth.getIdToken({forceRefresh:true});
      if(!token)throw Error('본인 확인을 완료하지 못했습니다.');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);
      let response,data;
      try{
        response=await request(base+'/api/account/',{method:'DELETE',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({confirmation:'DELETE_ACCOUNT'}),cache:'no-store',signal:controller.signal});
        data=await response.json().catch(()=>null);
      }finally{clearTimeout(timer);}
      if(!response.ok||data?.status!=='deleted'){
        const known=['RECENT_LOGIN_REQUIRED','ANALYSIS_IN_PROGRESS','REFUND_REQUIRED','DELETION_IN_PROGRESS','DELETION_PENDING'];
        throw Error(known.includes(data?.code)?data.error:response.status===404?'서버 업데이트가 아직 반영되지 않았습니다. 탈퇴는 완료되지 않았습니다.':'탈퇴 완료를 확인하지 못했습니다. 잠시 후 다시 확인해주세요.');
      }
      let signoutFailed=false;try{await auth.signOut();}catch{signoutFailed=true;}
      if(ticket===generation)publish({phase:'signedout',user:null,balance:null,error:''});
      return {status:'deleted',signoutFailed};
    }catch(error){
      let current;try{current=await auth.getCurrentUser();}catch{}
      if(ticket===generation)publish({phase:'error',user:current?.user?{uid:current.user.uid,email:current.user.email||''}:null,balance:null,error:''});
      throw Error(error.name==='AbortError'?'서버 응답이 지연되어 탈퇴 완료를 확인하지 못했습니다. 잠시 후 다시 확인해주세요.':error.message||'탈퇴를 완료하지 못했습니다.');
    }finally{if(ticket===generation)busy=false;}
  }
  return {
    getSnapshot:()=>state,
    subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    start(){if(!started){started=true;return run('start');}},
    deleteAccount,signIn:()=>run('signin'),refresh:()=>run('refresh'),signOut:()=>run('signout')
  };
}
