import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRIDGE_ROOT } from '../src/platform.mjs';

const require = createRequire(import.meta.url);

/** @typedef {{executable: string, args: string[]}} ContainerCommand */
/** Resolve the pinned SDK CLIs, so login and inference use the same binaries. */
export function containerCommand(command, args = [], { platform = process.platform, arch = process.arch, resolveModule = require.resolve, node = process.execPath, root = BRIDGE_ROOT } = {}) {
  if (command === 'codex') {
    const cli = join(dirname(resolveModule('@openai/codex/package.json')), 'bin', 'codex.js');
    return { executable: node, args: [cli, '-c', 'cli_auth_credentials_store="file"', ...args] };
  }
  if (command === 'claude') {
    if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) throw new Error('The Docker image requires Linux x64 or ARM64.');
    return { executable: resolveModule(`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`), args };
  }
  const scripts = { serve: 'src/server.mjs', 'check:sandbox': 'scripts/check-sandbox.mjs', 'check:workspace': 'scripts/check-workspace.mjs', health: 'scripts/healthcheck.mjs' };
  if (!Object.hasOwn(scripts, command) || args.length) throw new Error('Use serve, codex [args], claude [args], check:sandbox, check:workspace or health.');
  return { executable: node, args: [join(root, scripts[command])] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = containerCommand(process.argv[2] || 'serve', process.argv.slice(3));
    const child = spawn(command.executable, command.args, { cwd: BRIDGE_ROOT, env: process.env, stdio: 'inherit', shell: false });
    const stop = signal => { child.kill(signal); };
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
