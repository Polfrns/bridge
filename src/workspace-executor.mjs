import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { BRIDGE_ROOT, runtimePython } from './platform.mjs';
import { codexHostConfig } from './cli-options.mjs';

const require = createRequire(import.meta.url);
const quoteSH = value => "'" + value.replaceAll("'", "'\\''") + "'";
const quotePS = value => "'" + value.replaceAll("'", "''") + "'";
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };

/** Check every existing component, including the target: lexical checks alone allow symlink escapes. */
export async function workspaceFileAllowed(cwd, filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return false;
  const root = await realpath(cwd);
  const target = resolve(root, filePath);
  if (!inside(root, target)) return false;
  let path = target;
  while (true) {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !inside(root, await realpath(path))) return false;
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    if (path === root) return true;
    path = dirname(path);
  }
}

/** No shell on the host. Kill the complete command tree on cancellation, timeout, or overflow. */
export function runBoundedProcess(spec, { signal, timeout = 60000, maxBytes = 1024 * 1024, platform = process.platform } = {}) {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Request cancelled.')); return; }
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, failure, killing;
    const kill = () => {
      if (killing) return;
      if (platform === 'win32') {
        if (!child.pid) return;
        killing = new Promise(done => {
          const killer = spawn(join(spec.env.SystemRoot || spec.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill(); done(); });
          killer.once('close', done);
        });
      } else {
        killing = Promise.resolve();
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const stop = error => { failure ??= error; kill(); };
    const abort = () => stop(signal.reason ?? new Error('Request cancelled.'));
    const timer = setTimeout(() => stop(new Error(`Workspace command timed out after ${timeout} ms.`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const capture = chunks => data => {
      size += data.length;
      if (size > maxBytes) { stop(new Error('Workspace command exceeded the output limit.')); return; }
      chunks.push(data);
    };
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
    child.once('error', error => { failure ??= error; });
    child.once('close', async (code, terminationSignal) => {
      // Also remove background descendants after a normal shell exit.
      kill(); await killing;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolveRun({ exitCode: code, signal: terminationSignal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

/** Uses only the pinned CLI's OS sandbox; never starts a Codex model or needs its login. */
export class WorkspaceExecutor {
  constructor(cwd, env, { platform = process.platform, hostEnv = process.env, launch = runBoundedProcess, python = runtimePython(), launcherPath } = {}) {
    this.cwd = cwd; this.env = env; this.platform = platform; this.hostEnv = hostEnv;
    this.launch = launch; this.python = python; this.launcherPath = launcherPath;
    this.queue = Promise.resolve();
  }

  async initialize() {
    if (!['linux', 'win32'].includes(this.platform)) throw new Error('Workspace execution requires native Linux or Windows.');
    const home = join(this.cwd, '.bridge-exec', 'home'), temp = join(this.cwd, '.bridge-exec', 'tmp');
    // Config is outside the writable workspace and contains no provider credential.
    this.configHome = join(dirname(this.cwd), 'executor-config');
    for (const path of [home, temp, this.configHome]) await mkdir(path, { recursive: true, mode: 0o700 });
    this.childEnv = Object.fromEntries(Object.entries(this.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES(?:\(X86\))?|LANG|LC_.*|TZ|BRIDGE_(?:SOFFICE|FFMPEG|FFPROBE|TESSERACT|OCR_LANG|WHISPER_MODEL))$/i.test(key)));
    Object.assign(this.childEnv, { HOME: home, USERPROFILE: home, CODEX_HOME: this.configHome, TMPDIR: temp, TMP: temp, TEMP: temp, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: temp });
    const roots = new Set([resolve(BRIDGE_ROOT, 'runtime-tools'), resolve(BRIDGE_ROOT, 'scripts', 'file-tools.py')]);
    if (this.platform === 'linux') {
      // Codex prepends CODEX_HOME/tmp/arg0/<run>/ to PATH. Its Linux helper is
      // a symlink there to the installed native CLI, and bwrap must see both.
      // Keep the rest of CODEX_HOME (including config/credentials) inaccessible.
      const codexRequire = createRequire(require.resolve('@openai/codex/package.json'));
      const arch = process.arch;
      if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Linux Codex architecture: ${arch}.`);
      const packageRoot = dirname(codexRequire.resolve(`@openai/codex-linux-${arch}/package.json`));
      const target = arch === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
      const nativeExecutable = await realpath(join(packageRoot, 'vendor', target, 'bin', 'codex'));
      roots.add(nativeExecutable);
      const aliases = join(this.configHome, 'tmp', 'arg0');
      await mkdir(aliases, { recursive: true, mode: 0o700 });
      roots.add(aliases);
      if (this.hostEnv.CODEX_EXECUTABLE && isAbsolute(this.hostEnv.CODEX_EXECUTABLE)) {
        try { roots.add(await realpath(this.hostEnv.CODEX_EXECUTABLE)); } catch { /* Launcher reports an invalid administrator override. */ }
      }
    }
    try { roots.add(dirname(dirname(await realpath(this.python)))); } catch { /* Toolkit is optional for ordinary answers. */ }
    // Windows venvs copy python.exe but still load the base install's standard library.
    try {
      const config = await readFile(resolve(BRIDGE_ROOT, 'runtime-tools', 'pyvenv.cfg'), 'utf8');
      const home = /^home\s*=\s*(.+)$/m.exec(config)?.[1]?.trim();
      if (home && isAbsolute(home)) roots.add(home);
    } catch { /* No provisioned venv. */ }
    for (const name of ['BRIDGE_SOFFICE', 'BRIDGE_FFMPEG', 'BRIDGE_FFPROBE', 'BRIDGE_TESSERACT']) {
      const path = this.hostEnv[name];
      if (path && isAbsolute(path)) roots.add(name === 'BRIDGE_SOFFICE' ? dirname(dirname(path)) : dirname(path));
    }
    if (this.hostEnv.BRIDGE_WHISPER_MODEL && isAbsolute(this.hostEnv.BRIDGE_WHISPER_MODEL)) roots.add(this.hostEnv.BRIDGE_WHISPER_MODEL);
    const filesystem = { ':root': 'deny', ':minimal': 'read', ':slash_tmp': 'deny', ':tmpdir': 'deny' };
    for (const root of roots) filesystem[root] = 'read';
    // Exact workspace rule reopens only this invocation, never sibling runs or OAuth homes.
    filesystem[this.cwd] = 'write';
    const tomlTable = '{' + Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',') + '}';
    const windows = this.platform === 'win32';
    const mode = windows ? codexHostConfig(this.hostEnv, this.platform).windows.sandbox : undefined;
    this.prefix = [
      '-c', 'approval_policy="never"', '-c', 'default_permissions="bridge-exec"',
      '-c', `permissions.bridge-exec.filesystem=${tomlTable}`,
      '-c', 'permissions.bridge-exec.network.enabled=false',
      ...(windows ? ['-c', `windows.sandbox=${JSON.stringify(mode)}`] : []),
      'sandbox', '-P', 'bridge-exec', '-C', this.cwd, '--',
    ];
    this.executable = this.hostEnv.CODEX_EXECUTABLE || process.execPath;
    this.launcher = this.hostEnv.CODEX_EXECUTABLE ? [] : [this.launcherPath || join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js')];
    this.shellArgs = windows
      ? [join(this.childEnv.SystemRoot || this.childEnv.SYSTEMROOT || this.childEnv.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
      : ['/bin/sh', '-c'];
  }

  async raw(command, options) {
    return this.launch({ executable: this.executable, args: [...this.launcher, ...this.prefix, ...this.shellArgs, command], cwd: this.cwd, env: this.childEnv }, { ...options, platform: this.platform });
  }

  async verify(signal) {
    await this.initialize();
    const token = randomUUID(), secret = join(this.configHome, 'private-probe.txt'), proof = join(this.cwd, '.bridge-exec', 'proof.txt');
    const writeProbe = secret + '.write';
    await writeFile(secret, token, { mode: 0o600 });
    const script = this.platform === 'win32'
      ? `$ErrorActionPreference='Stop'; $read=$false; try { [void][System.IO.File]::ReadAllText(${quotePS(secret)}); $read=$true } catch {}; if ($read) { exit 73 }; $write=$false; try { [System.IO.File]::WriteAllText(${quotePS(secret + '.write')},'bad'); $write=$true } catch {}; if ($write) { exit 74 }; [System.IO.File]::WriteAllText(${quotePS(proof)},${quotePS(token)});`
      // Restricted-read bwrap starts from an empty tmpfs root. A write to its
      // synthetic parent directories can succeed without changing the host.
      // Attempt both creation and overwrite; check the actual host below.
      : `set -eu; if cat ${quoteSH(secret)} >/dev/null 2>&1; then exit 73; fi; (printf bad >${quoteSH(writeProbe)}) 2>/dev/null || :; (printf bad >${quoteSH(secret)}) 2>/dev/null || :; printf '%s' ${quoteSH(token)} >${quoteSH(proof)}`;
    try {
      const result = await this.raw(script, { signal, timeout: 30000 });
      // Do not trust the shell's claim of isolation: inspect persistent files
      // outside its mount namespace, including deletions and symlink replacement.
      const original = await lstat(secret);
      if (!original.isFile() || original.isSymbolicLink() || await readFile(secret, 'utf8') !== token) {
        throw new Error('Sandbox proof failed (exit 74): the real outside-workspace canary was modified.');
      }
      try {
        await lstat(writeProbe);
        throw new Error('Sandbox proof failed (exit 74): a real file was created outside the workspace.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (result.exitCode !== 0) {
        const explanation = result.exitCode === 73 ? 'The shell could read the private outside-workspace canary.'
          : result.exitCode === 74 ? 'The shell reported an outside-workspace write.' : 'Sandbox command failed.';
        throw new Error(`Sandbox proof failed (exit ${result.exitCode}): ${result.stderr || result.stdout || explanation}`);
      }
      if (await readFile(proof, 'utf8') !== token) throw new Error('Sandbox proof failed: workspace write proof is missing or invalid.');
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new Error(`Claude workspace sandbox unavailable: ${error.message}. Run npm run check:workspace on this host. Execution without a sandbox is disabled.`);
    } finally {
      for (const path of [secret, secret + '.write', proof]) await rm(path, { force: true });
    }
    return { platform: this.platform, workspaceWrite: true, outsideReadDenied: true, outsideWriteDenied: true, network: 'disabled' };
  }

  execute(command, { signal, timeout = 60000 } = {}) {
    const run = async () => {
      if (typeof command !== 'string' || !command.trim() || command.length > 16000 || command.includes('\0')) throw new Error('command must contain 1–16000 characters.');
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('timeout must be 1000–120000 ms.');
      this.ready ??= this.verify(signal);
      await this.ready;
      signal?.throwIfAborted();
      return this.raw(command, { signal, timeout });
    };
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => {});
    return pending;
  }
}
