import {createHash} from 'node:crypto';
import {AccountError} from './account-core.mjs';
import {accounts} from './account-routes.mjs';
export function validAnalysisText(text){
 if(typeof text!=='string'||!text.trim())return false;
 const raw=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 try {const v=JSON.parse(raw);return v&&typeof v==='object'&&!Array.isArray(v)&&(typeof v.canAssess==='boolean'||typeof v.found==='boolean'||Array.isArray(v.wounds));}catch{return false;}
}
export function createChargedAnalysis({getAccounts=accounts,request=fetch,key=process.env.ANTHROPIC_API_KEY||'',model=process.env.AI_MODEL||'claude-sonnet-4-6',timeoutMs=40000}={}){
 return async function(req,res){
  let service,hold,closed=false;const controller=new AbortController();let timer;
  const disconnect=()=>{if(!res.writableFinished){closed=true;controller.abort();}};
  res.set('Cache-Control','no-store');res.on('close',disconnect);
  try{
   service=getAccounts();const identity=await service.authenticate(req.get('authorization'));
   if(!key)throw new AccountError('AI_UNAVAILABLE',503,'AI 분석을 일시적으로 이용할 수 없습니다. 횟수는 차감되지 않습니다.');
   const {images,prompt,requestId}=req.body||{};
   if(!Array.isArray(images)||images.length<1||images.length>3||images.some(b=>typeof b!=='string'||b.length<100||b.length>4000000)||typeof prompt!=='string'||!prompt.trim()||prompt.length>20000)
    throw new AccountError('INVALID_ANALYSIS',400,'사진 또는 분석 요청 형식을 확인해주세요.');
   if(closed)return;
   const fingerprint=createHash('sha256').update(JSON.stringify({images,prompt})).digest('hex');
   hold=await service.ledger.reserve(identity,requestId,fingerprint);
   if(closed)throw Error('disconnected');
   timer=setTimeout(()=>controller.abort(),timeoutMs);
   const response=await request('https://api.anthropic.com/v1/messages',{
    method:'POST',headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},signal:controller.signal,
    body:JSON.stringify({model,max_tokens:1000,messages:[{role:'user',content:[...images.map(data=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data}})),{type:'text',text:prompt}]}]})
   });
   const data=await response.json();
   const text=(data?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
   if(!response.ok||data.error||data.stop_reason==='max_tokens'||!validAnalysisText(text)||closed||controller.signal.aborted)throw Error('analysis unavailable');
   // Numeric counters only. Never log a prompt, photo, response, token, or identity.
   if(data.usage)console.log('[ai-usage]',JSON.stringify({model,input_tokens:data.usage.input_tokens,output_tokens:data.usage.output_tokens}));
   const parsed=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
   const charge=parsed.canAssess!==false&&parsed.found!==false;
   const charged=await service.ledger.settle(hold,charge);
   if(!charge){hold=null;if(!closed)res.json({text});return;}
   if(!charged)throw Error('reservation expired');
   hold=null;
   if(!closed)res.json({text});
  }catch(error){
   if(hold){try{await service.ledger.settle(hold,false);}catch{console.error('[credit-settlement] retry-on-next-account-check');}}
   if(!closed&&!res.headersSent){
    if(error instanceof AccountError)res.status(error.status).json({code:error.code,error:error.message});
    else res.status(503).json({code:'ANALYSIS_UNAVAILABLE',error:'AI 분석을 완료하지 못했습니다. 횟수를 새로고침해주세요. 처리 중인 횟수는 최대 2분 후 복구됩니다. 수동 사정은 계속 이용할 수 있어요.'});
   }
  }finally{clearTimeout(timer);res.off('close',disconnect);}
 };
}
