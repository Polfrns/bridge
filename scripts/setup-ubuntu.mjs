import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { BRIDGE_ROOT } from '../src/platform.mjs';
import { configureUbuntuHost } from '../src/ubuntu-config.mjs';

try {
  if (process.platform !== 'linux') throw new Error('setup:ubuntu is for a native Ubuntu/Linux host with Docker Engine. On Windows use npm run setup.');
  const docker = spawnSync('docker', ['network', 'inspect', 'bridge'], { encoding: 'utf8', shell: false, timeout: 10000 });
  if (docker.error || docker.status !== 0) throw new Error('Docker Engine default bridge is unavailable. Start Docker and give this user access to docker network inspect bridge, then retry.');
  const network = JSON.parse(docker.stdout)[0];
  const gateway = network?.IPAM?.Config?.find(item => isIP(item.Gateway ?? '') === 4)?.Gateway;
  const destination = join(BRIDGE_ROOT, '.env');
  let source;
  try { source = await readFile(destination, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = (await readFile(join(BRIDGE_ROOT, '.env.example'), 'utf8'))
      .replace(/^BRIDGE_API_KEY=$/m, `BRIDGE_API_KEY=${randomBytes(32).toString('hex')}`);
  }
  const configured = configureUbuntuHost(source, gateway);
  const temporary = destination + '.ubuntu-' + randomBytes(8).toString('hex');
  try {
    await writeFile(temporary, configured, { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, {force:true}); }
  console.log(`Ubuntu configured: BRIDGE_HOST=${gateway}. Existing key and other options preserved.`);
  console.log('Use the same BRIDGE_API_KEY as CLAUDE_BRIDGE_KEY in Roko. Keep host.docker.internal:host-gateway in its Compose api service.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
