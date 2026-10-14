// Prices and interface constraints checked against public GrsAI sources on 2026-10-14.
// maxImages=16 and chat maxTokens<=8192 are local safeguards, not provider guarantees.
const ratios = ['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'];
const pixels1 = ['1024x1024','1672x941','941x1672','1443x1090','1090x1443','1536x1024','1024x1536','1408x1120','1120x1408','1920x832','832x1920','896x1792','1792x896'];
const pixels = ['1024x1024','2048x2048','2880x2880','1280x720','2048x1152','3840x2160','720x1280','1152x2048','2160x3840','1152x864','2304x1728','3264x2448','864x1152','1728x2304','2448x3264','1536x1024','2048x1360','3504x2336','1024x1536','1360x2048','2336x3504','1120x896','2240x1792','3200x2560','896x1120','1792x2240','2560x3200','1456x624','2912x1248','3840x1648','624x1456','1248x2912','1648x3840','688x2048','1280x3840','2048x688','3840x1280','1536x768','3072x1536','3840x1920','768x1536','1536x3072','1920x3840'];
const base = { enabled:true, maintenance:false, resolutions:[], aspectRatios:[], qualities:[], supportsImages:true, supportsAudios:false, supportsMask:false, supportsTransparent:false, maxImages:16,maxAudios:0 };
const image = (id, credits, resolutions, extra={}) => ({...base,id,name:id,type:'image',family:id.startsWith('nano')?'nano':'gpt-image',resolutions,aspectRatios:ratios,price:{unit:'call',credits},...extra});
const chat = (id,input,output,cachedInput,extra={}) => ({...base,id,name:id,type:'chat',family:'chat',price:{unit:'token',input,output,...(cachedInput===undefined?{}:{cachedInput})},...extra});
export const MODEL_CATALOG = Object.freeze([
 {...base,id:'minimax-h3',name:'minimax-h3',type:'video',family:'minimax',resolutions:['480p','768p','1080p'],aspectRatios:['portrait','landscape'],supportsAudios:true,maxImages:9,maxAudios:3,minDuration:1,maxDuration:15,price:{unit:'second',resolutions:{'480p':1000,'768p':1400,'1080p':3000}}},
 {...base,id:'agnes-video-2.5',name:'agnes-video-2.5',type:'video',family:'agnes',resolutions:['720p','1080p','2k'],aspectRatios:['16:9','9:16','21:9','4:3','1:1','3:4'],supportsAudios:true,maxImages:9,maxAudios:3,minDuration:4,maxDuration:12,price:{unit:'second',resolutions:{'720p':2000,'1080p':3400,'2k':4600}}},
 image('nano-banana-2.1',1200,['1K','2K','4K']),
 image('gpt-image-2.5',600,['1K'],{aspectRatios:[...ratios,'9:21','1:2','2:1',...pixels1],qualities:['auto'],supportsMask:true}),
 image('gpt-image-2.5-sunburst',2400,['1K','2K','4K'],{enabled:false,maintenance:true,aspectRatios:['auto',...pixels],qualities:['low','medium','high','xhigh','max'],supportsMask:true,supportsTransparent:true}),
 image('gpt-image-2.5-flare',2000,['1K','2K','4K'],{enabled:false,maintenance:true,aspectRatios:['auto',...pixels],qualities:['low','medium','high'],supportsMask:true,supportsTransparent:true}),
 image('gpt-image-2',600,['1K'],{aspectRatios:[...ratios,'9:21','1:2','2:1',...pixels1],qualities:['auto'],supportsMask:true}),
 image('gpt-image-2-vip',2000,['1K','2K','4K'],{aspectRatios:['auto',...pixels],qualities:['medium'],supportsMask:true,supportsTransparent:true}),
 image('nano-banana-pro',1800,['1K','2K','4K']),
 image('nano-banana-2',1200,['1K','2K','4K'],{aspectRatios:[...ratios,'1:4','4:1','1:8','8:1']}),
 image('nano-banana-2-lite',440,[]),
 image('nano-banana-fast',440,[]),
 image('nano-banana-pro-cl',10000,['1K']),image('nano-banana-2-cl',6000,['1K'],{aspectRatios:[...ratios,'1:4','4:1','1:8','8:1']}),
 image('nano-banana-2-2k-cl',9000,['2K'],{aspectRatios:[...ratios,'1:4','4:1','1:8','8:1']}),image('nano-banana-pro-vip',10000,['1K','2K']),image('nano-banana-pro-4k-vip',18000,['4K']),image('nano-banana-2-4k-cl',13000,['4K'],{aspectRatios:[...ratios,'1:4','4:1','1:8','8:1']}),
 chat('gpt-6.1-sol',18000,90000,1800),chat('gpt-5.5',44000,270000,4500),chat('gpt-5.6-sol',44000,260000,4500),chat('gpt-5.6-terra',18000,104000,1800),chat('gpt-6-astra',80000,400000,8000),
 chat('gemini-3.1-flash-lite',5000,30000,undefined),chat('gemini-3.8-flash',12000,70000),chat('gemini-3.7-flash',12000,70000),chat('gemini-3.5-flash-lite',6000,50000),chat('gemini-3.5-flash',24000,200000),chat('gemini-3.1-pro',30000,140000),chat('gemini-3-flash',8000,60000),chat('gemini-3-pro',30000,140000),chat('gemini-2.5-flash',6000,40000),chat('gemini-2.5-pro',25000,125000)
]);
export const getModel = id => MODEL_CATALOG.find(m=>m.id===id);
const invalid = message => {const e = new Error(message);e.status=400;e.code='INVALID_MODEL_PARAMS';throw e;};
export function validateRequest(model, params={}, assets=[]) {
 if (typeof model==='string') model=getModel(model);
 if(!model) invalid('模型不存在');
 if(model.enabled===false||model.maintenance) invalid('模型暂不可用');
 if (!params || typeof params!=='object' || Array.isArray(params)) invalid('参数格式无效');
 const allowed = model.type==='chat'?['maxTokens']:model.type==='video'?['resolution','aspectRatio','duration','seed']:[...(model.family==='nano'?['imageSize']:[]),'aspectRatio','quality','background','maskAssetId'];
 for(const k of Object.keys(params)) if(!allowed.includes(k)) invalid(`不支持参数 ${k}`);
 if(!Array.isArray(assets)||assets.some(a=>!a||typeof a!=='object'||Array.isArray(a))) invalid('参考素材格式无效');
 const images=assets.filter(a=>a.type==='image'), audios=assets.filter(a=>a.type==='audio');
 if((images.length&&!model.supportsImages)||(audios.length&&!model.supportsAudios)) invalid('参考素材类型不支持');
 if(images.length>model.maxImages || audios.length>model.maxAudios || assets.some(a=>!['image','audio'].includes(a.type))) invalid('参考素材类型或数量不支持');
 if(params.imageSize!==undefined&&!model.resolutions.includes(params.imageSize)) invalid('分辨率不支持');
 if(params.resolution!==undefined&&!model.resolutions.includes(params.resolution)) invalid('分辨率不支持');
 if(params.quality!==undefined&&!model.qualities.includes(params.quality)) invalid('质量参数不支持');
 if(params.aspectRatio!==undefined&&!model.aspectRatios.includes(params.aspectRatio)) {
  const match=model.id==='gpt-image-2-vip'&&String(params.aspectRatio).match(/^(\d+)x(\d+)$/);
  if(!match) invalid('尺寸或比例不支持');
  const w=+match[1],h=+match[2];if(!w||!h||w%16||h%16||Math.max(w,h)>3840||Math.max(w,h)/Math.min(w,h)>3||w*h<655360||w*h>8294400) invalid('自定义尺寸不符合模型限制');
 }
 if(params.background!==undefined&&(!model.supportsTransparent||params.background!=='transparent')) invalid('背景参数不支持');
 if(params.maskAssetId!==undefined&&(!model.supportsMask||!images.some(a=>a.id===params.maskAssetId))) invalid('请选择有效的遮罩图片');
 if(params.seed!==undefined&&!Number.isSafeInteger(params.seed)) invalid('随机种子必须是整数');
 if(model.type==='video') {
  if(!params.resolution||!params.aspectRatio||!Number.isInteger(params.duration)) invalid('请设置分辨率、比例和时长');
  const max=model.id==='minimax-h3'&&params.resolution==='1080p'?10:model.maxDuration;
  if(params.duration<model.minDuration||params.duration>max) invalid('视频时长超出模型限制');
 }
 if(params.maxTokens!==undefined&&(!Number.isInteger(params.maxTokens)||params.maxTokens<1||params.maxTokens>8192)) invalid('最大输出长度应为1至8192');
 return true;
}
export function estimateCredits(model,params={},prompt='',imageCount=0) {
 if(typeof model==='string') model=getModel(model);
 if(!model) invalid('模型不存在');
 if(typeof prompt!=='string') invalid('提示词格式无效');
 const count=Array.isArray(imageCount)?imageCount.length:imageCount;
 if(!Number.isSafeInteger(count)||count<0) invalid('参考图片数量无效');
 if(model.price.unit==='call') return model.price.credits;
 if(model.price.unit==='second') {
  validateRequest(model,params);
  return model.price.resolutions[params.resolution]*params.duration;
 }
 if(params.maxTokens!==undefined&&(!Number.isSafeInteger(params.maxTokens)||params.maxTokens<1||params.maxTokens>8192)) invalid('最大输出长度应为1至8192');
 return Math.max(1,Math.ceil(((Buffer.byteLength(prompt)+count*32000)*model.price.input+(params.maxTokens??2048)*model.price.output)/1e6));
}
export function usageCredits(model,usage) {
 if(typeof model==='string') model=getModel(model);
 if(!model||model.type!=='chat') return null;
 if(!usage||!Number.isSafeInteger(usage.prompt_tokens)||usage.prompt_tokens<0||!Number.isSafeInteger(usage.completion_tokens)||usage.completion_tokens<0) return null;
 const candidate=usage.prompt_tokens_details?.cached_tokens;
 const cached=Number.isSafeInteger(candidate)&&candidate>=0&&candidate<=usage.prompt_tokens?candidate:0;
 return Math.ceil(((usage.prompt_tokens-cached)*model.price.input+cached*(model.price.cachedInput??model.price.input)+usage.completion_tokens*model.price.output)/1e6);
}
