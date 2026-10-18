import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRIDGE_ROOT, runtimePython, assertCompatiblePythonEnvironment } from '../src/platform.mjs';

const root = BRIDGE_ROOT;
const environment = resolve(root, 'runtime-tools');
const python = runtimePython();
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Failed: ${command} ${args.join(' ')}. ${result.error?.message ?? 'See output above.'}`);
}
try {
  assertCompatiblePythonEnvironment(environment);
  if (!existsSync(python)) {
    const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
    const candidate = candidates.find(([command, args]) => spawnSync(command, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'], { shell: false }).status === 0);
    if (!candidate) throw new Error('Install Python 3.10+ first: Ubuntu requires python3 and python3-venv; Windows requires the Python launcher. Then rerun npm run setup:files.');
    run(candidate[0], [...candidate[1], '-m', 'venv', environment]);
  }
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', resolve(root, 'scripts/file-requirements.txt')]);
  if (process.argv.includes('--media')) run(python, ['-m', 'pip', 'install', '-r', resolve(root, 'scripts/file-requirements-media.txt')]);
  run(python, ['-c', 'import PIL, pymupdf, docx, openpyxl, pptx, pillow_heif, py7zr; print("Image, PDF and Office editing runtime ready.")']);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
