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
  run(python, ['-c', 'import PIL, pymupdf, docx, openpyxl, pptx, pillow_heif, py7zr, numpy, pandas, matplotlib, pdfplumber, reportlab; print("Image, PDF, Office, data and chart runtime ready.")']);
  // WeasyPrint also needs the host's Pango libraries, which a Windows host often lacks.
  if (spawnSync(python, ['-c', 'import weasyprint'], { stdio: 'ignore', shell: false }).status !== 0) {
    console.warn('WeasyPrint is installed but cannot load Pango: HTML-to-PDF is unavailable. Install libpango-1.0-0, libpangoft2-1.0-0 and libharfbuzz-subset0 (Ubuntu) and rerun.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
