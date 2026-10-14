import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DOH_ENDPOINT='https://cloudflare-dns.com/dns-query';
export function publicAddress(ip) {
 if(isIP(ip)===4) {const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);}
 if(isIP(ip)===6) {const first=ip.toLowerCase();const second=first.startsWith('2001:')?parseInt(first.split(':')[1]||'0',16):null;return /^[23][0-9a-f]{3}:/i.test(ip)&&!(second!==null&&(second<512||second===0xdb8))&&!/^2002:|^3fff:/i.test(ip);}
 return false;
}
export function publicHostname(value){
 if(typeof value!=='string')throw new Error('公共DNS主机名无效');
 const hostname=value.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
 if(isIP(hostname)){if(!publicAddress(hostname))throw new Error('地址不允许访问内部网络');return hostname;}
 if(hostname.length>253||!hostname.includes('.')||!hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||/(?:^|\.)(?:localhost|localdomain|local|internal|lan|invalid|test|onion)$/.test(hostname)||hostname==='home.arpa'||hostname.endsWith('.home.arpa'))throw new Error('地址不允许访问内部网络');
 return hostname;
}

/** Default uses the operating system; the only alternative is fixed Cloudflare HTTPS DNS. */
export function createDnsLookup(mode='system',{fetchImpl=fetch,systemLookupImpl=systemLookup,now=Date.now,cacheLimit=128,maxTtlMs=30000}={}){
 if(mode==='system'||mode===undefined)return systemLookupImpl;
 if(mode!=='cloudflare')throw new Error('dnsMode仅支持system或cloudflare');
 const cache=new Map(),inflight=new Map(),limit=Math.max(1,Math.min(128,Number.isInteger(cacheLimit)?cacheLimit:128)),ttlLimit=Math.max(0,Math.min(30000,Number.isFinite(maxTtlMs)?maxTtlMs:30000));
 async function query(hostname){
  const cached=cache.get(hostname);if(cached&&cached.expires>now()){cache.delete(hostname);cache.set(hostname,cached);return cached.addresses.map(item=>({...item}));}cache.delete(hostname);
  if(inflight.has(hostname))return inflight.get(hostname);
  if(inflight.size>=limit)throw new Error('公共DNS查询过多');
  const pending=(async()=>{
   try{
    const url=new URL(DOH_ENDPOINT);url.searchParams.set('name',hostname);url.searchParams.set('type','A');
    const response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/dns-json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('DNS HTTP failure');
    const text=await response.text();if(Buffer.byteLength(text)>65536)throw new Error('DNS response too large');const data=JSON.parse(text);
    if(data.Status!==0||!Array.isArray(data.Answer)||data.Answer.length>64)throw new Error('DNS response invalid');
    const sections=['Answer','Authority','Additional'].flatMap(key=>{if(data[key]===undefined)return [];if(!Array.isArray(data[key])||data[key].length>64)throw new Error('DNS section invalid');return data[key];});
    const records=sections.filter(record=>record.type===1||record.type===28);
    if(!records.length||records.some(record=>!publicAddress(record.data)||isIP(record.data)!==(record.type===1?4:6)))throw new Error('DNS response is not public');
    for(const record of sections)if(record.type===5)publicHostname(record.data);
    const addresses=[...new Map(data.Answer.filter(record=>record.type===1).map(record=>[record.data,{address:record.data,family:4}])).values()];if(!addresses.length)throw new Error('DNS A response missing');
    const ttl=Math.min(ttlLimit,...records.map(record=>Number.isFinite(record.TTL)&&record.TTL>=0?record.TTL*1000:0));
    if(ttl>0){while(cache.size>=limit)cache.delete(cache.keys().next().value);cache.set(hostname,{addresses,expires:now()+ttl});}
    return addresses.map(item=>({...item}));
   }catch{throw new Error('可信公共DNS解析失败，未使用系统DNS回退');}
  })();inflight.set(hostname,pending);try{return await pending;}finally{inflight.delete(hostname);}
 }
 return async function lookup(hostname,options={}){
  hostname=publicHostname(hostname);const family=typeof options==='number'?options:options.family??0;if(![0,4,6].includes(family))throw new Error('DNS地址类型无效');
  const literal=isIP(hostname),all=typeof options==='object'&&options.all;
  const addresses=(literal?[{address:hostname,family:literal}]:await query(hostname)).filter(item=>!family||item.family===family);
  if(!addresses.length)throw new Error('公共DNS未返回所需地址类型');return all?addresses:{...addresses[0]};
 };
}
