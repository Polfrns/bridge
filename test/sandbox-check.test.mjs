import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWindowsSandbox } from '../src/sandbox-check.mjs';

async function runtime(t) {
  const cwd = await mkdtemp(join(tmpdir(), "bridge check's "));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  return {cwd,env:{CODEX_HOME:join(cwd,'home','.codex'),HOME:join(cwd,'home')}};
}
const options = {env:{CODEX_EXECUTABLE:'codex.exe'},powershell:'powershell.exe',python:'/nonexistent-python'};

test('native probe rejects a successful exit without an actual workspace write', async t => {
  await assert.rejects(checkWindowsSandbox(await runtime(t),{...options,env:{},nodePath:'node.exe',launcherPath:'codex.js',launch:(executable,args)=>{
    assert.equal(executable,'node.exe');
    assert.equal(args[0],'codex.js');
    assert.deepEqual(args.slice(args.indexOf('sandbox'),-1),['sandbox','--','powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-Command']);
    return {status:0};
  }}),/did not create its write proof/);
});

test('native probe reports execution failures rather than treating them as unsupported edits', async t => {
  await assert.rejects(checkWindowsSandbox(await runtime(t),{...options,launch:()=>({status:1,stderr:'Access is denied'})}),/unelevated, exit 1.*Access is denied/);
});

test('probe verifies workspace proof and executes the Office fixture with real Python', {skip:process.platform==='win32'}, async t => {
  const run = await runtime(t);
  const python = spawnSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).stdout.trim();
  await checkWindowsSandbox(run,{
    ...options,python,
    launch:(executable,args,config)=>{
      assert.equal(executable,'codex.exe');
      assert.equal(config.env.CODEX_HOME,run.env.CODEX_HOME);
      assert.equal(config.shell,false);
      assert.ok(args.includes('sandbox_mode="workspace-write"'));
      assert.ok(args.includes('windows.sandbox="unelevated"'));
      assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
      assert.deepEqual(args.slice(args.indexOf('sandbox'),-1),['sandbox','--','powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-Command']);
      const command=args.at(-1);
      const proof=/::WriteAllText\('((?:[^']|'')*)','([a-f0-9-]+)'\)/.exec(command);
      assert.ok(proof);
      // This launcher substitutes PowerShell only; the Office code actually runs.
      return spawnSync(python,['-c',`from pathlib import Path\nPath(${JSON.stringify(proof[1].replaceAll("''","'"))}).write_text(${JSON.stringify(proof[2])})\nexec(Path('work/sandbox-office-probe.py').read_text())`],{cwd:config.cwd,encoding:'utf8'});
    },
  }).then(result=>{
    assert.equal(result.workspaceWrite,true);
    assert.equal(result.officePython,'DOCX red text verified');
  });
});
