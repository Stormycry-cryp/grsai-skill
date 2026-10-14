import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeEnvironment, loadRuntime, main, SKILL_ROOT } from '../scripts/grsai.mjs';
const exec=promisify(execFile);
async function fixture(t){const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'grsai-init-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('first initialization writes only empty Key with 0600 permissions; environment Key is never copied',async t=>{
 const dir=await fixture(t),envFile=path.join(dir,'.env');
 const first=await initializeEnvironment(envFile,{env:{GRSAI_API_KEY:'fake-environment-key'}});
 assert.equal(first.created,true);assert.equal(first.key,'fake-environment-key');
 assert.equal(await fs.readFile(envFile,'utf8'),'GRSAI_API_KEY=\n');assert.equal((await fs.stat(envFile)).mode&0o777,0o600);
 const second=await initializeEnvironment(envFile,{env:{}});assert.equal(second.created,false);assert.equal(second.key,null);
});
test('existing .env is preserved exactly; filled Key continues and profiles are ignored',async t=>{
 const dir=await fixture(t),envFile=path.join(dir,'.env'),existing='GRSAI_API_KEY=fake-file-key\n';
 await fs.writeFile(envFile,existing,{mode:0o640});
 const oldHome=process.env.CODEX_HOME;process.env.CODEX_HOME=path.join(dir,'old-home');
 await fs.mkdir(path.join(process.env.CODEX_HOME,'private','grsai'),{recursive:true});await fs.writeFile(path.join(process.env.CODEX_HOME,'private','grsai','config.json'),'invalid profile must not be read');
 try{const runtime=await loadRuntime({envFile,env:{}});assert.equal(runtime.provider.health().configured,true);assert.equal(runtime.jobDir,path.join(SKILL_ROOT,'.local','jobs'));assert.equal(runtime.storage.upload,undefined);assert.equal(await fs.readFile(envFile,'utf8'),existing);assert.equal((await fs.stat(envFile)).mode&0o777,0o640);}finally{if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;}
});
test('missing Key returns structured configuration_required and never reads old profile',async t=>{
 const dir=await fixture(t),envFile=path.join(dir,'.env');const result=await loadRuntime({envFile,env:{}});
 assert.equal(result.status,'configuration_required');assert.equal(result.envFile,envFile);assert.equal(result.provider,undefined);
});
test('refuses existing symlink and symlink parent without changing target',async t=>{
 const dir=await fixture(t),target=path.join(dir,'target');await fs.writeFile(target,'DO_NOT_CHANGE');
 const link=path.join(dir,'.env');await fs.symlink(target,link);await assert.rejects(initializeEnvironment(link,{env:{}}));assert.equal(await fs.readFile(target,'utf8'),'DO_NOT_CHANGE');
 const real=path.join(dir,'real');await fs.mkdir(real);await fs.symlink(real,path.join(dir,'linked'));await assert.rejects(initializeEnvironment(path.join(dir,'linked','.env'),{env:{}}));await assert.rejects(fs.stat(path.join(real,'.env')),{code:'ENOENT'});
 await assert.rejects(initializeEnvironment('relative.env',{env:{}}),/绝对路径/);
});
test('help has no environment side effect',async t=>{
 const dir=await fixture(t),envFile=path.join(dir,'.env');assert.ok((await main(['--help','--env-file',envFile])).commands.length);await assert.rejects(fs.stat(envFile),{code:'ENOENT'});
});
test('Python launcher init works without Node and defaults to cloned Skill root',async t=>{
 const dir=await fixture(t),scripts=path.join(dir,'scripts');await fs.mkdir(scripts);await fs.copyFile(fileURLToPath(new URL('../scripts/run.py',import.meta.url)),path.join(scripts,'run.py'));
 const python=process.env.PYTHON??'/usr/bin/python3',env={PATH:path.join(dir,'empty-path'),HOME:dir,GRSAI_NODE:path.join(dir,'missing-node')};
 const invoke=args=>exec(python,[path.join(scripts,'run.py'),...args],{env});
 const result=JSON.parse((await invoke(['init'])).stdout);assert.equal(result.status,'configuration_required');assert.equal(result.nodeAvailable,false);assert.equal(result.envFile,path.join(dir,'.env'));assert.equal(await fs.readFile(result.envFile,'utf8'),'GRSAI_API_KEY=\n');assert.equal((await fs.stat(result.envFile)).mode&0o777,0o600);
 await fs.writeFile(result.envFile,'GRSAI_API_KEY=fake-key\n');assert.equal(JSON.parse((await invoke(['init'])).stdout).status,'configured');
 const external=path.join(dir,'external.env');assert.equal(JSON.parse((await invoke(['models','--env-file',external])).stdout).status,'configuration_required');assert.equal(await fs.readFile(external,'utf8'),'GRSAI_API_KEY=\n');
});
test('Python launcher does not overwrite or follow symlink; help creates no file',async t=>{
 const dir=await fixture(t),scripts=path.join(dir,'scripts');await fs.mkdir(scripts);await fs.copyFile(fileURLToPath(new URL('../scripts/run.py',import.meta.url)),path.join(scripts,'run.py'));
 const python=process.env.PYTHON??'/usr/bin/python3',env={PATH:path.join(dir,'missing'),HOME:dir};
 try{await exec(python,[path.join(scripts,'run.py'),'--help'],{env});}catch(error){assert.equal(JSON.parse(error.stdout).status,'dependency_required');}await assert.rejects(fs.stat(path.join(dir,'.env')),{code:'ENOENT'});
 const target=path.join(dir,'target');await fs.writeFile(target,'GRSAI_API_KEY=fake-key\n');await fs.symlink(target,path.join(dir,'.env'));await assert.rejects(exec(python,[path.join(scripts,'run.py'),'init'],{env}));assert.equal(await fs.readFile(target,'utf8'),'GRSAI_API_KEY=fake-key\n');
});
test('CLI requests configuration before Key, resumes offline after filling it, and rejects retired flags',async t=>{
 const dir=await fixture(t),envFile=path.join(dir,'.env'),script=fileURLToPath(new URL('../scripts/grsai.mjs',import.meta.url));
 const invoke=args=>exec(process.execPath,['--',script,...args],{env:{PATH:process.env.PATH}});
 const first=JSON.parse((await invoke(['models','--env-file',envFile])).stdout);assert.equal(first.status,'configuration_required');assert.equal(first.envFile,envFile);
 await fs.writeFile(envFile,'GRSAI_API_KEY=fake-filled-key\n');const second=JSON.parse((await invoke(['models','--env-file',envFile])).stdout);assert.ok(Array.isArray(second));assert.ok(second.length>0);
 for(const flag of ['--profile','--storage-config','--base-url'])await assert.rejects(invoke(['models',flag,path.join(dir,'old.json'),'--env-file',envFile]),error=>JSON.parse(error.stderr).error==='命令参数不支持');
 const cloned=path.join(dir,'cloned');await fs.mkdir(path.join(cloned,'scripts'),{recursive:true});await fs.copyFile(fileURLToPath(new URL('../scripts/run.py',import.meta.url)),path.join(cloned,'scripts','run.py'));
 await assert.rejects(exec(process.env.PYTHON??'/usr/bin/python3',[path.join(cloned,'scripts','run.py'),'models','--profile',path.join(dir,'old.json')],{env:{PATH:path.join(dir,'missing')}}));await assert.rejects(fs.stat(path.join(cloned,'.env')),{code:'ENOENT'});
});
