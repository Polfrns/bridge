import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, '.env');
if (existsSync(destination)) {
  console.log('.env already exists; preserved.');
} else {
  const template = readFileSync(resolve(root, '.env.example'), 'utf8');
  writeFileSync(destination, template.replace('BRIDGE_API_KEY=', `BRIDGE_API_KEY=${randomBytes(32).toString('hex')}`), { mode: 0o600 });
  console.log('Created .env with a unique local key.');
}
mkdirSync(resolve(root, 'runtime'), { recursive: true });
console.log('Authenticate locally with claude and codex login, then npm start.');
