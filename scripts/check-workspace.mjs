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
    const chart = join(cwd, 'chart-probe.py');
    await writeFile(chart, `import pandas as pd\nimport matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nframe=pd.DataFrame({'x':[1,2,3],'y':[2,4,8]})\nassert frame['y'].sum()==14\nframe.plot(x='x',y='y').figure.savefig('chart.png')\n`, { mode: 0o600 });
    const charted = await executor.execute(process.platform === 'win32' ? `& ${quote(python)} ${quote(chart)}; exit $LASTEXITCODE` : `${quote(python)} ${quote(chart)}`);
    if (charted.exitCode !== 0) throw new Error(`Workspace data/chart probe failed: ${charted.stderr || charted.stdout}`);
    await validateFinishedFiles([{path: 'chart.png'}], cwd);
    officePython += '; pandas chart verified';
  }
  // Optional system tools: report what the sandboxed shell can actually run.
  const tools = {};
  for (const [name, args] of [['pandoc', '--version'], ['dot', '-V']]) {
    const probe = await executor.execute(process.platform === 'win32' ? `& ${name} ${args} *> $null; exit $LASTEXITCODE` : `${name} ${args} >/dev/null 2>&1`);
    tools[name] = probe.exitCode === 0 ? 'available' : 'unavailable';
  }
  console.log('[bridge workspace check]', JSON.stringify({ status: 'ok', ...proof, officePython, tools, providerLoginRequired: false }));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { if (root) await rm(root, { recursive: true, force: true }); }
