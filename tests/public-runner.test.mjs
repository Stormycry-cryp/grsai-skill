import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createRunner, resolveRequest } from '../scripts/grsai.mjs';
import { createStorage, normalizeMedia, validateDownloadUrl, downloadMedia } from '../lib/storage.mjs';
import { createGrsai, ProviderError } from '../lib/provider.mjs';
import { createDnsLookup } from '../lib/dns.mjs';
const image={type:'image',model:'nano-banana-2-lite',prompt:'A simple shape'};
const chat={type:'chat',model:'gpt-6.1-sol',prompt:'Hello',params:{maxTokens:4}};
const publicLookup=async()=>[{address:'8.8.8.8',family:4}];
async function fixture(t){const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'grsai-runner-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {jobDir:path.join(dir,'.local','jobs'),outputDir:path.join(dir,'out')};}
const digest=text=>createHash('sha256').update(text).digest('hex');

test('estimates and budget use original credits only',async()=>{
 const result=await resolveRequest({...image,selection:{maxCredits:440}});assert.equal(result.estimate.rawCredits,440);assert.equal(Object.hasOwn(result.estimate,'displayPoints'),false);
 await assert.rejects(resolveRequest({...image,selection:{maxCredits:439}}),/预算/);await assert.rejects(resolveRequest({...image,selection:{maxPoints:100}}),/maxPoints/);
});
test('rejects local references before submission and contains no upload API',async t=>{
 const f=await fixture(t);let calls=0;const runner=createRunner({...f,provider:{submit:async()=>{calls++;throw Error('must not run');}}});
 for(const ref of ['/tmp/reference.png','file:///tmp/reference.png','relative.png','http://example.com/a.png'])await assert.rejects(runner.create({...image,images:[ref]},{outputDir:f.outputDir,requestID:randomUUID()}),/公开HTTPS/);
 assert.equal(calls,0);assert.equal(createStorage().upload,undefined);assert.equal(createStorage().signedReadUrl,undefined);
});
test('private references fail before provider call; DNS uses system by default and Cloudflare only explicitly',async t=>{
 const f=await fixture(t);let calls=0;const runner=createRunner({...f,lookupImpl:async()=>[{address:'127.0.0.1',family:4}],provider:{submit:async()=>{calls++;}}});
 const result=await runner.create({...image,images:['https://example.com/reference.png']},{outputDir:f.outputDir});assert.equal(result.status,'failed');assert.equal(calls,0);
 await assert.rejects(validateDownloadUrl('https://localhost/a'));await assert.rejects(validateDownloadUrl('https://192.168.1.1/a'));
 const system=async()=>[];assert.equal(createDnsLookup(undefined,{systemLookupImpl:system}),system);let queries=0;
 const doh=createDnsLookup('cloudflare',{fetchImpl:async url=>{queries++;assert.equal(url.origin,'https://cloudflare-dns.com');return {ok:true,text:async()=>JSON.stringify({Status:0,Answer:[{type:1,data:'8.8.8.8',TTL:20}]})};}});assert.equal((await doh('example.com',{all:true}))[0].address,'8.8.8.8');assert.equal(queries,1);
});
test('submission persisted once, status and wait use original remote ID; output saves locally',async t=>{
 const f=await fixture(t),id=randomUUID();let submissions=0;const queried=[];
 const provider={submit:async()=>{submissions++;return {id:'mock-remote-task',status:'running'};},result:async remoteId=>{queried.push(remoteId);return {status:'succeeded',urls:['https://example.com/generated.png']};}};
 const content='mock-image-bytes',storage={download:async(_url,dest)=>{await fs.writeFile(dest,content,{flag:'wx'});},normalize:async file=>({type:'image',mime:'image/png',sha256:digest(await fs.readFile(file))})};
 let runner=createRunner({...f,provider,storage,lookupImpl:publicLookup});assert.equal((await runner.create(image,{outputDir:f.outputDir,requestID:id})).status,'running');
 runner=createRunner({...f,provider,storage,lookupImpl:publicLookup});assert.equal((await runner.create(image,{outputDir:f.outputDir,requestID:id})).jobID,id);assert.equal(submissions,1);
 assert.equal((await runner.wait(id,{timeout:1})).status,'storage_pending');const saved=await runner.status(id);assert.equal(saved.status,'succeeded');assert.equal(await fs.readFile(saved.paths[0],'utf8'),content);assert.ok(queried.every(value=>value==='mock-remote-task'));
 assert.equal((await fs.stat(f.jobDir)).mode&0o777,0o700);assert.equal((await fs.stat(path.dirname(f.jobDir))).mode&0o777,0o700);assert.equal((await fs.stat(path.join(f.jobDir,`${id}.json`))).mode&0o777,0o600);assert.equal((await fs.stat(saved.paths[0])).mode&0o777,0o600);
});
test('uncertain submission and interrupted chat never resubmit same UUID',async t=>{
 const f=await fixture(t);let submissions=0,chats=0;
 const provider={submit:async()=>{submissions++;throw Error('transport interruption');},chat:async({onChunk})=>{chats++;await onChunk('partial output');throw new ProviderError('stream incomplete',{code:'CHAT_STREAM_INCOMPLETE'});}};
 const runner=createRunner({...f,provider});const id=randomUUID();assert.equal((await runner.create(image,{outputDir:f.outputDir,requestID:id})).status,'uncertain');assert.equal((await runner.status(id)).costUnknown,true);await runner.create(image,{outputDir:f.outputDir,requestID:id});assert.equal(submissions,1);
 const chatId=randomUUID(),partial=await runner.create(chat,{outputDir:f.outputDir,requestID:chatId});assert.equal(partial.status,'failed');assert.equal(await fs.readFile(partial.partialPath,'utf8'),'partial output');await runner.create(chat,{outputDir:f.outputDir,requestID:chatId});await runner.status(chatId);assert.equal(chats,1);
});
test('chat output collision never submits; successful usage preserves raw credits',async t=>{
 const f=await fixture(t);await fs.mkdir(f.outputDir);const id=randomUUID();await fs.writeFile(path.join(f.outputDir,`${id}.txt`),'KEEP');let calls=0;
 const provider={chat:async({onChunk})=>{calls++;await onChunk('hello');return {text:'hello',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};}};
 const runner=createRunner({...f,provider});assert.equal((await runner.create(chat,{outputDir:f.outputDir,requestID:id})).status,'failed');assert.equal(calls,0);assert.equal(await fs.readFile(path.join(f.outputDir,`${id}.txt`),'utf8'),'KEEP');
 const result=await runner.create(chat,{outputDir:f.outputDir});assert.equal(result.status,'succeeded');assert.equal(result.usageEstimate.rawCredits,1);assert.equal(Object.hasOwn(result.usageEstimate,'displayPoints'),false);assert.equal(await fs.readFile(result.paths[0],'utf8'),'hello');
});
test('download refuses private redirects and existing output; content validation rejects invalid media',async t=>{
 const f=await fixture(t);await fs.mkdir(f.outputDir);const dest=path.join(f.outputDir,'result.png');await fs.writeFile(dest,'KEEP');let requests=0;
 const requestImpl=(_url,_options,callback)=>{const req=new EventEmitter();req.end=()=>{requests++;const response=new PassThrough();response.statusCode=200;response.headers={};callback(response);response.end('new');};return req;};
 await assert.rejects(downloadMedia('https://example.com/result.png',dest,{lookupImpl:publicLookup,requestImpl}),{code:'EEXIST'});assert.equal(await fs.readFile(dest,'utf8'),'KEEP');assert.equal(requests,1);
 const redirectImpl=(_url,_options,callback)=>{const req=new EventEmitter();req.end=()=>{const response=new PassThrough();response.statusCode=302;response.headers={location:'https://127.0.0.1/result.png'};callback(response);response.end();};return req;};
 await assert.rejects(downloadMedia('https://example.com/result.png',path.join(f.outputDir,'new.png'),{lookupImpl:publicLookup,requestImpl:redirectImpl}),/内部网络/);await assert.rejects(normalizeMedia(dest,'image/png'),/媒体文件头/);
 const svg=path.join(f.outputDir,'svg');await fs.writeFile(svg,'<svg></svg>');await assert.rejects(normalizeMedia(svg,'image/png'),/SVG/);
});
test('provider submits once and treats missing remote ID or chat stream EOF as uncertain',async()=>{
 const calls=[];const provider=createGrsai({grsaiApiKey:'fake-test-key'},{validateBaseImpl:async()=>{},fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({data:{status:'running'}});}});
 await assert.rejects(provider.submit({model:image.model,prompt:image.prompt}),/任务编号/);assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].options.body).replyType,'async');assert.equal(new URL(calls[0].url).origin,'https://grsai.dakka.com.cn');
 const chunks=[];const incomplete=createGrsai({grsaiApiKey:'fake-test-key'},{validateBaseImpl:async()=>{},fetchImpl:async()=>new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')});
 await assert.rejects(incomplete.chat({model:chat.model,messages:[],onChunk:value=>chunks.push(value)}),error=>error.code==='CHAT_STREAM_INCOMPLETE');assert.deepEqual(chunks,['hello']);
});

test('runner recommend refuses explicitly selected maintenance model without replacement',async()=>{
 const runner=createRunner();
 await assert.rejects(runner.recommend({type:'image',model:'gpt-image-2.5-flare',prompt:'A transparent shape',selection:{transparent:true}}),/模型|约束/);
});
test('explicit nano 2.1 rejects unsupported transparency even when 4K is requested',async()=>{
 const input={type:'image',model:'nano-banana-2.1',prompt:'A transparent shape',selection:{transparent:true,resolution:'4K'}};
 await assert.rejects(resolveRequest(input),/透明/);
 await assert.rejects(createRunner().recommend(input),/透明/);
});
test('explicit nano 2.1 keeps 4K canonical params and original model price',async()=>{
 const input={type:'image',model:'nano-banana-2.1',prompt:'A simple shape',selection:{resolution:'4K'}};
 const resolved=await resolveRequest(input);assert.equal(resolved.model.id,'nano-banana-2.1');assert.equal(resolved.request.params.imageSize,'4K');assert.equal(resolved.estimate.rawCredits,1200);
 const recommended=await createRunner().recommend(input);assert.equal(recommended.model,'nano-banana-2.1');assert.equal(recommended.params.imageSize,'4K');assert.equal(recommended.rawCredits,1200);
 await assert.rejects(resolveRequest({...input,params:{imageSize:'2K'}}),/冲突/);
});
