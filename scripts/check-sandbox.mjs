import { randomUUID } from 'node:crypto';
import { createIsolatedRuntime, removeIsolatedRuntime } from '../src/isolated-runtime.mjs';
import { checkSandbox } from '../src/sandbox-check.mjs';

let runtime;
try {
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('Run npm run check:sandbox on a native Windows or Linux bridge host.');
  runtime = await createIsolatedRuntime({context:{userKey:'local-sandbox-check',conversationKey:randomUUID()},cliOptions:{provider:'codex'}});
  const result = await checkSandbox(runtime);
  console.log('[bridge sandbox check]', JSON.stringify({status:'ok',...result}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (runtime) await removeIsolatedRuntime(runtime);
}
