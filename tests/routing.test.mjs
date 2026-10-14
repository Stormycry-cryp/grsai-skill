import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, getModel, validateRequest, estimateCredits, usageCredits } from '../lib/model-contract.mjs';
import { recommend } from '../lib/routing.mjs';

const image = (extra={}) => ({type:'image',prompt:'Create a geometric poster',...extra});
const chat = (extra={}) => ({type:'chat',prompt:'Summarize this text',...extra});
const video = (extra={}) => ({type:'video',prompt:'A person walks across a garden',...extra});
const exampleImage='https://example.com/reference.png';
const exampleMask='https://example.com/mask.png';
const rejected = fn => assert.throws(fn,error=>['NO_COMPATIBLE_MODEL','INVALID_MODEL_PARAMS'].includes(error.code));

test('public catalog keeps all 33 models and raw prices without verification fields',()=>{
 assert.equal(MODEL_CATALOG.length,33);
 assert.equal(new Set(MODEL_CATALOG.map(m=>m.id)).size,33);
 assert.equal(getModel('nano-banana-2.1').price.credits,1200);
 assert.equal(getModel('gpt-6.1-sol').price.input,18000);
 assert(MODEL_CATALOG.every(m=>!Object.hasOwn(m,'verification')));
 assert.equal(getModel('gpt-image-2.5-sunburst').maintenance,true);
});

test('simple text and code selection record inference rather than personal observations',()=>{
 const simple=recommend(chat());
 const code=recommend(chat({selection:{intent:'code'}}));
 assert.equal(simple.model,'gemini-3.1-flash-lite');
 assert.equal(code.model,'gpt-6.1-sol');
 for(const r of [simple,code]){
  assert(Number.isSafeInteger(r.rawCredits));
  assert(r.evidence.every(e=>['interface','inference','unknown'].includes(e.basis)));
 }
});

test('vision accepts explicit GPT and keeps GPT as an automatic compatible alternative',()=>{
 const automatic=recommend(chat({images:[exampleImage]}));
 assert.equal(automatic.model,'gemini-3.1-flash-lite');
 assert(automatic.alternatives.some(m=>m.model==='gpt-6.1-sol'));
 const explicit=recommend(chat({images:[exampleImage],model:'gpt-6.1-sol'}));
 assert.equal(explicit.model,'gpt-6.1-sol');
 assert(explicit.evidence.some(e=>e.rule==='vision'&&e.basis==='interface'));
});

test('all references must be HTTPS URLs',()=>{
 for(const url of ['https:example.com/reference.png',' https://example.com/reference.png','http://example.com/reference.png','file:///tmp/image.png','/tmp/image.png','data:image/png;base64,AA==','https://user:pass@example.com/x']){
  rejected(()=>recommend(image({images:[url]})));
  rejected(()=>recommend(video({audios:[url]})));
  rejected(()=>recommend(image({images:[exampleImage],mask:url})));
 }
 assert.equal(recommend(image({images:[exampleImage]})).model,'nano-banana-2.1');
});

test('raw integer budgets filter costs and reject invalid or retired budget fields',()=>{
 assert.equal(recommend(image({selection:{priority:'budget',maxCredits:440}})).rawCredits,440);
 rejected(()=>recommend(image({selection:{maxCredits:439}})));
 rejected(()=>recommend(image({selection:{maxCredits:0}})));
 for(const maxCredits of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'600'])rejected(()=>recommend(image({selection:{maxCredits}})));
 rejected(()=>recommend(image({selection:{maxPoints:6}})));
 const r=recommend(image({selection:{maxCredits:600}}));
 assert.equal(r.model,'gpt-image-2.5');
 assert(r.alternatives.every(m=>m.rawCredits<=600));
});

test('explicit model is never replaced for budget, maintenance, type or unsupported size',()=>{
 for(const request of [
  image({model:'nano-banana-2.1',selection:{maxCredits:600}}),
  image({model:'gpt-image-2.5-flare'}),
  image({model:'gpt-6.1-sol'}),
  image({model:'gpt-image-2.5',selection:{resolution:'4K'}}),
 ])rejected(()=>recommend(request));
});

test('transparent output and masks retain required capabilities',()=>{
 const transparent=recommend(image({selection:{transparent:true,resolution:'2K'}}));
 assert.equal(transparent.model,'gpt-image-2-vip');
 assert.equal(transparent.params.background,'transparent');
 assert.equal(transparent.params.aspectRatio,'2048x2048');
 const masked=recommend(image({images:[exampleImage],mask:exampleMask}));
 assert.equal(masked.model,'gpt-image-2.5');
 assert.equal(masked.params.maskAssetId,'mask');
 rejected(()=>recommend(image({mask:exampleMask})));
 rejected(()=>recommend(image({model:'nano-banana-2.1',images:[exampleImage],mask:exampleMask})));
 rejected(()=>recommend(chat({transparent:true})));
});

test('resolution and aspect ratio remain hard constraints',()=>{
 const large=recommend(image({selection:{resolution:'4K',aspectRatio:'16:9'}}));
 assert.equal(large.params.imageSize,'4K');
 assert.equal(large.params.aspectRatio,'16:9');
 const gpt=recommend(image({model:'gpt-image-2-vip',selection:{resolution:'4K',aspectRatio:'16:9'}}));
 assert.equal(gpt.params.aspectRatio,'3840x2160');
 rejected(()=>recommend(image({model:'gpt-image-2-vip',selection:{resolution:'2K',aspectRatio:'3840x2160'}})));
 rejected(()=>recommend(image({params:{aspectRatio:'1:1'},selection:{aspectRatio:'16:9'}})));
 rejected(()=>recommend(image({params:{imageSize:'1K'},selection:{resolution:'2K'}})));
 rejected(()=>recommend(image({model:'nano-banana-2-lite',selection:{resolution:'2K'}})));
});

test('VIP custom dimensions follow public interface bounds',()=>{
 assert.equal(validateRequest('gpt-image-2-vip',{aspectRatio:'1600x1024'}),true);
 for(const aspectRatio of ['4096x4096','1601x1024','3200x800','640x640'])rejected(()=>validateRequest('gpt-image-2-vip',{aspectRatio}));
});

test('video duration, resolution and references are checked without shortening',()=>{
 const r=recommend(video({selection:{resolution:'2k',duration:12,aspectRatio:'21:9'}}));
 assert.equal(r.model,'agnes-video-2.5');
 assert.equal(r.params.duration,12);
 assert.equal(r.params.aspectRatio,'21:9');
 assert.equal(r.rawCredits,55200);
 rejected(()=>recommend(video({model:'minimax-h3',selection:{resolution:'1080p',duration:11}})));
 rejected(()=>recommend(video({selection:{duration:16}})));
 rejected(()=>recommend(video({model:'agnes-video-2.5',selection:{duration:3}})));
 rejected(()=>recommend(video({images:Array(10).fill(exampleImage)})));
 rejected(()=>recommend(video({audios:Array(4).fill('https://example.com/audio.mp3')})));
});

test('unsupported strict video capabilities fail before choosing a model',()=>{
 for(const key of ['firstLastFrames','lipSync','nativeAudio'])rejected(()=>recommend(video({selection:{[key]:true}})));
});

test('reference caps and parameter compatibility apply to explicit requests',()=>{
 rejected(()=>recommend(chat({images:Array(17).fill(exampleImage)})));
 rejected(()=>recommend(image({params:{temperature:1}})));
 rejected(()=>recommend(chat({params:{maxTokens:8193}})));
 rejected(()=>recommend(chat({audios:['https://example.com/audio.mp3']})));
 rejected(()=>validateRequest('gpt-image-2.5',{},null));
});

test('fee helpers use raw credits, duration and valid cached usage',()=>{
 assert.equal(estimateCredits('gpt-image-2.5'),600);
 assert.equal(estimateCredits('minimax-h3',{resolution:'480p',aspectRatio:'landscape',duration:5}),5000);
 const plain=estimateCredits('gemini-3.1-flash-lite',{maxTokens:1},'hello',0);
 const vision=estimateCredits('gemini-3.1-flash-lite',{maxTokens:1},'hello',1);
 assert(vision>plain);
 assert.equal(usageCredits('gpt-6.1-sol',{prompt_tokens:1000000,completion_tokens:1000000,prompt_tokens_details:{cached_tokens:500000}}),99900);
 assert.equal(usageCredits('gpt-6.1-sol',{prompt_tokens:1000000,completion_tokens:0,prompt_tokens_details:{cached_tokens:1000001}}),18000);
 assert.equal(usageCredits('gpt-6.1-sol',{prompt_tokens:-1,completion_tokens:0}),null);
 assert.equal(usageCredits('gpt-image-2.5',{prompt_tokens:1,completion_tokens:1}),null);
 assert.equal(usageCredits('gpt-6.1-sol',null),null);
 rejected(()=>estimateCredits('minimax-h3',{resolution:'1080p',aspectRatio:'landscape',duration:11}));
});
