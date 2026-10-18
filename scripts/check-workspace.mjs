import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WorkspaceExecutor } from '../src/workspace-executor.mjs';
import { runtimePython } from '../src/platform.mjs';
import { validateFinishedFiles } from '../src/file-toolkit.mjs';

let root;
try {
  const base = resolve(process.env.BRIDGE_DATA_DIR || 'runtime', 'workspace-checks');
  await mkdir(base, { recursive: true, mode: 0o700 });
  root = await mkdtemp(join(base, 'run-'));
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { mode: 0o700 });
  const executor = new WorkspaceExecutor(cwd, process.env);
  executor.ready = executor.verify();
  const proof = await executor.ready;
  const python = runtimePython();
  let officePython = 'not installed; run npm run setup:files';
  if (existsSync(python)) {
    const helper = join(cwd, 'office-probe.py');
    const token = randomUUID();
    await writeFile(helper, `from docx import Document\nfrom docx.shared import RGBColor\nfrom pathlib import Path\nDocument().save('original.docx')\nd=Document('original.docx')\nr=d.add_paragraph().add_run(${JSON.stringify(token)})\nr.font.color.rgb=RGBColor.from_string('FF0000')\nd.save('edited.docx')\nd=Document('edited.docx')\nassert d.paragraphs[0].text==${JSON.stringify(token)}\nassert str(d.paragraphs[0].runs[0].font.color.rgb)=='FF0000'\n`, { mode: 0o600 });
    const quote = process.platform === 'win32' ? value => "'" + value.replaceAll("'", "''") + "'" : value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = process.platform === 'win32'
      ? `& ${quote(python)} ${quote(helper)}; exit $LASTEXITCODE`
      : `${quote(python)} ${quote(helper)}`;
    const result = await executor.execute(command);
    if (result.exitCode !== 0) throw new Error(`Workspace Office probe failed: ${result.stderr || result.stdout}`);
    await validateFinishedFiles([{path: 'edited.docx'}], cwd);
    officePython = 'DOCX red text verified';
  }
  console.log('[bridge workspace check]', JSON.stringify({ status: 'ok', ...proof, officePython, providerLoginRequired: false }));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { if (root) await rm(root, { recursive: true, force: true }); }
