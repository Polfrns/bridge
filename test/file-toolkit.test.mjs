import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageAttachments } from '../src/attachments.mjs';
import { validateFinishedFiles } from '../src/file-toolkit.mjs';
import { completeArtifactRun } from '../src/artifacts.mjs';
import { snapshotWorkspace } from '../src/output-files.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const options = { python: process.env.FILE_TEST_PYTHON, env: process.env };
const skip = !options.python;
async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-toolkit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('real toolkit preserves source bytes and supplies normalized image previews', {skip}, async t => {
  const cwd = await workspace(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  const request = await stageAttachments({prompt:'Read this', attachments:[
    {filename:'photo.png', mimeType:'image/png', data:bytes.toString('base64')},
    {filename:'script.py', mimeType:'application/octet-stream', data:Buffer.from('raise RuntimeError("must not execute")').toString('base64')},
    {filename:'Dockerfile', mimeType:'application/octet-stream', data:Buffer.from('FROM node:24').toString('base64')},
  ]}, cwd, options);
  assert.deepEqual(await readFile(request.attachments[0].path), bytes);
  assert.equal(request.visionImages.length, 1);
  assert.notEqual(request.visionImages[0].path, request.attachments[0].path);
  assert.match(request.prompt, /must not execute/);
  assert.match(request.prompt, /FROM node:24/);
  assert.equal(request.attachments[1].mimeType, 'text/x-python');
});

test('real validation rejects fake Office output and repairs it before publishing', {skip}, async t => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, 'outputs'));
  const before = await snapshotWorkspace(cwd);
  let turns = 0;
  const events = await completeArtifactRun(async repair => {
    turns++;
    if (!repair) {
      await writeFile(join(cwd, 'outputs/result.docx'), 'fake binary');
      await writeFile(join(cwd, 'bridge-result.json'), JSON.stringify({task:'edit',status:'files',files:['outputs/result.docx']}));
    } else {
      assert.match(repair, /zip/i);
      await promisify(execFile)(options.python, ['-c', 'from docx import Document; import sys; d=Document(); d.add_paragraph("Actual edited document"); d.save(sys.argv[1])', join(cwd, 'outputs/result.docx')], {env:process.env});
    }
    return [{text:'Ready'}];
  }, cwd, before, { validateFiles: files => validateFinishedFiles(files, cwd, options) });
  assert.equal(turns, 2);
  assert.equal(events.at(-1).files[0].filename, 'result.docx');
});

test('an explicitly requested Python source edit is returned as code', {skip}, async t => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, 'outputs'));
  const before = await snapshotWorkspace(cwd);
  const events = await completeArtifactRun(async () => {
    await writeFile(join(cwd, 'outputs/result.py'), 'print("edited source")');
    await writeFile(join(cwd, 'bridge-result.json'), JSON.stringify({task:'code',status:'files',files:['outputs/result.py']}));
    return [{text:'Updated'}];
  }, cwd, before, {validateFiles: files => validateFinishedFiles(files, cwd, options)});
  assert.equal(events.at(-1).files[0].filename, 'result.py');
});

test('unsafe archive fails during staging, before the provider can use it', {skip}, async t => {
  const cwd = await workspace(t);
  // A malformed ZIP must never silently bypass preparation.
  await assert.rejects(stageAttachments({prompt:'Extract',attachments:[
    {filename:'broken.zip',mimeType:'application/zip',data:Buffer.from('not a zip').toString('base64')},
  ]}, cwd, options), error => error.status === 422 && /zip/i.test(error.message));
});
