import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {checkSandbox} from '../src/sandbox-check.mjs';
import {runtimePython,assertCompatiblePythonEnvironment} from '../src/platform.mjs';

async function runtime(t) {
  const root=await mkdtemp(join(tmpdir(), "Linux bridge's $(unused) "));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=join(root,'workspace');await mkdir(cwd);
  return {root,cwd,env:{PATH:process.env.PATH,HOME:join(root,'home'),CODEX_HOME:join(root,'home','.codex')}};
}

test('host Python paths differ and foreign virtualenvs are rejected without modifying them',async t=>{
  const {root}=await runtime(t);
  assert.equal(runtimePython({root,platform:'linux'}),join(root,'runtime-tools','bin','python'));
  assert.equal(runtimePython({root,platform:'win32'}),join(root,'runtime-tools','Scripts','python.exe'));
  const venv=join(root,'runtime-tools');await mkdir(join(venv,'Scripts'),{recursive:true});
  await writeFile(join(venv,'Scripts','python.exe'),'Windows fixture');
  assert.throws(()=>assertCompatiblePythonEnvironment(venv,'linux'),/another OS/);
  assert.doesNotThrow(()=>assertCompatiblePythonEnvironment(venv,'win32'));
  await mkdir(join(venv,'bin'));await writeFile(join(venv,'bin','python'),'Linux fixture');
  assert.throws(()=>assertCompatiblePythonEnvironment(venv,'win32'),/another OS/);
});

test('Linux probe uses native command syntax and executes its quoted shell and DOCX fixture', {skip:process.platform==='win32'},async t=>{
  const run=await runtime(t);
  const python=spawnSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).stdout.trim();
  let called=false;
  const result=await checkSandbox(run,{platform:'linux',env:{CODEX_EXECUTABLE:'/opt/codex'},python,launch:(executable,args,config)=>{
    called=true;
    assert.equal(executable,'/opt/codex');assert.equal(config.cwd,run.cwd);assert.equal(config.env,run.env);assert.equal(config.shell,false);
    assert.ok(args.includes('sandbox_mode="workspace-write"'));assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
    assert.ok(!args.some(arg=>arg.includes('windows.sandbox')));
    assert.deepEqual(args.slice(args.indexOf('sandbox'),-1),['sandbox','--','/bin/sh','-c']);
    // Substitute only the Codex launcher; execute the emitted shell and actual Python.
    return spawnSync('/bin/sh',['-c',args.at(-1)],config);
  }});
  assert.equal(called,true);assert.equal(result.platform,'linux');assert.equal(result.workspaceWrite,true);assert.equal(result.officePython,'DOCX red text verified');
});

test('Linux failures and missing file proofs never become successful checks',async t=>{
  const run=await runtime(t);
  const options={platform:'linux',python:'/missing/python',launcherPath:'codex.js',env:{},nodePath:'node'};
  await assert.rejects(checkSandbox(run,{...options,launch:(executable,args)=>{assert.equal(executable,'node');assert.equal(args[0],'codex.js');return {status:0};}}),/did not create/);
  await assert.rejects(checkSandbox(run,{...options,launch:()=>({status:1,stderr:'sandbox failed: Operation not permitted'})}),/Linux.*Operation not permitted/);
  await assert.rejects(checkSandbox(run,{platform:'unsupported'}),/supports Windows and Linux/);
});

import { configureUbuntuHost } from '../src/ubuntu-config.mjs';

test('Ubuntu Docker binding retains keys and options, rejecting ambiguous or public fallback bindings',()=>{
  const env='BRIDGE_API_KEY=private-fixture\nBRIDGE_HOST=127.0.0.1\nCODEX_MODEL=selected-model\n';
  assert.equal(configureUbuntuHost(env,'172.17.0.1'),'BRIDGE_API_KEY=private-fixture\nBRIDGE_HOST=172.17.0.1\nCODEX_MODEL=selected-model\n');
  assert.equal(configureUbuntuHost('BRIDGE_API_KEY=private-fixture','172.18.0.1'),'BRIDGE_API_KEY=private-fixture\nBRIDGE_HOST=172.18.0.1\n');
  for(const address of [undefined,'','0.0.0.0','127.0.0.1','bridge-host','$(command)','172.17.0.999']) assert.throws(()=>configureUbuntuHost(env,address));
  assert.throws(()=>configureUbuntuHost('BRIDGE_HOST=one\nBRIDGE_HOST=two\n','172.17.0.1'),/Duplicate/);
});

import {readFile,copyFile,stat,chmod} from 'node:fs/promises';

test('Ubuntu setup detects Docker IP through the real script and preserves or creates private configuration', {skip:process.platform==='win32'}, async t=>{
  const {root}=await runtime(t);const project=join(root,'bridge');const bin=join(root,'bin');
  await mkdir(join(project,'scripts'),{recursive:true});await mkdir(join(project,'src'));await mkdir(bin);
  for(const file of ['scripts/setup-ubuntu.mjs','src/platform.mjs','src/ubuntu-config.mjs','.env.example']) await copyFile(new URL('../'+file,import.meta.url),join(project,file));
  await writeFile(join(project,'package.json'),'{"type":"module"}');
  const docker=join(bin,'docker');await writeFile(docker,`#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'network inspect bridge') process.exit(1);
console.log(JSON.stringify([{IPAM:{Config:[{Gateway:'172.30.0.1'}]}}]));
`);await chmod(docker,0o755);
  const envPath=join(project,'.env');const original='BRIDGE_API_KEY=private-test-key\nBRIDGE_HOST=127.0.0.1\nCODEX_MODEL=custom-model\n';
  await writeFile(envPath,original);
  const run=()=>spawnSync(process.execPath,[join(project,'scripts/setup-ubuntu.mjs')],{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8'});
  const changed=run();assert.equal(changed.status,0,changed.stderr);assert.ok(!changed.stdout.includes('private-test-key'));
  assert.equal(await readFile(envPath,'utf8'),original.replace('127.0.0.1','172.30.0.1'));
  assert.equal((await stat(envPath)).mode & 0o777,0o600);
  await rm(envPath);const fresh=run();assert.equal(fresh.status,0,fresh.stderr);
  const created=await readFile(envPath,'utf8');assert.match(created,/BRIDGE_API_KEY=[a-f0-9]{64}/);assert.match(created,/BRIDGE_HOST=172.30.0.1/);
  await writeFile(envPath,'BRIDGE_HOST=one\nBRIDGE_HOST=two\n');const failed=run();assert.equal(failed.status,1);assert.equal(await readFile(envPath,'utf8'),'BRIDGE_HOST=one\nBRIDGE_HOST=two\n');
});
