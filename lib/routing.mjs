import { MODEL_CATALOG, validateRequest, estimateCredits } from './model-contract.mjs';

const urls = {
 catalog:'https://grsai.com/zh/dashboard/models',
 nano:'https://qmy27nhsd9.apifox.cn/452392911e0',
 gpt:'https://qmy27nhsd9.apifox.cn/452409160e0',
 video:'https://qmy27nhsd9.apifox.cn/514679297e0',
 agnes:'https://qmy27nhsd9.apifox.cn/523334530e0',
};
const nativePixels = {
 '1:1':['1024x1024','2048x2048','2880x2880'],
 '16:9':['1280x720','2048x1152','3840x2160'],
 '9:16':['720x1280','1152x2048','2160x3840'],
 '4:3':['1152x864','2304x1728','3264x2448'],
 '3:4':['864x1152','1728x2304','2448x3264'],
 '3:2':['1536x1024','2048x1360','3504x2336'],
 '2:3':['1024x1536','1360x2048','2336x3504'],
 '5:4':['1120x896','2240x1792','3200x2560'],
 '4:5':['896x1120','1792x2240','2560x3200'],
 '21:9':['1456x624','2912x1248','3840x1648'],
 '9:21':['624x1456','1248x2912','1648x3840'],
 '2:1':['1536x768','3072x1536','3840x1920'],
 '1:2':['768x1536','1536x3072','1920x3840'],
};
const pixels1 = {'1:1':'1024x1024','16:9':'1672x941','9:16':'941x1672','4:3':'1443x1090','3:4':'1090x1443','3:2':'1536x1024','2:3':'1024x1536','5:4':'1408x1120','4:5':'1120x1408','21:9':'1920x832','9:21':'832x1920','1:2':'896x1792','2:1':'1792x896'};
const fail = message => { const e = new Error(message); e.code='NO_COMPATIBLE_MODEL'; throw e; };
const object = value => value && typeof value==='object' && !Array.isArray(value);
const evidence = (rule,basis,detail,links=[]) => ({rule,basis,detail,urls:links});

function budgetFor(selection) {
 const {maxCredits}=selection;
 if(maxCredits!==undefined&&(!Number.isSafeInteger(maxCredits)||maxCredits<0))fail('maxCredits必须是非负整数');
 return maxCredits;
}
function httpsReference(value) {
 try {
  if(!/^https:\/\//i.test(value)||value.trim()!==value)return false;
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password;
 } catch { return false; }
}
function joinConstraint(params,selection,key) {
 if(params[key]!==undefined&&selection[key]!==undefined&&params[key]!==selection[key])fail(`${key}参数与选择条件冲突`);
 return params[key]??selection[key];
}
function resolutionFor(request,selection,params) {
 const chosen=selection.resolution;
 if(chosen!==undefined&&typeof chosen!=='string')fail('分辨率格式无效');
 const normalized=chosen===undefined?undefined:request.type==='video'?(chosen.toLowerCase()==='2k'?'2k':chosen):chosen.toUpperCase();
 const explicit=request.type==='video'?params.resolution:params.imageSize;
 if(explicit!==undefined&&normalized!==undefined&&explicit!==normalized)fail('分辨率参数与选择条件冲突');
 return explicit??normalized;
}
function imagePixels(model,ratio,resolution) {
 if(!resolution){
  if(model.resolutions.length>1&&ratio!=='auto'&&!/^\d+x\d+$/.test(ratio))resolution=model.resolutions[0];
  else return ratio;
 }
 const tier=['1K','2K','4K'].indexOf(resolution);
 if(tier<0||!model.resolutions.includes(resolution))fail('模型不支持所需分辨率');
 if(/^\d+x\d+$/.test(ratio)) {
  const exact = model.resolutions.length===1&&resolution==='1K'?Object.values(pixels1).includes(ratio):Object.values(nativePixels).some(sizes=>sizes[tier]===ratio);
  if(!exact)fail('像素尺寸与所需分辨率不匹配，不能修改画幅');
  return ratio;
 }
 const result=model.resolutions.length===1?pixels1[ratio]:nativePixels[ratio]?.[tier];
 if(!result)fail('GPT 接口没有确认支持该画幅与分辨率的组合');
 return result;
}

export function recommend(request,catalog=MODEL_CATALOG) {
 if(!object(request)||!['chat','image','video'].includes(request.type)||typeof request.prompt!=='string'||!request.prompt.trim())fail('请提供任务类型和提示词');
 if(!Array.isArray(catalog))fail('模型目录格式无效');
 if(request.model!==undefined&&(typeof request.model!=='string'||!request.model.trim()))fail('model格式无效');
 if(request.selection!==undefined&&!object(request.selection))fail('选择条件格式无效');
 if(request.params!==undefined&&!object(request.params))fail('参数格式无效');
 const selectionFields=['priority','intent','preferredModel','maxCredits','maxTokens','resolution','aspectRatio','duration','transparent','strictInstruction','firstLastFrames','lipSync','nativeAudio'];
 for(const key of Object.keys(request.selection??{}))if(!selectionFields.includes(key))fail(`不支持选择条件 ${key}`);
 const s=request.selection??{},p={...(request.params??{})},priority=s.priority??'balanced';
 if(!['balanced','quality','speed','budget'].includes(priority))fail('选择优先级无效');
 if(s.intent!==undefined&&typeof s.intent!=='string')fail('intent必须是Agent填写的任务名称');
 for(const field of ['images','audios'])if(request[field]!==undefined&&(!Array.isArray(request[field])||request[field].some(x=>typeof x!=='string'||!httpsReference(x))))fail('参考素材必须为HTTPS URL数组');
 const images=request.images??[],audios=request.audios??[];
 if(request.mask!==undefined&&(typeof request.mask!=='string'||!httpsReference(request.mask)))fail('mask必须是HTTPS URL');
 if(request.transparent!==undefined&&typeof request.transparent!=='boolean')fail('transparent必须是布尔值');
 const mask=!!request.mask||p.maskAssetId!==undefined;
 if(mask&&(request.type!=='image'||images.length===0))fail('遮罩编辑必须提供至少一张原图');
 if(p.maskAssetId!==undefined&&!request.mask)fail('maskAssetId必须有对应mask素材');
 if(p.maskAssetId!==undefined&&p.maskAssetId!=='mask')fail('maskAssetId与素材标识不匹配');
 const transparent = p.background==='transparent'||s.transparent===true||request.transparent===true;
 if(s.transparent!==undefined&&typeof s.transparent!=='boolean')fail('transparent选择条件必须是布尔值');
 if(transparent&&p.background!==undefined&&p.background!=='transparent')fail('透明背景条件与参数冲突');
 for(const key of ['firstLastFrames','lipSync','nativeAudio'])if(s[key]||request[key])fail(`${key}严格能力尚未有可验证的接口契约`);
 if(transparent&&request.type!=='image')fail('此任务类型没有透明输出接口契约');
 if(request.maxTokens!==undefined){if(p.maxTokens!==undefined&&p.maxTokens!==request.maxTokens)fail('最大输出长度冲突');p.maxTokens=request.maxTokens;}
 if(s.maxTokens!==undefined){if(p.maxTokens!==undefined&&p.maxTokens!==s.maxTokens)fail('最大输出长度冲突');p.maxTokens=s.maxTokens;}
 const maxCredits=budgetFor(s),resolution=resolutionFor(request,s,p);
 let ratio=joinConstraint(p,s,'aspectRatio'),duration=joinConstraint(p,s,'duration');
 if(request.type==='chat'&&(resolution!==undefined||ratio!==undefined||duration!==undefined||mask||transparent))fail('文本任务不支持图片或视频输出约束');
 if(request.type==='image'&&duration!==undefined)fail('图片任务不支持视频时长');
 if(ratio!==undefined&&typeof ratio!=='string')fail('画幅格式无效');
 if(resolution!==undefined&&request.type==='image'&&!['1K','2K','4K'].includes(resolution))fail('图片分辨率必须为1K、2K或4K');
 const explicit=request.model&&request.model!=='auto'?request.model:undefined;
 if(explicit&&s.preferredModel&&explicit!==s.preferredModel)fail('显式模型与preferredModel冲突');
 const preferred=explicit??s.preferredModel;
 if(preferred!==undefined&&(typeof preferred!=='string'||!preferred.trim()))fail('preferredModel格式无效');
 const assets=[...images.map(()=>({type:'image'})),...audios.map(()=>({type:'audio'})),...(mask?[{type:'image',id:'mask'}]:[])];
 const hardEvidence=evidence('hard-constraints','interface','按任务、素材、参数、维护状态和预算筛选；未修改用户时长或画幅',[urls.catalog]);
 let baseline;
 if(request.type==='chat')baseline=images.length?'gemini-3.1-flash-lite':priority!=='budget'&&(['code','reasoning','strictInstruction'].includes(s.intent)||s.strictInstruction===true)?'gpt-6.1-sol':'gemini-3.1-flash-lite';
 else if(request.type==='image')baseline=transparent?'gpt-image-2-vip':mask?'gpt-image-2.5':priority==='quality'||['2K','4K'].includes(resolution)?'nano-banana-2.1':priority==='budget'||priority==='speed'||s.intent==='draft'?'nano-banana-2-lite':images.length||['product','edit'].includes(s.intent)?'nano-banana-2.1':'gpt-image-2.5';
 else baseline=['2k','720p'].includes(resolution)||(ratio!==undefined&&!['landscape','portrait'].includes(ratio))?'agnes-video-2.5':'minimax-h3';
 const automaticIds=request.type==='chat'?['gemini-3.1-flash-lite','gpt-6.1-sol']:request.type==='video'?['minimax-h3','agnes-video-2.5']:['gpt-image-2.5','nano-banana-2.1','nano-banana-2-lite','gpt-image-2-vip','nano-banana-2','nano-banana-pro','gpt-image-2','nano-banana-fast'];
 let pool=catalog.filter(m=>m.type===request.type&&m.enabled&&!m.maintenance&&(preferred?m.id===preferred:automaticIds.includes(m.id)));
 const failures=[];
 const candidates=[];
 for(const model of pool){
  try{
   if(images.length&&!model.supportsImages)fail('模型不支持参考图片');
   if(audios.length&&!model.supportsAudios)fail('模型不支持参考音频');
   if(mask&&!model.supportsMask)fail('模型不支持遮罩');
   if(transparent&&!model.supportsTransparent)fail('模型不支持透明背景');
   const params={...p};
   if(request.type==='image'){
    const outputResolution=resolution??(!preferred&&priority==='quality'?'2K':undefined);
    const chosenRatio=ratio??'1:1';
    if(model.family==='nano'){
     if(outputResolution!==undefined)params.imageSize=outputResolution;
     params.aspectRatio=chosenRatio;
    }else{
     params.aspectRatio=imagePixels(model,chosenRatio,outputResolution);
     if(params.quality===undefined&&model.qualities?.length)params.quality=model.qualities[0];
    }
    if(transparent)params.background='transparent';
    if(mask)params.maskAssetId='mask';
   }else if(request.type==='video'){
    params.resolution=resolution??(model.id==='minimax-h3'?'480p':'720p');
    params.aspectRatio=ratio??(model.id==='minimax-h3'?'landscape':'16:9');
    params.duration=duration??5;
   }
   validateRequest(model,params,assets);
   const credits=estimateCredits(model,params,request.prompt,images.length);
   if(!Number.isSafeInteger(credits)||credits<0)fail('模型价格配置无效');
   if(maxCredits!==undefined&&credits>maxCredits)fail('积分估算超过预算');
   candidates.push({model:model.id,params,credits,entry:model});
  }catch(error){failures.push(`${model.id}: ${error.message}`);}
 }
 if(!candidates.length){
  if(preferred&&!pool.length)fail('指定模型不存在、类型不匹配或当前维护，未切换模型');
  fail(`${preferred?'指定模型不满足条件，未切换模型':'没有满足全部约束与预算的模型'}${failures.length?`；${failures.join('；')}`:''}`);
 }
 candidates.sort((a,b)=>(a.model===baseline?-1:b.model===baseline?1:a.credits-b.credits)||automaticIds.indexOf(a.model)-automaticIds.indexOf(b.model));
 const chosen=candidates[0];
 const basis=preferred?'interface':'inference';
 const reasons=[preferred?'保留用户指定模型，全部硬约束和预算已通过。':chosen.model===baseline?'采用符合任务约束的默认候选。':'默认候选未满足条件，选择满足约束与预算的候选。',`完整参数估算为${chosen.credits}原始积分；文本任务使用输入与最大输出长度启发式估算。`];
 const resultEvidence=[hardEvidence,evidence('selection-baseline',basis,preferred?'显式选择不代表能力或质量验证。':'依据公开接口兼容性和任务适用性推断选择，任务效果需检查。',request.type==='image'?[chosen.entry.family==='nano'?urls.nano:urls.gpt]:request.type==='video'?[chosen.model==='minimax-h3'?urls.video:urls.agnes]:[urls.catalog]),evidence('performance','unknown','缺少同条件质量、文字、写实和时延对照；不能保证更快或更强。')];
 if(priority==='speed'){reasons.push('速度偏好采用低成本候选，实际速度尚未确认。');resultEvidence.push(evidence('speed-preference','inference','速度没有公开对照依据，低成本减少迭代支出，不承诺更快。',[urls.catalog]));}
 if(request.type==='image'&&priority==='quality')reasons.push('质量偏好采用可控制尺寸的候选；2K默认值只提供尺寸选择，不证明画质领先。');
 if(request.type==='image'&&['typography','diagram'].includes(s.intent))reasons.push('文字或图表任务仅提供待验候选，生成后须检查内容和布局。');
 if(request.type==='video'&&audios.length)reasons.push('已确认支持音频参考接口；输出音轨、音色和口型尚未确认。');
 if(request.type==='chat'&&images.length)resultEvidence.push(evidence('vision','interface','聊天接口定义图片输入；逐型号的图片理解效果需用当前任务验证。',['https://qmy27nhsd9.apifox.cn/452418916e0']));
 const aliases=new Set([chosen.model]);
 if(['nano-banana-fast','nano-banana-2-lite'].includes(chosen.model)){aliases.add('nano-banana-fast');aliases.add('nano-banana-2-lite');}
 const alternatives=[];
 for(const c of candidates.slice(1)){
  if(aliases.has(c.model))continue;
  alternatives.push({model:c.model,params:c.params,rawCredits:c.credits,reasons:[`同样满足硬约束；估算${c.credits}原始积分，未证明质量或速度优于已选模型。`],evidence:[hardEvidence,evidence('alternative','interface','参数与预算兼容，不代表独立故障备用渠道。',[urls.catalog])]});
  aliases.add(c.model);
  if(['nano-banana-fast','nano-banana-2-lite'].includes(c.model)){aliases.add('nano-banana-fast');aliases.add('nano-banana-2-lite');}
  if(alternatives.length===3)break;
 }
 return {model:chosen.model,params:chosen.params,rawCredits:chosen.credits,reasons,evidence:resultEvidence,alternatives};
}
