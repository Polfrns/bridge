import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGeneratedFiles, snapshotWorkspace } from '../src/output-files.mjs';

async function createWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('captures new and edited files, but excludes unchanged input files', async t => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, 'input.txt'), 'unchanged');
  const before = await snapshotWorkspace(cwd);
  await writeFile(join(cwd, 'input.txt'), 'edited input');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'answer.ts'), 'export const answer = 42;');

  const files = await collectGeneratedFiles(cwd, before);

  assert.deepEqual(
    files.map(({ filename, mimeType, bytes, data }) => ({
      filename,
      mimeType,
      bytes,
      content: Buffer.from(data, 'base64').toString('utf8'),
    })),
    [
      { filename: 'input.txt', mimeType: 'text/plain', bytes: 12, content: 'edited input' },
      {
        filename: 'answer.ts',
        mimeType: 'text/typescript',
        bytes: 25,
        content: 'export const answer = 42;',
      },
    ],
  );
});

test('rejects generated files that exceed the transfer limit', async t => {
  const cwd = await createWorkspace(t);
  const before = await snapshotWorkspace(cwd);
  await writeFile(join(cwd, 'large.txt'), Buffer.alloc(15 * 1024 * 1024 + 1));

  await assert.rejects(collectGeneratedFiles(cwd, before), {
    status: 413,
    code: 'output_file_too_large',
  });
});
