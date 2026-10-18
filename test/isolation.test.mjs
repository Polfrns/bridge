import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createBridge } from '../src/server.mjs';
import { verifyContext } from '../src/request-context.mjs';
import { resolveCliOptions, codexThreadOptions, codexHostConfig, claudeModelOptions } from '../src/cli-options.mjs';
import { createIsolatedRuntime, retainRefreshedCredential, removeIsolatedRuntime, acquireCredentialLease, claudeIsolatedEnv } from '../src/isolated-runtime.mjs';
import { signedHeaders } from './helpers/identity.mjs';
import { runtimeNamespace } from '../src/isolated-runtime.mjs';
import { win32 } from 'node:path';

const key = 'isolation-test-key-'.repeat(4);
const lowerHeaders = headers => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
const identity = overrides => verifyContext(lowerHeaders(signedHeaders(key, 'gpt-codex', overrides)), 'gpt-codex', key);

test('compact namespaces retain ownership and leave room for Windows Codex session paths', () => {
  const context = identity();
  const namespace = runtimeNamespace(context, 'codex');
  assert.match(namespace, /^[a-f0-9]{32}$/);
  assert.notEqual(namespace, runtimeNamespace(identity({userId:'user-b'}),'codex'));
  assert.notEqual(namespace, runtimeNamespace(identity({conversationId:'other'}),'codex'));
  assert.notEqual(namespace, runtimeNamespace(context,'claude'));
  const host = 'C:\\Users\\pol.fornas\\Proyectos\\ai-librechat-bridge';
  const session = 'rollout-2026-10-08T10-48-47-019abcd0-abcd-abcd-abcd-012345678901.jsonl';
  const old = win32.join(host,'runtime','users',context.userKey,context.conversationKey,'codex','run-ABCDEF','home','.codex','sessions','2026','10','08',session);
  const compact = win32.join(host,'runtime','r',namespace,'run-ABCDEF','home','.codex','sessions','2026','10','08',session);
  assert.ok(old.length > 260);
  assert.ok(compact.length < 240);
});

test('identity is backend signed, binds model/time and hashes tenant/user/conversation', () => {
  const first = identity();
  assert.notEqual(first.ownerKey, identity({ userId: 'user-b' }).ownerKey);
  assert.notEqual(first.ownerKey, identity({ conversationId: 'other' }).ownerKey);
  assert.notEqual(first.ownerKey, identity({ tenantId: 'other' }).ownerKey);
  assert.match(first.userKey, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyContext({}, 'gpt-codex', key), /Missing signed/);
  assert.throws(() => verifyContext(lowerHeaders(signedHeaders(key)), 'claude-max', key), /Invalid or expired/);
  assert.throws(() => identity({ timestamp: 1 }), /expired/);
  const tampered = lowerHeaders(signedHeaders(key));
  tampered['x-roko-context'] += 'x';
  assert.throws(() => verifyContext(tampered, 'gpt-codex', key), /signature/);
});

test('preset values and edited UI parameters reach native options without global mutation', () => {
  const env = { CODEX_MODEL: 'test-model', CLAUDE_MODEL: 'sonnet' };
  const deep = resolveCliOptions('gpt-codex-deep', {}, {}, env);
  const edited = resolveCliOptions('gpt-codex-deep', { reasoning: { effort: 'low' } }, { reasoning_effort: 'medium' }, env);
  assert.equal(deep.reasoning_effort, 'high');
  assert.equal(edited.reasoning_effort, 'low');
  assert.equal(resolveCliOptions('gpt-codex-deep', { reasoning_effort: '' }, {}, env).reasoning_effort, 'high');
  assert.equal(codexThreadOptions({ cliOptions: edited, webSearch: false }, '/workspace').modelReasoningEffort, 'low');
  assert.equal(codexThreadOptions({ cliOptions: edited, webSearch: false }, '/workspace').model, 'test-model');
  assert.deepEqual(claudeModelOptions(resolveCliOptions('claude-max-deep', {}, {}, env)), { model: 'opus', effort: 'high', persistSession: false });
  assert.deepEqual(env, { CODEX_MODEL: 'test-model', CLAUDE_MODEL: 'sonnet' });
  for (const value of [{ sandbox: 'danger-full-access' }, { args: [] }, { model: 'unapproved' }]) {
    assert.throws(() => resolveCliOptions('gpt-codex', { cli_options: value }, {}, env));
  }
  assert.throws(() => resolveCliOptions('claude-max', { reasoning_effort: 'ultra' }, {}, env));
  assert.throws(() => resolveCliOptions('claude-max', { verbosity: 'high' }, {}, env));
});

test('Windows native sandbox is explicitly configured by the host with bounded writes', () => {
  assert.deepEqual(codexHostConfig({},'win32'),{sandbox_mode:'workspace-write',approval_policy:'never',features:{shell_tool:true,unified_exec:false},windows:{sandbox:'unelevated'}});
  assert.equal(codexHostConfig({CODEX_WINDOWS_SANDBOX:'elevated'},'win32').windows.sandbox,'elevated');
  assert.throws(()=>codexHostConfig({CODEX_WINDOWS_SANDBOX:'danger-full-access'},'win32'),/must be/);
  assert.equal(codexHostConfig({},'linux').windows,undefined);
  assert.throws(()=>resolveCliOptions('gpt-codex',{cli_options:{windows_sandbox:'elevated'}}),/not user-configurable/);
});

test('Responses state cannot cross users, tenants, conversations or providers, and body.user is ignored', async t => {
  const inputs = [];
  const server = createBridge({ key, provider: async function* (request) { inputs.push(request); yield { text: 'ok' }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const post = (body, who = {}, model = 'gpt-codex') => fetch(url, { method: 'POST', headers: signedHeaders(key, model, who), body: JSON.stringify({ model, ...body }) });
  const result = await (await post({ input: 'private A', user: 'forged-B' })).json();
  for (const who of [{userId:'user-b'}, {tenantId:'tenant-b'}, {conversationId:'conversation-b'}]) {
    const response = await post({ previous_response_id: result.id, input: 'read previous' }, who);
    assert.equal(response.status, 400);
  }
  assert.equal((await post({ previous_response_id: result.id, input: 'read previous' }, {}, 'claude-max')).status, 400);
  assert.equal((await post({ previous_response_id: result.id, input: 'continue' })).status, 200);
  assert.equal((await post({ previous_response_id: result.id, input: 'same conversation, new preset' }, {}, 'gpt-codex-deep')).status, 200);
  assert.equal(inputs.length, 3);
  assert.match(inputs[1].prompt, /private A/);
  assert.equal(inputs[0].context.userKey, identity().userKey);
  const unsigned = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:'gpt-codex',input:'hi',user:'user-a'})});
  assert.equal(unsigned.status, 401);
});

test('isolated homes copy only login, remove sessions and keep refreshed shared credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'roko-isolation-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const auth = join(dir, 'auth'); await mkdir(auth);
  const authFile = join(auth, 'auth.json');
  await writeFile(authFile, JSON.stringify({tokens:{access_token:'old'}}));
  await writeFile(join(auth,'config.toml'), 'secret global instructions');
  const env = {CODEX_AUTH_DIR:auth,BRIDGE_DATA_DIR:join(dir,'runtime'),PATH:process.env.PATH,BRIDGE_API_KEY:'must not leak',OPENAI_API_KEY:'must not leak'};
  const request = {context:identity(),cliOptions:resolveCliOptions('gpt-codex',{}, {}, {})};
  const a = await createIsolatedRuntime(request, env);
  const b = await createIsolatedRuntime({...request,context:identity({userId:'user-b'})},env);
  assert.match(relative(env.BRIDGE_DATA_DIR, a.root).replaceAll('\\', '/'), /^r\/[a-f0-9]{32}\/run-[^/]+$/);
  assert.notEqual(a.cwd,b.cwd); assert.notEqual(a.env.CODEX_HOME,b.env.CODEX_HOME);
  assert.equal(a.env.BRIDGE_API_KEY,undefined); assert.equal(a.env.OPENAI_API_KEY,undefined);
  assert.equal(claudeIsolatedEnv(a.env, {BRIDGE_API_KEY:'secret'}).BRIDGE_API_KEY,undefined);
  await assert.rejects(access(join(a.env.CODEX_HOME,'config.toml')));
  await writeFile(join(a.env.CODEX_HOME,'auth.json'), JSON.stringify({tokens:{access_token:'new'}}));
  await retainRefreshedCredential(a);
  assert.equal(JSON.parse(await readFile(authFile,'utf8')).tokens.access_token,'new');
  await writeFile(authFile,JSON.stringify({tokens:{access_token:'external-login'}}));
  await retainRefreshedCredential(b);
  assert.equal(JSON.parse(await readFile(authFile,'utf8')).tokens.access_token,'external-login');
  await removeIsolatedRuntime(a); await removeIsolatedRuntime(b);
  await assert.rejects(access(a.root)); await assert.rejects(access(b.root));
  await writeFile(join(auth,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'claude-token'},personalSetting:'must not copy'}));
  const claude = await createIsolatedRuntime({...request,cliOptions:resolveCliOptions('claude-max-fast',{}, {}, {})},{...env,CLAUDE_AUTH_DIR:auth});
  const copied = JSON.parse(await readFile(join(claude.env.CLAUDE_CONFIG_DIR,'.credentials.json'),'utf8'));
  assert.deepEqual(copied,{claudeAiOauth:{accessToken:'claude-token'}});
  await assert.rejects(access(join(claude.env.CLAUDE_CONFIG_DIR,'projects')));
  await removeIsolatedRuntime(claude);
});

test('credential refresh leases serialize one provider while allowing the other', async () => {
  const signal = new AbortController().signal;
  const release = await acquireCredentialLease('codex',signal);
  let entered = false;
  const next = acquireCredentialLease('codex',signal).then(unlock => {entered=true;return unlock;});
  const claudeRelease = await acquireCredentialLease('claude',signal);
  await Promise.resolve(); assert.equal(entered,false);
  release(); (await next)(); claudeRelease();
  const holding = await acquireCredentialLease('codex',signal);
  const controller = new AbortController();
  const blocked = acquireCredentialLease('codex',controller.signal);
  controller.abort(new Error('cancel waiting request'));
  await assert.rejects(blocked,/cancel waiting/);
  holding(); (await acquireCredentialLease('codex',signal))();
});

