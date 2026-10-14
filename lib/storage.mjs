import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicAddress, publicHostname } from './dns.mjs';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
const exec = promisify(execFile);
sharp.cache({memory:32});
sharp.concurrency(1);
const imagePixelLimit=24000000,animationFrameLimit=32;
const limits={image:20*1024*1024,video:100*1024*1024,audio:30*1024*1024};
const extensions={'text/plain':'txt','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/flac':'flac','audio/mp4':'m4a','audio/webm':'webm'};
export { publicAddress } from './dns.mjs';
export async function validateDownloadUrl(value,{lookupImpl=lookup}={}) {
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')) throw new Error('结果地址必须使用公开HTTPS');
 const hostname=publicHostname(u.hostname);
 const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookupImpl(hostname,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address))) throw new Error('结果地址不允许访问内部网络');
 return {url:u,addresses};
}
export async function downloadMedia(url,destination,{maxBytes=limits.video,timeoutMs=120000,lookupImpl=lookup,requestImpl=https.request}={}) {
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 const partial=`${destination}.${randomUUID()}.part`;
 try {
  for(let redirects=0;redirects<=5;redirects++) {
   const checked=await validateDownloadUrl(url,{lookupImpl}), address=checked.addresses[0];
   const response=await new Promise((resolve,reject)=>{
    const request=requestImpl(checked.url,{signal:controller.signal,family:address.family,autoSelectFamily:false,lookup:(_h,options,cb)=>options?.all?cb(null,[{address:address.address,family:address.family}]):cb(null,address.address,address.family),headers:{Accept:'image/*,video/*,audio/*'}},resolve);
    request.on('error',reject);request.end();
   });
   if([301,302,303,307,308].includes(response.statusCode)) {
    const location=response.headers.location;response.resume();if(!location) throw new Error('结果跳转无效');url=new URL(location,checked.url).href;continue;
   }
   if(response.statusCode!==200){response.resume();throw new Error('结果下载失败');}
   if(+response.headers['content-length']>maxBytes){response.destroy();throw new Error('结果文件超出大小限制');}
   let count=0;const limiter=new Transform({transform(chunk,_encoding,cb){count+=chunk.length;cb(count>maxBytes?new Error('结果文件超出大小限制'):null,chunk);}});
   await fs.mkdir(path.dirname(destination),{recursive:true});
   await pipeline(response,limiter,createWriteStream(partial,{flags:'wx',mode:0o600}),{signal:controller.signal});
   await fs.link(partial,destination);await fs.unlink(partial);return destination;
  }
  throw new Error('结果跳转次数超出限制');
 }finally{clearTimeout(timer);await fs.rm(partial,{force:true});}
}
export async function normalizeMedia(filePath,_declaredMime) {
 const stat=await fs.stat(filePath);if(!stat.isFile()||stat.size<=0||stat.size>limits.video) throw new Error('文件大小无效');
 const head=Buffer.alloc(1024),file=await fs.open(filePath,'r');let bytesRead;try{({bytesRead}=await file.read(head,0,head.length,0));}finally{await file.close();}
 const markup=head.subarray(0,bytesRead).toString('utf8').replace(/^\uFEFF/,'').trimStart();
 if(/^(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(markup)) throw new Error('不支持SVG图片');
 let info,imageRecognized=false;
 try {
  const m=await sharp(filePath,{limitInputPixels:imagePixelLimit,animated:true}).metadata();
  const mime={jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',avif:'image/avif',...(m.compression==='av1'?{heif:'image/avif'}:{})}[m.format];
  if(!mime||!m.width||!m.height) throw new Error('图片格式或尺寸无效');
  imageRecognized=true;
  const frames=m.pages??1,height=m.pageHeight??m.height;
  if(frames>animationFrameLimit||m.width*height*frames>imagePixelLimit){const error=new Error('图片总像素或动画帧数超出限制');error.code='IMAGE_LIMIT';throw error;}
  await sharp(filePath,{limitInputPixels:imagePixelLimit,animated:true}).timeout({seconds:10}).stats();
  info={mime,type:'image',width:m.width,height};
 }catch(error) {
  if(error.code==='IMAGE_LIMIT'||/pixel limit/i.test(error.message))throw new Error('图片总像素或动画帧数超出限制');
  if(imageRecognized)throw new Error('图片内容无效或解码超时');
  const bytes=head.subarray(0,bytesRead);
  const recognized=bytes.subarray(4,8).toString()==='ftyp'||bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))||['ID3','OggS','fLaC'].some(x=>bytes.subarray(0,x.length).toString()===x)||(bytes[0]===255&&(bytes[1]&224)===224)||(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE');
  if(!recognized)throw new Error('媒体文件头无效');
  let data;try{const {stdout}=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',filePath],{timeout:15000,maxBuffer:1024*1024});data=JSON.parse(stdout);}catch{throw new Error('无法识别有效图片、视频或音频');}
  const video=data.streams?.find(s=>s.codec_type==='video'&&!s.disposition?.attached_pic),audio=data.streams?.find(s=>s.codec_type==='audio');
  const duration=Number(data.format?.duration);if(!Number.isFinite(duration)||duration<=0||(!video&&!audio)) throw new Error('媒体内容无效');
  const format=data.format?.format_name??'',isMp4=/mov|mp4/.test(format),isWebm=/webm|matroska/.test(format);
  const mime=video?(isMp4?'video/mp4':isWebm?'video/webm':null):isMp4?'audio/mp4':isWebm?'audio/webm':/mp3/.test(format)?'audio/mpeg':/wav/.test(format)?'audio/wav':/ogg/.test(format)?'audio/ogg':/flac/.test(format)?'audio/flac':null;
  if(!mime||video&&(!video.width||!video.height||video.width*video.height>100000000)) throw new Error('媒体格式或尺寸不支持');
  info={mime,type:video?'video':'audio',duration,...(video?{width:video.width,height:video.height}:{})};
 }
 if(stat.size>limits[info.type]) throw new Error('文件超出大小限制');
 const hash=createHash('sha256');for await(const chunk of createReadStream(filePath)) hash.update(chunk);
 return {...info,size:stat.size,sha256:hash.digest('hex')};
}
export function createStorage({lookupImpl}={}) {
 return {
  download:(url,destination,options={})=>downloadMedia(url,destination,{...options,...(lookupImpl?{lookupImpl}:{})}),
  normalize:normalizeMedia
 };
}
export const mediaExtensions = Object.freeze({...extensions});
