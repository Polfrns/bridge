import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { BRIDGE_ROOT, runtimePython } from './platform.mjs';
import { BridgeError } from './protocol.mjs';

const execute = promisify(execFile);

/** Runs only the administrator-provisioned reader, never an uploaded script. */
export async function runFileTool(operation, path, cwd, { signal, python = runtimePython(), env = process.env } = {}) {
  if (!existsSync(python)) return { warnings: ['File toolkit is not installed: run npm run setup:files or build the supplied Docker image.'] };
  const args = [resolve(BRIDGE_ROOT, 'scripts/file-tools.py'), operation, '--workspace', cwd, '--path', relative(cwd, path)];
  const home = resolve(cwd, '.bridge-prepared', 'tool-home');
  const temp = resolve(home, 'tmp');
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const readerEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|Path|SystemRoot|WINDIR|COMSPEC|PATHEXT|LANG|LC_.*|PYTHONPATH)$/.test(key)));
  Object.assign(readerEnv, { HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: temp });
  for (const key of ['PROGRAMFILES', 'PROGRAMFILES(X86)']) if (process.env[key]) readerEnv[key] = process.env[key];
  for (const key of ['BRIDGE_SOFFICE', 'BRIDGE_FFMPEG', 'BRIDGE_FFPROBE', 'BRIDGE_TESSERACT', 'BRIDGE_OCR_LANG', 'BRIDGE_WHISPER_MODEL']) if (process.env[key]) readerEnv[key] = process.env[key];
  let output;
  try {
    output = await execute(python, args, { cwd, env: readerEnv, signal, timeout: 90000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    let failure;
    try { failure = JSON.parse(error.stdout); } catch { /* A killed reader has no JSON result. */ }
    throw new BridgeError(422, failure?.error ?? `File preparation failed: ${error.message}`, failure?.code ?? 'file_tool_failed');
  }
  return JSON.parse(output.stdout);
}

export async function validateFinishedFiles(files, cwd, options) {
  for (const file of files) await runFileTool('validate', resolve(cwd, file.path), cwd, options);
}
