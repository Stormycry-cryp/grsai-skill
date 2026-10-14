#!/usr/bin/env node
import { promises as fs, constants as fsFlags } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parse as parseEnv } from 'dotenv';
import { MODEL_CATALOG, getModel, validateRequest, estimateCredits, usageCredits } from '../lib/model-contract.mjs';
import { createDnsLookup } from '../lib/dns.mjs';
import { createGrsai } from '../lib/provider.mjs';
import { createStorage, validateDownloadUrl, mediaExtensions } from '../lib/storage.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const absolute = (value,label) => {if(typeof value!=='string'||!path.isAbsolute(value))throw new Error(`${label}必须是绝对路径`);return path.resolve(value);};
const canonical = value => JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const safeError = error => error?.code?.startsWith('CHAT_')?'聊天未完成，已保留收到的内容':error?.definitelyNotSubmitted?'请求被拒绝，未提交任务':'操作未完成，请使用原任务编号查询或恢复';
export const SKILL_ROOT = fileURLToPath(new URL('../',import.meta.url));
const defaultJobDir = () => path.join(SKILL_ROOT,'.local','jobs');
const timestamp = () => new Date().toISOString();

async function checkParents(file){for(let dir=path.dirname(file);;dir=path.dirname(dir)){try{const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('路径包含软链接或非目录');}catch(error){if(error.code!=='ENOENT')throw error;}if(path.dirname(dir)===dir)break;}}
async function privateDir(dir){await checkParents(path.join(dir,'placeholder'));await fs.mkdir(dir,{recursive:true,mode:0o700});const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('任务目录无效');await fs.chmod(dir,0o700);if(path.basename(dir)==='jobs'&&path.basename(path.dirname(dir))==='.local')await fs.chmod(path.dirname(dir),0o700);}
async function atomicJSON(file,value){const temporary=`${file}.${randomUUID()}.tmp`;const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await fs.rename(temporary,file);const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}
async function safeRead(file){await checkParents(file);const handle=await fs.open(file,fsFlags.O_RDONLY|fsFlags.O_NOFOLLOW|fsFlags.O_NONBLOCK);try{if(!(await handle.stat()).isFile())throw new Error('文件类型无效');return await handle.readFile('utf8');}finally{await handle.close();}}
async function privateRead(file){return JSON.parse(await safeRead(file));}

export function sanitizeUsage(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const clean={};for(const key of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isSafeInteger(value[key])&&value[key]>=0)clean[key]=value[key];
 const cached=value.prompt_tokens_details?.cached_tokens;if(Number.isSafeInteger(cached)&&cached>=0&&Number.isSafeInteger(clean.prompt_tokens)&&cached<=clean.prompt_tokens)clean.prompt_tokens_details={cached_tokens:cached};
 return Object.keys(clean).length?clean:null;
}
async function kernelLock(lock){
 const child=spawn('python3',[fileURLToPath(new URL('./lock.py',import.meta.url)),lock],{stdio:['pipe','pipe','ignore']});
 const ended=new Promise(resolve=>{child.once('exit',code=>resolve(code));child.once('error',()=>resolve(-1));});
 child.stdin.on('error',()=>{});
 const state=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',chunk=>{text+=chunk;const first=text.split('\n')[0];if(text.includes('\n'))resolve(first);});child.once('error',()=>reject(new Error('内核任务锁无法启动')));child.once('exit',()=>{if(!text.includes('\n'))reject(new Error('内核任务锁无法获取'));});});
 if(state!=='acquired'){child.stdin.end();await ended;if(state==='busy')return null;throw new Error('内核任务锁无法获取');}
 return async()=>{child.stdin.end();await ended;};
}
async function copySelectedFile(source,dest,maxBytes=100*1024*1024){
 const input=await fs.open(source,fsFlags.O_RDONLY|fsFlags.O_NOFOLLOW);let output;
 try{const stat=await input.stat();if(!stat.isFile()||stat.size<=0||stat.size>maxBytes)throw new Error('文件大小无效');output=await fs.open(dest,'wx',0o600);const buffer=Buffer.alloc(1024*1024);let total=0;while(true){const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maxBytes)throw new Error('文件超出大小限制');await output.writeFile(buffer.subarray(0,bytesRead));}await output.sync();}
 finally{await input.close();await output?.close();}
}
async function sameOwnedFile(file,identity){try{const stat=await fs.lstat(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.dev===identity.dev&&stat.ino===identity.ino;}catch{return false;}}
async function publishFile(source,dest,job,write,output){
 if(output?.identity&&await sameOwnedFile(dest,output.identity)){output.published=true;return;}
 const temporary=path.join(path.dirname(dest),`.grsai-${job.jobID}-${randomUUID()}.tmp`);
 await copySelectedFile(source,temporary);const identity=await fs.lstat(temporary);
 try{if(output){output.identity={dev:identity.dev,ino:identity.ino};output.published=false;await write(job);}await fs.link(temporary,dest);if(output){output.published=true;await write(job);}}
 finally{if(await sameOwnedFile(temporary,identity))await fs.unlink(temporary);}
}

export async function resolveRequest(input,{recommendImpl}={}) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('请求格式无效');
 if(!['chat','image','video'].includes(input.type)||typeof input.prompt!=='string'||!input.prompt.trim())throw new Error('请填写任务类型和提示词');
 if(input.prompt.length>100000)throw new Error('提示词超过限制');
 for(const field of ['images','audios'])if(input[field]!==undefined&&(!Array.isArray(input[field])||input[field].some(item=>typeof item!=='string')))throw new Error('参考素材格式无效');
 const images=input.images??[],audios=input.audios??[];
 for(const ref of [...images,...audios,...(input.mask?[input.mask]:[])]){if(typeof ref!=='string'||!ref.startsWith('https://'))throw new Error('参考素材仅支持公开HTTPS地址；本地素材请先自行托管');const u=new URL(ref);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw new Error('参考素材必须使用公开HTTPS地址');}
 if(!recommendImpl){try{({recommend:recommendImpl}=await import('../lib/routing.mjs'));}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND')throw new Error('模型选择路由尚未配置');throw error;}}
 const selection=await recommendImpl({...input,model:input.model===undefined?'auto':input.model},MODEL_CATALOG);
 const model=getModel(selection?.model);
 if(!model||model.type!==input.type)throw new Error('模型不存在或与任务类型不匹配');
 const params={...(selection.params??{})};
 const assets=[...images.map(()=>({type:'image'})),...audios.map(()=>({type:'audio'}))];
 if(input.mask){if(!model.supportsMask)throw new Error('模型不支持遮罩');assets.push({type:'image',id:'mask'});params.maskAssetId='mask';}
 validateRequest(model,params,assets);
 if(input.selection!==undefined&&(!input.selection||typeof input.selection!=='object'||Array.isArray(input.selection)))throw new Error('选择条件格式无效');
 if(input.selection?.maxPoints!==undefined)throw new Error('预算仅支持原始积分maxCredits');
 const budget=input.selection?.maxCredits;
 if(budget!==undefined&&(!Number.isSafeInteger(budget)||budget<0))throw new Error('maxCredits必须是非负整数');
 const estimatedRawCredits=estimateCredits(model,params,input.prompt,images.length);
 if(budget!==undefined&&estimatedRawCredits>budget)throw new Error('积分估算超过预算');
 return {request:{...input,model:model.id,params,images,audios},model,selection,estimate:{rawCredits:estimatedRawCredits,kind:'estimate',actualChargeKnown:false,budgetIsEstimateOnly:true,assumption:model.type==='chat'?'输入文本按UTF-8字节数估算token，每张输入图片按32000token估算，输出按maxTokens上限估算；预算约束不等于硬账单上限':'按文档单位价格估算'}};
}

export function createRunner({provider,storage=createStorage(),jobDir=defaultJobDir(),lookupImpl,recommendImpl,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 jobDir=absolute(jobDir,'任务目录');
 const file=id=>path.join(jobDir,`${id}.json`);
 const checkId=id=>{if(!uuid.test(id??''))throw new Error('任务编号必须是UUID');return id.toLowerCase();};
 async function read(id){return privateRead(file(checkId(id)));}
 async function write(job){job.updatedAt=timestamp();await atomicJSON(file(job.jobID),job);}
 const view=job=>({jobID:job.jobID,requestID:job.jobID,model:job.model,status:job.status,remoteId:job.remoteId??null,remoteStatus:job.remoteStatus??null,progress:job.progress??null,outputDir:job.outputDir,paths:job.outputs?.filter(item=>item.published!==false).map(item=>item.path)??[],partialPath:job.partialPath??null,estimate:job.estimate,usage:sanitizeUsage(job.usage),usageEstimate:job.usageEstimate??null,costUnknown:job.costUnknown??false,error:job.error??null});
 async function withLock(id,operation,{existing=false}={}){
  await privateDir(jobDir);const release=await kernelLock(path.join(jobDir,`${id}.lock`));
  if(!release){if(existing){try{return view(await read(id));}catch{}}throw new Error('任务正在由另一进程处理，请使用原编号查询');}
  try{return await operation();}finally{await release();}
 }
 async function snapshotDirectory(job){const dir=path.join(jobDir,'snapshots',job.jobID);await privateDir(dir);return dir;}
 async function snapshot(job,source,label){const dest=path.join(await snapshotDirectory(job),`${label}-${randomUUID()}`);await copySelectedFile(source,dest);return dest;}
 async function refs(job){
  const converted={images:[],audios:[]};
  for(const [field,type] of [['images','image'],['audios','audio'],['mask','image']]){
   const source=field==='mask'?(job.request.mask?[job.request.mask]:[]):job.request[field];
   for(let i=0;i<source.length;i++){
    const ref=source[i];let value=ref;
    await validateDownloadUrl(ref,{lookupImpl});
    if(field==='mask')converted.mask=value;else converted[field].push(value);
   }
  }
  return converted;
 }
 async function saveResults(job){
  job.outputs??=[];
  try{
   await fs.mkdir(job.outputDir,{recursive:true});
   if(job.type==='chat'){
    for(const output of job.outputs){if(!output.snapshotPath)output.snapshotPath=await snapshot(job,output.path,'chat-result');await publishFile(output.snapshotPath,output.path,job,write,output);}
    job.status='succeeded';job.error=null;await write(job);return view(job);
   }
   if(!job.resultURLs.length)throw new Error('missing results');
   for(let i=0;i<job.resultURLs.length;i++){
    let output=job.outputs.find(item=>item.index===i);
    if(output){try{if(!output.snapshotPath){output.snapshotPath=await snapshot(job,output.path,`result-${i}`);output.published=true;}const info=await storage.normalize(output.snapshotPath);if(info.sha256!==output.sha256)throw new Error('changed result');}catch{job.outputs=job.outputs.filter(item=>item.index!==i);output=null;await write(job);}}
    if(!output){
     const temp=path.join(await snapshotDirectory(job),`result-${i}-${randomUUID()}`);
     await storage.download(job.resultURLs[i],temp,{maxBytes:job.type==='image'?20*1024*1024:100*1024*1024});await fs.chmod(temp,0o600);const info=await storage.normalize(temp);if(info.type!==job.type)throw new Error('生成结果类型不匹配');
     output={index:i,path:path.join(job.outputDir,`${job.jobID}-${i+1}.${mediaExtensions[info.mime]}`),snapshotPath:temp,mime:info.mime,sha256:info.sha256,published:false};job.outputs.push(output);await write(job);
    }
    await publishFile(output.snapshotPath,output.path,job,write,output);
   }
   job.status='succeeded';job.error=null;
  }catch{job.status='storage_failed';job.error='结果已生成，保存未完成；使用原任务编号恢复保存';}
  await write(job);return view(job);
 }
 async function query(job,{timeoutMs=30000,save=true}={}){
  if(['storage_failed','storage_pending'].includes(job.status)&&(job.type==='chat'||job.resultURLs?.length))return save?saveResults(job):view(job);
  if(job.type==='chat'){if(job.status==='submitting'){job.status='failed';job.costUnknown=true;job.error='聊天未完整结束，已保留收到的内容；勿重复提交';await write(job);}return view(job);}
  if(['submitting','uncertain'].includes(job.status)&&!job.remoteId){job.status='uncertain';job.costUnknown=true;job.error='提交结果未知，没有任务编号；请联系供应商核对，勿再次提交';await write(job);return view(job);}
  if(['succeeded','failed','preparing'].includes(job.status)||!job.remoteId)return view(job);
  let result;try{result=await provider.result(job.remoteId,{timeoutMs});}catch{job.error='暂时无法查询原任务，请稍后使用同一编号查询';await write(job);return view(job);}
  job.progress=result.progress??job.progress;job.error=null;
  if(['failed','violation','error'].includes(result.status)){job.status='failed';job.costUnknown=true;job.error='供应商任务失败，实际扣费或退款情况未知';}
  else if(['succeeded','success','completed'].includes(result.status)){job.remoteStatus='succeeded';job.resultURLs=result.urls??[];job.status=save?'storage_failed':'storage_pending';await write(job);if(!job.resultURLs.length){job.status='storage_failed';job.error='供应商任务已完成但未返回结果地址';await write(job);return view(job);}if(!save)return view(job);return saveResults(job);}
  else job.status='running';
  await write(job);return view(job);
 }
 return {
  models:()=>MODEL_CATALOG,
  async recommend(request){const resolved=await resolveRequest({...request,model:request.model===undefined?'auto':request.model},{recommendImpl});return {...resolved.selection,estimate:resolved.estimate};},
  async create(input,{outputDir,requestID=randomUUID(),dryRun=false}={}){
   outputDir=absolute(outputDir,'输出目录');const id=checkId(requestID),fingerprint=hash({input,outputDir});
   if(dryRun){const resolved=await resolveRequest(input,{recommendImpl});return {dryRun:true,model:resolved.model.id,params:resolved.request.params,estimate:resolved.estimate,selection:resolved.selection,outputDir};}
   return withLock(id,async()=>{
    let prior;try{prior=await read(id);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(prior){if(prior.fingerprint!==fingerprint)throw new Error('请求编号已用于其他内容，请勿复用');if(prior.status==='submitting'&&!prior.remoteId){prior.status=prior.type==='chat'?'failed':'uncertain';prior.costUnknown=true;prior.error='先前提交未完整结束，勿重复提交';await write(prior);}return view(prior);}
    if(!provider)throw new Error('尚未配置供应商');
    const resolved=await resolveRequest(input,{recommendImpl});
    const job={jobID:id,fingerprint,createdAt:timestamp(),type:resolved.model.type,model:resolved.model.id,request:resolved.request,outputDir,estimate:resolved.estimate,status:'preparing',outputs:[]};await write(job);
    let reference;try{reference=await refs(job);}catch{job.status='failed';job.error='参考素材地址验证失败，未提交生成任务';await write(job);return view(job);}
    job.status='submitting';await write(job);
    if(job.type==='chat'){
     let partialHandle,chatStarted=false;
     try{
      await fs.mkdir(outputDir,{recursive:true});const dest=path.join(outputDir,`${id}.txt`);try{await fs.lstat(dest);throw new Error('输出文件已存在');}catch(error){if(error.code!=='ENOENT')throw error;}
      const partial=path.join(await snapshotDirectory(job),`chat-partial-${randomUUID()}.txt`);partialHandle=await fs.open(partial,'wx',0o600);job.partialPath=partial;await write(job);
      const content=[{type:'text',text:job.request.prompt},...reference.images.map(url=>({type:'image_url',image_url:{url}}))];
      const {maxTokens=2048}=job.request.params;chatStarted=true;
      const result=await provider.chat({model:job.model,messages:[{role:'user',content}],maxTokens,onChunk:async chunk=>{await partialHandle.writeFile(chunk);await partialHandle.sync();},onUsage:async usage=>{job.usage=sanitizeUsage(usage);await write(job);}});
      await partialHandle.close();partialHandle=null;
      job.usage=sanitizeUsage(result.usage)??job.usage??null;const raw=usageCredits(resolved.model,job.usage);job.usageEstimate=raw===null?null:{rawCredits:raw,kind:'usage_estimate',actualChargeKnown:false};
      const completed=path.join(await snapshotDirectory(job),`chat-result-${randomUUID()}.txt`);await fs.writeFile(completed,result.text,{flag:'wx',mode:0o600});job.outputs=[{path:dest,snapshotPath:completed,mime:'text/plain',sha256:createHash('sha256').update(result.text).digest('hex'),published:false}];job.remoteStatus='succeeded';job.status='storage_pending';job.costUnknown=!job.usage;await write(job);const saved=await saveResults(job);if(saved.status==='succeeded'){job.partialPath=null;await write(job);}return view(job);
     }catch(error){job.status='failed';job.costUnknown=chatStarted&&!error.definitelyNotSubmitted;job.error=chatStarted?safeError(error):'输出文件已存在或无法安全创建，未提交聊天任务';}
     finally{await partialHandle?.close();}
    }else{
     try{const result=await provider.submit({model:job.model,prompt:job.request.prompt,params:job.request.params,...reference});if(!result.id)throw new Error('missing id');job.remoteId=String(result.id);job.status='running';job.progress=result.progress??null;}
     catch(error){job.status=error.definitelyNotSubmitted?'failed':'uncertain';job.costUnknown=!error.definitelyNotSubmitted;job.error=error.definitelyNotSubmitted?safeError(error):'提交结果未知，没有任务编号；请联系供应商核对，勿再次提交';}
    }
    await write(job);return view(job);
   },{existing:true}).then(async result=>{const prior=await read(id);if(prior.fingerprint!==fingerprint)throw new Error('请求编号已用于其他内容，请勿复用');return result;});
  },
  async status(id){id=checkId(id);return withLock(id,async()=>query(await read(id)),{existing:true});},
  async wait(id,{timeout=55,interval=3}={}){
   id=checkId(id);if(!Number.isFinite(timeout)||timeout<=0||timeout>86400)throw new Error('等待超时应大于0且不超过86400秒');
   return withLock(id,async()=>{const deadline=now()+timeout*1000;let job=await read(id),result=view(job);while(now()<deadline){result=await query(job,{timeoutMs:Math.max(1,Math.min(30000,deadline-now())),save:false});if(result.status!=='running')return result;const remaining=deadline-now();if(remaining>0)await sleep(Math.min(interval*1000,remaining));job=await read(id);}return {...result,timedOut:true};},{existing:true});
  }
 };
}

export async function initializeEnvironment(envFile=path.join(SKILL_ROOT,'.env'),{env=process.env}={}) {
 envFile=absolute(envFile,'环境文件');await checkParents(envFile);let created=false;
 try{const handle=await fs.open(envFile,fsFlags.O_WRONLY|fsFlags.O_CREAT|fsFlags.O_EXCL|fsFlags.O_NOFOLLOW,0o600);try{await handle.writeFile('GRSAI_API_KEY=\n');await handle.sync();created=true;}finally{await handle.close();}}catch(error){if(error.code!=='EEXIST')throw error;}
 const vars=parseEnv(await safeRead(envFile));
 const key=env.GRSAI_API_KEY?.trim()||vars.GRSAI_API_KEY?.trim();
 return {envFile,created,key:key||null};
}
export async function loadRuntime({envFile,dnsMode='system',env=process.env}={}){
 const initialized=await initializeEnvironment(envFile,{env});
 if(!initialized.key)return {status:'configuration_required',envFile:initialized.envFile,message:'请在环境文件中填写 GRSAI_API_KEY 后再次运行。'};
 const lookupImpl=createDnsLookup(dnsMode);
 return {lookupImpl,provider:createGrsai({grsaiApiKey:initialized.key},{lookupImpl}),storage:createStorage({lookupImpl}),jobDir:defaultJobDir()};
}
function parseArgs(args){const [command,...rest]=args,options={};const allowed=new Set(['request','output-dir','request-id','jobID','job-id','timeout','env-file','dns-mode']);for(let i=0;i<rest.length;i++){const option=rest[i];if(!option.startsWith('--'))throw new Error('命令参数无效');if(option==='--dry-run')options.dryRun=true;else{if(!allowed.has(option.slice(2)))throw new Error('命令参数不支持');if(!rest[i+1]||rest[i+1].startsWith('--'))throw new Error('命令参数缺少值');options[option.slice(2)]=rest[++i];}}return {command,options};}
export async function main(args=process.argv.slice(2)){
 if(args.includes('--help')||args.includes('-h'))return {commands:['init [--env-file /abs/.env]','models','recommend --request /abs/request.json','create --request /abs/request.json --output-dir /abs/output [--dry-run] [--request-id UUID]','status --jobID UUID','wait --jobID UUID [--timeout 55]'],options:['--env-file /absolute/path/.env','--dns-mode system|cloudflare'],notes:['首次调用自动创建 Skill 根目录 .env，填写 GRSAI_API_KEY 后继续；环境变量也可提供 Key','媒体异步提交一次；等待超时保留running；远端完成返回storage_pending，再用status保存结果','rawCredits为原始积分估算，实际扣费以供应商为准','参考素材仅支持公开HTTPS地址；结果仅保存本地，输出文件不会被覆盖']};
 const {command,options}=parseArgs(args);
 const initialized=await initializeEnvironment(options['env-file']);
 if(!['system','cloudflare',undefined].includes(options['dns-mode']))throw new Error('dns-mode仅支持system或cloudflare');
 if(!['init','models','recommend','create','status','wait'].includes(command))throw new Error('用法：grsai init | models | recommend | create | status | wait，使用 --help 查看参数');
 if(!initialized.key)return {status:'configuration_required',envFile:initialized.envFile,message:'请在环境文件中填写 GRSAI_API_KEY 后再次运行。'};
 if(command==='init')return {status:'configured',envFile:initialized.envFile,created:initialized.created};
 if(command==='models')return MODEL_CATALOG;
 let request;if(['create','recommend'].includes(command))request=await privateRead(absolute(options.request,'请求文件'));
 const offline=command==='recommend'||options.dryRun;
 const runtime=offline?{}:await loadRuntime({envFile:options['env-file'],dnsMode:options['dns-mode']});
 if(runtime.status==='configuration_required')return runtime;
 const runner=createRunner(runtime);
 if(command==='recommend')return runner.recommend(request);
 if(command==='create')return runner.create(request,{outputDir:options['output-dir'],requestID:options['request-id'],dryRun:!!options.dryRun});
 const id=options.jobID??options['job-id'];return command==='status'?runner.status(id):runner.wait(id,{timeout:options.timeout===undefined?55:Number(options.timeout)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().then(result=>process.stdout.write(`${JSON.stringify(result,null,2)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify({error:typeof error.message==='string'&&!/https?:|Bearer|secret|key=/i.test(error.message)?error.message:'操作失败，请检查环境文件或原任务记录'})}\n`);process.exitCode=1;});}
