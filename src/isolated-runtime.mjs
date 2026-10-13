import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError } from './protocol.mjs';

const credentialQueues = new Map();
const HOST_HOME = homedir();
const RUNTIME_ENV_KEYS = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES(?:\(X86\))?|PROCESSOR_ARCHITECTURE|LANG|LC_.*|TZ|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CODEX_CA_CERTIFICATE|BRIDGE_(?:SOFFICE|FFMPEG|FFPROBE|TESSERACT|OCR_LANG|WHISPER_MODEL))$/i;

/** Serialize use of each subscription credential so token refreshes cannot race. */
export async function acquireCredentialLease(provider, signal) {
  const previous = credentialQueues.get(provider) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  credentialQueues.set(provider, tail);
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Request cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { await Promise.race([previous, cancelled]); }
  catch (error) {
    release();
    void tail.then(() => { if (credentialQueues.get(provider) === tail) credentialQueues.delete(provider); });
    throw error;
  } finally { signal.removeEventListener('abort', onAbort); }
  if (signal.aborted) {
    release();
    if (credentialQueues.get(provider) === tail) credentialQueues.delete(provider);
    signal.throwIfAborted();
  }
  return () => {
    release();
    if (credentialQueues.get(provider) === tail) credentialQueues.delete(provider);
  };
}

/** @typedef {{root: string, cwd: string, home: string, env: object, credential?: {source: string, target: string, original: string}}} IsolatedRuntime */
export function runtimeNamespace(context, provider) {
  // Fresh run directories need ownership grouping, not two nested 64-char IDs.
  // Keeping the path short leaves room for native Windows CLI state filenames.
  return createHash('sha256').update(JSON.stringify([context.userKey, context.conversationKey, provider])).digest('hex').slice(0, 32);
}

export async function createIsolatedRuntime(request, env = process.env) {
  const context = request.context;
  if (!context) throw new BridgeError(401, 'An authenticated conversation context is required.');
  const base = resolve(env.BRIDGE_DATA_DIR || 'runtime', 'r', runtimeNamespace(context, request.cliOptions.provider));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'run-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const temp = join(root, 'tmp');
  const codexHome = join(home, '.codex');
  const claudeHome = join(home, '.claude');
  try {
    for (const dir of [cwd, temp, codexHome, claudeHome, join(home, 'appdata')]) await mkdir(dir, { recursive: true, mode: 0o700 });
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) => RUNTIME_ENV_KEYS.test(key) && typeof value === 'string'));
    Object.assign(childEnv, {
      HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
      APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'appdata'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
      TMPDIR: temp, TMP: temp, TEMP: temp,
    });
    const runtime = { root, cwd, home, env: childEnv };
    if (request.cliOptions.provider === 'claude' && env.CLAUDE_CODE_OAUTH_TOKEN) {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      const isCodex = request.cliOptions.provider === 'codex';
      const source = isCodex
        ? resolve(env.CODEX_AUTH_DIR || env.CODEX_HOME || join(HOST_HOME, '.codex'), 'auth.json')
        : resolve(env.CLAUDE_AUTH_DIR || env.CLAUDE_CONFIG_DIR || join(HOST_HOME, '.claude'), '.credentials.json');
      const target = join(isCodex ? codexHome : claudeHome, isCodex ? 'auth.json' : '.credentials.json');
      let original, credentials;
      try { original = await readFile(source, 'utf8'); credentials = JSON.parse(original); }
      catch { throw new BridgeError(503, `Shared ${request.cliOptions.provider} file login is missing or invalid. Log in once on the bridge host; see the migration guide.`, 'login_required'); }
      if (isCodex ? !credentials.tokens : !credentials.claudeAiOauth) {
        throw new BridgeError(503, 'Subscription OAuth credentials are required; API-key login is not accepted.', 'login_required');
      }
      const snapshot = isCodex ? credentials : { claudeAiOauth: credentials.claudeAiOauth };
      await writeFile(target, JSON.stringify(snapshot), { mode: 0o600 });
      runtime.credential = { source, target, original };
    }
    // No global settings, MCP definitions, skills, instructions or past sessions are copied.
    await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
    return runtime;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Retain only refreshed credentials, never CLI state. Preserve an external re-login. */
export async function retainRefreshedCredential(runtime) {
  if (!runtime.credential) return;
  const { source, target, original } = runtime.credential;
  const refreshed = await readFile(target, 'utf8');
  const parsed = JSON.parse(refreshed);
  const old = JSON.parse(original);
  const next = old.claudeAiOauth ? { ...old, claudeAiOauth: parsed.claudeAiOauth } : parsed;
  if (JSON.stringify(next) === JSON.stringify(old)) return;
  if (await readFile(source, 'utf8') !== original) return;
  const temporary = source + '.bridge-' + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    await rename(temporary, source);
  } finally { await rm(temporary, { force: true }); }
}

export async function removeIsolatedRuntime(runtime) {
  await rm(runtime.root, { recursive: true, force: true });
}

/** Claude's SDK merges its env into process.env, unlike Codex's replacement env. */
export function claudeIsolatedEnv(runtimeEnv, parentEnv = process.env) {
  return { ...Object.fromEntries(Object.keys(parentEnv).map(key => [key, undefined])), ...runtimeEnv };
}
