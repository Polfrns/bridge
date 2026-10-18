import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { runtimePython } from './platform.mjs';
import { codexHostConfig } from './cli-options.mjs';

const require = createRequire(import.meta.url);
const quoteSH = value => "'" + value.replaceAll("'", "'\\''") + "'";
const quotePS = value => "'" + value.replaceAll("'", "''") + "'";

/** A deterministic native sandbox probe. No model or API request is involved. */
export async function checkSandbox(runtime, { platform = process.platform, env = process.env, launch = spawnSync, nodePath = process.execPath, launcherPath, powershell, python, shell = '/bin/sh' } = {}) {
  if (!['win32', 'linux'].includes(platform)) throw new Error(`Sandbox check supports Windows and Linux; received ${platform}.`);
  const windows = platform === 'win32';
  const hostConfig = codexHostConfig(env, platform);
  const mode = windows ? hostConfig.windows.sandbox : 'native';
  const token = randomUUID();
  const proof = join(runtime.cwd, 'work', 'sandbox-write-proof.txt');
  const officeProof = join(runtime.cwd, 'work', 'sandbox-office-proof.json');
  await mkdir(join(runtime.cwd, 'work'), { recursive: true });
  powershell ??= join(env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  python ??= runtimePython({ platform });
  const officeAvailable = existsSync(python);
  let script = windows
    ? `$ErrorActionPreference='Stop'; [System.IO.File]::WriteAllText(${quotePS(proof)},${quotePS(token)});`
    : `set -eu; printf '%s' ${quoteSH(token)} > ${quoteSH(proof)};`;
  if (officeAvailable) {
    const helper = join(runtime.cwd, 'work', 'sandbox-office-probe.py');
    await writeFile(helper, `import json, zipfile, xml.etree.ElementTree as ET\nfrom pathlib import Path\nns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'\nsource=Path('work/sandbox-check-original.docx')\nout=Path('work/sandbox-check-red.docx')\nparts={\n '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',\n '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',\n 'word/document.xml':'<w:document xmlns:w="'+ns+'"><w:body><w:p><w:r><w:t>Prueba sandbox</w:t></w:r></w:p></w:body></w:document>'\n}\nwith zipfile.ZipFile(source,'w',zipfile.ZIP_DEFLATED) as z:\n for name,data in parts.items(): z.writestr(name,data)\nwith zipfile.ZipFile(source) as original, zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as edited:\n for item in original.infolist():\n  data=original.read(item.filename)\n  if item.filename=='word/document.xml':\n   root=ET.fromstring(data)\n   for run in root.iter('{'+ns+'}r'):\n    props=ET.Element('{'+ns+'}rPr')\n    run.insert(0,props)\n    ET.SubElement(props,'{'+ns+'}color',{'{'+ns+'}val':'FF0000'})\n   data=ET.tostring(root,encoding='utf-8',xml_declaration=True)\n  edited.writestr(item,data)\nwith zipfile.ZipFile(out) as z:\n assert z.testzip() is None\n root=ET.fromstring(z.read('word/document.xml'))\n assert all(c.get('{'+ns+'}val')=='FF0000' for c in root.iter('{'+ns+'}color'))\n assert len(list(root.iter('{'+ns+'}color')))==1\nPath('work/sandbox-office-proof.json').write_text(json.dumps({'token':${JSON.stringify(token)},'color':'FF0000'}),encoding='utf-8')\n`, 'utf8');
    script += windows
      ? ` & ${quotePS(python)} ${quotePS(helper)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE };`
      : ` ${quoteSH(python)} ${quoteSH(helper)};`;
  }
  // The installed CLI selects the native implementation itself. A "windows"
  // positional argument is treated as the executable to launch (Win32 error 2).
  const args = ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', ...(windows ? ['-c', `windows.sandbox=${JSON.stringify(mode)}`] : []), '-c', 'sandbox_workspace_write.network_access=false', 'sandbox', '--',
    ...(windows ? [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] : [shell, '-c', script])];
  const executable = env.CODEX_EXECUTABLE || nodePath;
  const prefix = env.CODEX_EXECUTABLE ? [] : [launcherPath || join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js')];
  const result = launch(executable, [...prefix, ...args], { cwd: runtime.cwd, env: runtime.env, encoding: 'utf8', shell: false, timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Native ${windows ? 'Windows' : 'Linux'} sandbox check failed (${mode}, exit ${result.status ?? 'unavailable'}): ${result.error?.message || result.stderr || result.stdout || 'No diagnostic output.'}`.slice(0, 4000));
  let actual;
  try { actual = await readFile(proof, 'utf8'); } catch { throw new Error('The native sandbox command returned success but did not create its write proof.'); }
  if (actual !== token) throw new Error('The native sandbox write proof is invalid.');
  if (officeAvailable) {
    const office = JSON.parse(await readFile(officeProof, 'utf8'));
    if (office.token !== token || office.color !== 'FF0000') throw new Error('The native sandbox Office proof is invalid.');
  }
  return { platform, ...(windows ? { windowsSandbox: mode } : { linuxSandbox: 'native' }), workspaceWrite: true, officePython: officeAvailable ? 'DOCX red text verified' : 'not installed; run npm run setup:files' };
}


/** Preserve the existing Windows-only entry point for callers and regression tests. */
export function checkWindowsSandbox(runtime, options = {}) {
  return checkSandbox(runtime, { ...options, platform: 'win32' });
}
