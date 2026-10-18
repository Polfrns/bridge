import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { BridgeError } from './protocol.mjs';
import { MIME_TYPES } from './file-formats.mjs';

export const MAX_OUTPUT_FILE_COUNT = 10;
export const MAX_OUTPUT_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_OUTPUT_TOTAL_BYTES = 15 * 1024 * 1024;

const MAX_WORKSPACE_FILES = 1000;



async function listWorkspaceFiles(root) {
  const files = new Map();
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = resolve(directory, entry.name);
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      if (files.size >= MAX_WORKSPACE_FILES) {
        throw new BridgeError(413, 'The isolated workspace contains too many files.', 'output_too_large');
      }
      const pathFromRoot = relative(root, filePath);
      if (!pathFromRoot || pathFromRoot.startsWith(`..${sep}`)) {
        throw new Error('Generated file escaped the isolated workspace.');
      }
      files.set(pathFromRoot, { filePath, size: stats.size });
    }
  };
  await visit(root);
  return files;
}

export async function snapshotWorkspace(cwd) {
  const files = await listWorkspaceFiles(resolve(cwd));
  const snapshot = new Map();
  for (const [pathFromRoot, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    if (file.size > MAX_OUTPUT_FILE_BYTES) {
      throw new BridgeError(
        413,
        `Workspace file "${pathFromRoot}" exceeds the ${MAX_OUTPUT_FILE_BYTES}-byte bridge limit.`,
        'output_file_too_large',
      );
    }
    snapshot.set(pathFromRoot, createHash('sha256').update(await readFile(file.filePath)).digest('hex'));
  }
  return snapshot;
}

export async function collectGeneratedFiles(cwd, before, selectedPaths) {
  const root = resolve(cwd);
  const files = await listWorkspaceFiles(root);
  const generated = [];
  let totalBytes = 0;

  for (const [pathFromRoot, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    if (selectedPaths && !selectedPaths.includes(pathFromRoot)) continue;
    if (file.size > MAX_OUTPUT_FILE_BYTES) {
      throw new BridgeError(
        413,
        `Generated file "${pathFromRoot}" exceeds the ${MAX_OUTPUT_FILE_BYTES}-byte bridge limit.`,
        'output_file_too_large',
      );
    }
    const buffer = await readFile(file.filePath);
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (before.get(pathFromRoot) === digest) {
      continue;
    }
    if (buffer.length > MAX_OUTPUT_FILE_BYTES) {
      throw new BridgeError(
        413,
        `Generated file "${pathFromRoot}" exceeds the ${MAX_OUTPUT_FILE_BYTES}-byte bridge limit.`,
        'output_file_too_large',
      );
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_OUTPUT_TOTAL_BYTES) {
      throw new BridgeError(
        413,
        `Generated files exceed the ${MAX_OUTPUT_TOTAL_BYTES}-byte bridge limit.`,
        'output_too_large',
      );
    }
    generated.push({
      path: pathFromRoot,
      filename: pathFromRoot.split(/[\\/]/).pop(),
      mimeType: MIME_TYPES[extname(pathFromRoot).toLowerCase()] ?? 'application/octet-stream',
      bytes: buffer.length,
      data: buffer.toString('base64'),
    });
    if (generated.length > MAX_OUTPUT_FILE_COUNT) {
      throw new BridgeError(
        413,
        `The bridge supports at most ${MAX_OUTPUT_FILE_COUNT} generated files per response.`,
        'too_many_output_files',
      );
    }
  }

  return generated;
}
