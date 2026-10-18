import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { containerCommand } from '../scripts/container-cli.mjs';

test('container login resolves the pinned SDK binaries and explicitly stores Codex file credentials', () => {
  const calls = [];
  const options = { root: '/app', node: '/usr/bin/node', platform: 'linux', arch: 'arm64', resolveModule: name => { calls.push(name); return name.includes('codex') ? '/sdk/codex/package.json' : '/sdk/claude'; } };
  assert.deepEqual(containerCommand('codex', ['login', '--device-auth'], options), { executable: '/usr/bin/node', args: [join('/sdk/codex', 'bin', 'codex.js'), '-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'] });
  assert.deepEqual(containerCommand('claude', ['auth', 'login'], options), { executable: '/sdk/claude', args: ['auth', 'login'] });
  assert.deepEqual(calls, ['@openai/codex/package.json', '@anthropic-ai/claude-agent-sdk-linux-arm64/claude']);
  assert.throws(() => containerCommand('claude', [], { ...options, arch: 'unsupported' }), /x64 or ARM64/);
  assert.throws(() => containerCommand('claude', [], { ...options, platform: 'win32' }), /Linux/);
  assert.throws(() => containerCommand('unknown', [], options));
  assert.throws(() => containerCommand('serve', ['unexpected'], options));
});

async function fixture(t, program) {
  const root = await mkdtemp(join(tmpdir(), 'bridge container '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['src', 'scripts', 'node_modules/@openai/codex/bin']) await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(new URL('../src/platform.mjs', import.meta.url), join(root, 'src/platform.mjs'));
  await copyFile(new URL('../scripts/container-cli.mjs', import.meta.url), join(root, 'scripts/container-cli.mjs'));
  await writeFile(join(root, 'node_modules/@openai/codex/package.json'), '{"name":"@openai/codex","type":"module"}');
  await writeFile(join(root, 'node_modules/@openai/codex/bin/codex.js'), program);
  return root;
}

test('real container command runs SDK login without shell expansion and propagates failures', async t => {
  const root = await fixture(t, `import {writeFileSync} from 'node:fs';writeFileSync(process.env.LOGIN_PROOF,JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME}));process.exit(7);`);
  const proof = join(root, 'proof.json');
  const result = spawnSync(process.execPath, [join(root, 'scripts/container-cli.mjs'), 'codex', 'login', '--device-auth', '$(not-a-command)'], { env: { ...process.env, CODEX_HOME: '/auth/codex', LOGIN_PROOF: proof }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(proof, 'utf8')), { args: ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth', '$(not-a-command)'], home: '/auth/codex' });
});

test('real command resolves the Linux Claude SDK and preserves its login arguments', { skip: process.platform !== 'linux' }, async t => {
  const root = await fixture(t, '');
  const packageRoot = join(root, `node_modules/@anthropic-ai/claude-agent-sdk-linux-${process.arch}`);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}');
  const executable = join(packageRoot, 'claude');
  await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),dir:process.env.CLAUDE_CONFIG_DIR}));`);
  await chmod(executable, 0o755);
  const result = spawnSync(process.execPath, [join(root, 'scripts/container-cli.mjs'), 'claude', 'auth', 'login'], { env: { ...process.env, CLAUDE_CONFIG_DIR: '/auth/claude' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['auth', 'login'], dir: '/auth/claude' });
});

test('container stop forwards SIGTERM to the CLI so provider cleanup can run', { skip: process.platform === 'win32', timeout: 6000 }, async t => {
  const root = await fixture(t, `import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{writeFileSync(process.env.STOP_PROOF,'stopped');process.exit(0)});console.log('ready');setTimeout(()=>process.exit(0),2000);`);
  const proof = join(root, 'stopped.txt');
  const child = spawn(process.execPath, [join(root, 'scripts/container-cli.mjs'), 'codex', 'wait'], { env: { ...process.env, STOP_PROOF: proof }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const stopped = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await stopped, [0, null]);
  assert.equal(await readFile(proof, 'utf8'), 'stopped');
});

test('health CLI detects both healthy HTTP and semantic/error responses', async t => {
  let body = { status: 'ok' }, status = 200;
  const server = createServer((req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, BRIDGE_PORT: String(server.address().port) };
  const check = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/healthcheck.mjs', import.meta.url))], { env, stdio: 'ignore' });
    return (await once(child, 'exit'))[0];
  };
  assert.equal(await check(), 0);
  body = { status: 'failed' }; assert.equal(await check(), 1);
  body = { status: 'ok' }; status = 503; assert.equal(await check(), 1);
});
