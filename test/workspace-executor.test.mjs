import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceExecutor, workspaceFileAllowed, runBoundedProcess } from '../src/workspace-executor.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "bridge exec's "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  return { root, cwd };
}

test('file access rejects traversal and symlink ancestors, accepts new workspace paths', async t => {
  const { root, cwd } = await workspace(t);
  assert.equal(await workspaceFileAllowed(cwd, '../secret'), false);
  assert.equal(await workspaceFileAllowed(cwd, join(root, 'secret')), false);
  assert.equal(await workspaceFileAllowed(cwd, 'outputs/new.txt'), true);
  assert.equal(await workspaceFileAllowed(cwd, ''), false);
  if (process.platform !== 'win32') {
    await symlink(root, join(cwd, 'escape'));
    assert.equal(await workspaceFileAllowed(cwd, 'escape/new.txt'), false);
    await writeFile(join(cwd, 'real.txt'), 'real');
    await symlink(join(cwd, 'real.txt'), join(cwd, 'alias.txt'));
    assert.equal(await workspaceFileAllowed(cwd, 'alias.txt'), false);
  }
});

test('shell config restricts reads/writes and removes model credentials and proxies', async t => {
  const { cwd } = await workspace(t);
  const executor = new WorkspaceExecutor(cwd, { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'secret', OPENAI_API_KEY: 'secret', HTTPS_PROXY: 'proxy', HOME: '/shared/auth' }, { hostEnv: {CODEX_EXECUTABLE: '/admin/codex'}, python: '/nonexistent/python' });
  await executor.initialize();
  assert.equal(executor.executable, '/admin/codex');
  assert.equal(executor.childEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(executor.childEnv.OPENAI_API_KEY, undefined);
  assert.equal(executor.childEnv.HTTPS_PROXY, undefined);
  assert.equal(executor.childEnv.HOME.startsWith(cwd), true);
  assert.equal(executor.childEnv.CODEX_HOME.startsWith(cwd), false);
  assert.ok(executor.prefix.includes('approval_policy="never"'));
  assert.ok(executor.prefix.includes('permissions.bridge-exec.network.enabled=false'));
  const policy = executor.prefix.find(arg => arg.startsWith('permissions.bridge-exec.filesystem='));
  assert.match(policy, /":root"="deny"/); assert.match(policy, /":minimal"="read"/);
  assert.ok(policy.includes(JSON.stringify(cwd) + '="write"'));
  assert.deepEqual(executor.shellArgs, ['/bin/sh', '-c']);
});

test('native Windows uses PowerShell through the configured OS sandbox, never host Bash', async t => {
  const { cwd } = await workspace(t);
  const executor = new WorkspaceExecutor(cwd, { SystemRoot: 'C:\\Windows' }, { platform:'win32', hostEnv:{CODEX_EXECUTABLE:'codex.exe',CODEX_WINDOWS_SANDBOX:'elevated'}, python:'/missing/python' });
  await executor.initialize();
  assert.ok(executor.prefix.includes('windows.sandbox="elevated"'));
  assert.equal(executor.shellArgs.at(-1), '-Command');
  assert.match(executor.shellArgs[0], /powershell.exe$/);
});

test('Linux sandbox can resolve the CLI helper alias while executor secrets remain denied', {skip:process.platform!=='linux'}, async t => {
  const {cwd}=await workspace(t);
  const executor=new WorkspaceExecutor(cwd,{PATH:process.env.PATH},{python:'/missing/python'});
  await executor.initialize();
  const policy=executor.prefix.find(arg=>arg.startsWith('permissions.bridge-exec.filesystem='));
  const entries=[...policy.matchAll(/("(?:[^"\\]|\\.)*")=("(?:[^"\\]|\\.)*")/g)]
    .map(match=>[JSON.parse(match[1]),JSON.parse(match[2])]);
  const rules=new Map(entries);
  const native=entries.find(([path,mode])=>path.includes('/@openai/codex-linux-') && path.endsWith('/bin/codex') && mode==='read')?.[0];
  assert.ok(native,'installed native executable is explicitly visible');
  const aliases=join(executor.configHome,'tmp','arg0');
  assert.equal(rules.get(aliases),'read');
  const run=join(aliases,'codex-arg0-test'); await mkdir(run);
  const helper=join(run,'codex-linux-sandbox'); await symlink(native,helper);
  assert.equal(await realpath(helper),native);
  // The CLI symlink and target are readable, but no ancestor grants access
  // to executor-config/private-probe.txt, credentials, or other workspaces.
  assert.equal(rules.get(':root'),'deny');
  assert.equal(rules.get(executor.configHome),undefined);
  assert.equal(rules.get(join(executor.configHome,'tmp')),undefined);
  assert.equal(rules.get(join(executor.configHome,'private-probe.txt')),undefined);
  assert.deepEqual(entries.filter(([,mode])=>mode==='write'),[[cwd,'write']]);
});

test('missing sandbox proof blocks the actual command with no unsandboxed fallback', async t => {
  const { cwd } = await workspace(t); let calls = 0;
  const executor = new WorkspaceExecutor(cwd, {PATH:process.env.PATH}, { hostEnv:{CODEX_EXECUTABLE:'test-cli'}, launch:async () => {calls++; return {exitCode:0,stdout:'',stderr:''};} });
  await assert.rejects(executor.execute('write deliverable'), /sandbox unavailable/);
  await assert.rejects(executor.execute('retry'), /sandbox unavailable/);
  assert.equal(calls,1);
});

test('one verified sandbox is reused and commands are serialized with bounded timeouts', async t => {
  const { cwd } = await workspace(t); let proofs = 0, running = 0, maximum = 0; const commands = [];
  const executor = new WorkspaceExecutor(cwd, {PATH:process.env.PATH}, { hostEnv:{CODEX_EXECUTABLE:'test-cli'}, launch:async (spec, options) => {
    const command=spec.args.at(-1);
    assert.equal(options.timeout <= 120000,true);
    if (command.startsWith('set -eu;')) {
      proofs++;
      const match=/printf '%s' '([a-f0-9-]+)' >'((?:[^']|'\\'')*)'$/.exec(command);
      assert.ok(match); await writeFile(match[2].replaceAll("'\\''", "'"),match[1]);
    } else {
      maximum=Math.max(maximum,++running); commands.push(command);
      await new Promise(done=>setTimeout(done,5)); running--;
    }
    return {exitCode:0,stdout:'okay',stderr:''};
  }});
  await Promise.all([executor.execute('first'),executor.execute('second')]);
  assert.equal(proofs,1); assert.equal(maximum,1); assert.deepEqual(commands,['first','second']);
  await assert.rejects(executor.execute('third',{timeout:130000}),/timeout/);
  await assert.rejects(executor.execute(''),/command/);
});

test('Linux proof accepts writes confined to synthetic namespace parents, without any provider login', {skip:process.platform!=='linux'}, async t => {
  const {root,cwd}=await workspace(t);
  const synthetic=join(root,'synthetic-config'); await mkdir(synthetic);
  let executor;
  executor=new WorkspaceExecutor(cwd,{PATH:'/bin'}, {platform:'linux',hostEnv:{},launch:async spec=>{
    assert.equal(spec.env.OPENAI_API_KEY,undefined);
    assert.equal(spec.env.CLAUDE_CODE_OAUTH_TOKEN,undefined);
    // Execute the real probe script against a simulated mount namespace:
    // outside paths address a separate empty tree; the workspace remains bound.
    const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
    const secret=join(executor.configHome,'private-probe.txt');
    const script=spec.args.at(-1)
      .replaceAll(quote(secret),quote(join(synthetic,'private-probe.txt')))
      .replaceAll(quote(secret+'.write'),quote(join(synthetic,'private-probe.txt.write')));
    return runBoundedProcess({executable:'/bin/sh',args:['-c',script],cwd,env:spec.env});
  }});
  const proof=await executor.verify();
  assert.equal(proof.workspaceWrite,true); assert.equal(proof.outsideWriteDenied,true);
  assert.equal(await readFile(join(synthetic,'private-probe.txt.write'),'utf8'),'bad');
  assert.equal(await readFile(join(synthetic,'private-probe.txt'),'utf8'),'bad');
  await assert.rejects(readFile(join(executor.configHome,'private-probe.txt.write')),{code:'ENOENT'});
});

for (const violation of ['create','overwrite','delete','symlink']) {
  test(`host verification rejects real outside-workspace ${violation} even if the shell reports success`, {skip:violation==='symlink' && process.platform==='win32'}, async t=>{
    const {root,cwd}=await workspace(t); let executor, calls=0;
    executor=new WorkspaceExecutor(cwd,{PATH:process.env.PATH},{platform:'linux',hostEnv:{CODEX_EXECUTABLE:'test-cli'},launch:async spec=>{
      calls++;
      const command=spec.args.at(-1);
      const match=/printf '%s' '([a-f0-9-]+)' >'((?:[^']|'\\'')*)'$/.exec(command);
      assert.ok(match); await writeFile(match[2].replaceAll("'\\''", "'"),match[1]);
      const secret=join(executor.configHome,'private-probe.txt');
      if(violation==='create') await writeFile(secret+'.write','bad');
      if(violation==='overwrite') await writeFile(secret,'bad');
      if(violation==='delete') await rm(secret);
      if(violation==='symlink') {
        const alias=join(root,'replacement'); await writeFile(alias,await readFile(secret));
        await rm(secret); await symlink(alias,secret);
      }
      return {exitCode:0,stdout:'okay',stderr:''};
    }});
    await assert.rejects(executor.execute('actual user command'),/sandbox unavailable/i);
    await assert.rejects(executor.execute('retry'),/sandbox unavailable/i);
    assert.equal(calls,1,'no user command runs after a failed proof');
  });
}

for (const exitCode of [73,74]) {
  test(`proof preserves nonzero exit ${exitCode} and supplies a diagnostic when stderr is empty`,async t=>{
    const {cwd}=await workspace(t);
    const executor=new WorkspaceExecutor(cwd,{PATH:process.env.PATH},{hostEnv:{CODEX_EXECUTABLE:'test-cli'},launch:async()=>({exitCode,stdout:'',stderr:''})});
    await assert.rejects(executor.verify(),error=>error.message.includes(`exit ${exitCode}`) && error.message.includes(exitCode===73?'could read':'reported an outside-workspace write'));
  });
}

test('process runner preserves command exit status and output without host shell expansion', async () => {
  const result=await runBoundedProcess({executable:process.execPath,args:['-e','process.stdout.write("literal $HOME");process.stderr.write("failure");process.exit(7)'],env:{},cwd:tmpdir()});
  assert.equal(result.exitCode,7); assert.equal(result.stdout,'literal $HOME'); assert.equal(result.stderr,'failure');
});

test('runner stops on timeout, cancellation, and output overflow', async () => {
  const spec={executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{},cwd:tmpdir()};
  await assert.rejects(runBoundedProcess(spec,{timeout:100}),/timed out/);
  const controller=new AbortController();setTimeout(()=>controller.abort(new Error('cancelled by test')),100);
  await assert.rejects(runBoundedProcess(spec,{signal:controller.signal}),/cancelled by test/);
  await assert.rejects(runBoundedProcess({...spec,args:['-e','process.stdout.write("x".repeat(100000))']},{maxBytes:100}),/output limit/);
});

test('timeout kills descendants before they can write a delayed artifact', {skip:process.platform==='win32'}, async t => {
  const {cwd}=await workspace(t);const output=join(cwd,'leak.txt');
  const nested=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(output)},'leak'),400)`;
  const code=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  await assert.rejects(runBoundedProcess({executable:process.execPath,args:['-e',code],cwd,env:{}},{timeout:100}),/timed out/);
  await new Promise(done=>setTimeout(done,500));
  await assert.rejects(readFile(output), {code:'ENOENT'});
});
