import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

export const BRIDGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Host paths only; never accept an executable location from chat parameters. */
export function runtimePython({ root = BRIDGE_ROOT, platform = process.platform } = {}) {
  return resolve(root, 'runtime-tools', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

/** A Python venv is host-specific. Never silently mix a copied foreign environment. */
export function assertCompatiblePythonEnvironment(environment, platform = process.platform) {
  const foreign = platform === 'win32' ? join(environment, 'bin', 'python') : join(environment, 'Scripts', 'python.exe');
  if (existsSync(foreign)) throw new Error('runtime-tools contains a Python environment from another OS. Rename that directory to keep it as a backup, then rerun npm run setup:files on this host. Do not copy node_modules or runtime-tools between Windows and Ubuntu.');
}
