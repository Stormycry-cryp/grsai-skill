import https from 'node:https';
import { Readable } from 'node:stream';
import { validateDownloadUrl } from './storage.mjs';
export class ProviderError extends Error {
 constructor(message,{definitelyNotSubmitted=false,status,code='PROVIDER_ERROR'}={}) {super(message);this.definitelyNotSubmitted=definitelyNotSubmitted;this.status=status;this.code=code;}
}
const normalize = value => {
 const d=value?.data&&typeof value.data==='object'?value.data:value;
 return {id:d?.id??null,status:d?.status??'running',progress:Number.isFinite(d?.progress)?d.progress:null,urls:(d?.results??[]).map(r=>r.url).filter(x=>typeof x==='string'),error:d?.error?'供应商返回任务失败':null};
};
function pinnedFetch(lookupImpl,requestImpl=https.request){
 return async (value,options={})=>{
  const url=new URL(value);if(!['https://grsai.dakka.com.cn','https://grsaiapi.com'].includes(url.origin)||url.username||url.password)throw new Error('供应商地址必须是官方HTTPS节点');
  const checked=await validateDownloadUrl(url.href,{lookupImpl}),address=checked.addresses[0];
  return new Promise((resolve,reject)=>{
   const request=requestImpl(url,{method:options.method??'GET',headers:options.headers,signal:options.signal,family:address.family,autoSelectFamily:false,lookup:(_hostname,lookupOptions,callback)=>lookupOptions?.all?callback(null,[{...address}]):callback(null,address.address,address.family)},response=>{
    try{
     if(response.statusCode>=300&&response.statusCode<400){response.resume();reject(new Error('供应商禁止HTTP跳转'));return;}
     const headers=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):String(value));
     const body=[204,205,304].includes(response.statusCode)?null:Readable.toWeb(response);if(body===null)response.resume();
     resolve(new Response(body,{status:response.statusCode,statusText:response.statusMessage??'',headers}));
    }catch{response.destroy();reject(new Error('供应商响应格式无效'));}

   });
   request.on('error',reject);request.end(options.body);
  });
 };
}
export function createGrsai(config,{fetchImpl,validateBaseImpl=validateDownloadUrl,lookupImpl,requestImpl=https.request}={}) {
 const fetchProvider=fetchImpl??pinnedFetch(lookupImpl,requestImpl);
 const base = new URL(config.grsaiBaseUrl??'https://grsai.dakka.com.cn');
 if(!['https://grsai.dakka.com.cn','https://grsaiapi.com'].includes(base.origin)||base.username||base.password||base.pathname!=='/'||base.search||base.hash) throw new Error('供应商地址必须是官方HTTPS节点');
 async function checkBase(){try{await validateBaseImpl(base.href,{lookupImpl});}catch{throw new ProviderError('供应商地址必须使用公开HTTPS',{definitelyNotSubmitted:true});}}
 const headers={'Content-Type':'application/json',Authorization:`Bearer ${config.grsaiApiKey??''}`};
 async function request(path,body,{submit=false,timeout=30000}={}) {
  await checkBase();
  if(!config.grsaiApiKey) throw new ProviderError('尚未配置模型密钥',{definitelyNotSubmitted:true});
  let response;
  try {response=await fetchProvider(new URL(path,base),{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout),redirect:'error'});}
  catch {throw new ProviderError(submit?'提交结果未知，请勿重复生成':'供应商暂时无法连接');}
  let data;try {data=await response.json();} catch {throw new ProviderError('供应商响应格式无效');}
  if(!response.ok) {
   if(!submit&&['failed','violation'].includes(normalize(data).status)) return data;
   throw new ProviderError(`供应商请求失败（${response.status}）`,{status:response.status,definitelyNotSubmitted:submit&&[400,401,403,404,422].includes(response.status)});
  }
  return data;
 }
 return {
  mode:'grsai',
  async submit({model,prompt,params={},images=[],audios=[],mask}) {
   const {maskAssetId,imageSize,...rest}=params;
   const body={model,prompt,...rest,replyType:'async',...(images.length?{images}:{}),...(audios.length?{audios}:{}),...(mask?{mask}:{}),...(imageSize&&model.startsWith('nano')?{imageSize}:{})};
   const r=normalize(await request('/v1/api/generate',body,{submit:true,timeout:120000}));
   if(!r.id) throw new ProviderError('提交响应没有任务编号，结果未知');
   return r;
  },
  async result(id,{timeoutMs=30000}={}) {return normalize(await request(`/v1/api/result?id=${encodeURIComponent(id)}`,undefined,{timeout:timeoutMs}));},
  async keyCredits() {
   const d=await request('/client/openapi/getAPIKeyCredits',{apiKey:config.grsaiApiKey});
   const v=d?.data?.credits;if(!Number.isSafeInteger(v)||v<0) throw new ProviderError('密钥余额暂不可用');return v;
  },
  async modelStatus(model) {const d=await request(`/client/common/getModelStatus?model=${encodeURIComponent(model)}`);return {available:typeof d?.data?.status==='boolean'?d.data.status:null};},
  health(){return {configured:!!config.grsaiApiKey,mode:'grsai'};},
  async chat({model,messages,onChunk,onUsage,maxTokens=2048,params={}}) {
   await checkBase();
   if(!config.grsaiApiKey) throw new ProviderError('尚未配置模型密钥',{definitelyNotSubmitted:true,code:'CHAT_NOT_CONFIGURED'});
   let response;
   try {response=await fetchProvider(new URL('/v1/chat/completions',base),{method:'POST',headers,body:JSON.stringify({model,messages,...params,stream:true,max_tokens:maxTokens,stream_options:{include_usage:true}}),signal:AbortSignal.timeout(600000),redirect:'error'});} catch {throw new ProviderError('聊天提交结果未知',{code:'CHAT_TRANSPORT_ERROR'});}
   if(!response.ok) throw new ProviderError(`供应商请求失败（${response.status}）`,{status:response.status,code:'CHAT_HTTP_ERROR',definitelyNotSubmitted:[400,401,403,404,422].includes(response.status)});
   let text='',usage=null,buffer='',done=false,finished=false;
   const decoder=new TextDecoder();
   async function frame(block) {
    const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data) return;if(data.trim()==='[DONE]'){done=true;return;}
    let event;try{event=JSON.parse(data);}catch{throw new ProviderError('聊天流响应格式无效',{status:response.status,code:'CHAT_INVALID_STREAM'});}
    if(event.error) throw new ProviderError('供应商返回聊天失败',{status:response.status,code:'CHAT_PROVIDER_ERROR'});
    if(event.usage) {usage=event.usage;await onUsage?.(usage);}
    if(event.choices?.[0]?.finish_reason) finished=true;
    const part=event.choices?.[0]?.delta?.content??event.choices?.[0]?.message?.content;
    if(typeof part==='string'){text+=part;await onChunk?.(part);}
   }
   try {
    for await(const chunk of response.body) {
     buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');
     if(buffer.length>4*1024*1024) throw new ProviderError('聊天响应超过限制',{status:response.status,code:'CHAT_RESPONSE_LIMIT'});
     let end;while((end=buffer.indexOf('\n\n'))>=0){await frame(buffer.slice(0,end));buffer=buffer.slice(end+2);}
    }
    buffer+=decoder.decode();if(buffer.trim()) await frame(buffer);
   }catch(e){if(e instanceof ProviderError) throw e;throw new ProviderError('聊天连接中断，已收到内容保留',{status:response.status,code:'CHAT_STREAM_INTERRUPTED'});}
   if(!done&&!finished) throw new ProviderError('聊天流未完整结束，已收到内容保留',{status:response.status,code:'CHAT_STREAM_INCOMPLETE'});
   return {text,usage};
  }
 };
}
