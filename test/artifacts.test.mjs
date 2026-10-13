import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectArtifacts, completeArtifactRun, prepareArtifactResult } from '../src/artifacts.mjs';
import { snapshotWorkspace } from '../src/output-files.mjs';

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-artifacts-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'outputs'));
  await mkdir(join(cwd, 'work'));
  return cwd;
}
async function manifest(cwd, files, task = 'edit', status = 'files') {
  await writeFile(join(cwd, 'bridge-result.json'), JSON.stringify({ task, status, files }));
}
test('returns only declared PDF and image artifacts, excluding helper scripts', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  await writeFile(join(cwd, 'work/edit.py'), 'print("helper")');
  await writeFile(join(cwd, 'outputs/result.pdf'), '%PDF-1.7\nfixture');
  await writeFile(join(cwd, 'outputs/result.png'), Buffer.from([137,80,78,71,13,10,26,10,0]));
  await manifest(cwd, ['outputs/result.pdf', 'outputs/result.png']);
  const files = await collectArtifacts(cwd, before);
  assert.deepEqual(files.map(f => [f.filename, f.mimeType]), [['result.pdf','application/pdf'], ['result.png','image/png']]);
});
test('repairs a missing output in the same session and suppresses the first success claim', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  let calls = 0;
  const events = await completeArtifactRun(async repair => {
    calls++;
    await manifest(cwd, ['outputs/result.pdf']);
    if (calls === 1) {
      assert.equal(repair, undefined);
      await writeFile(join(cwd, 'work/edit.py'), 'helper');
      return [{text:'Done but missing'}, {usage:{total_tokens:5}}];
    }
    assert.match(repair, /missing/);
    await writeFile(join(cwd, 'outputs/result.pdf'), '%PDF-1.7\nfixture');
    return [{text:'Actual PDF ready'}, {usage:{total_tokens:7}}];
  }, cwd, before);
  assert.equal(calls, 2);
  assert.equal(events.find(e => e.text).text, 'Actual PDF ready');
  assert.equal(events.find(e => e.usage).usage.total_tokens, 12);
  assert.equal(events.at(-1).files[0].filename, 'result.pdf');
});
test('fails after the repair instead of returning a Python script as an edit', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  await writeFile(join(cwd, 'outputs/result.py'), 'print("not PDF")');
  await manifest(cwd, ['outputs/result.py']);
  await assert.rejects(completeArtifactRun(async () => [{text:'Edited'}], cwd, before), /helper script/);
  await manifest(cwd, ['outputs/result.py'], 'code');
  assert.equal((await collectArtifacts(cwd, before))[0].filename, 'result.py');
});
test('rejects escaped, missing, empty and fake binary outputs', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  for (const [path, content] of [['../escape.pdf', null], ['outputs/missing.pdf', null], ['outputs/empty.pdf', ''], ['outputs/fake.pdf', 'print(1)'], ['outputs/fake.png', 'print(2)']]) {
    if (content !== null) await writeFile(join(cwd, path), content);
    await manifest(cwd, [path]);
    await assert.rejects(collectArtifacts(cwd, before));
  }
});
test('analysis and unsupported edits need no artifact; edit/text is rejected', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  await manifest(cwd, [], 'answer', 'text');
  assert.deepEqual(await collectArtifacts(cwd, before), []);
  await manifest(cwd, [], 'edit', 'unsupported');
  assert.deepEqual(await collectArtifacts(cwd, before), []);
  await manifest(cwd, [], 'edit', 'text');
  await assert.rejects(collectArtifacts(cwd, before));
});
test('does not return a symlink outside the workspace', {skip: process.platform === 'win32'}, async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  await symlink('/etc/hosts', join(cwd, 'outputs/hosts.txt'));
  await manifest(cwd, ['outputs/hosts.txt']);
  await assert.rejects(collectArtifacts(cwd, before));
});

test('a missing manifest surfaces execution diagnostics without a truncated absolute path', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  await assert.rejects(completeArtifactRun(async () => [{text:'Done'}], cwd, before, {
    getDiagnostics: () => [{type:'command_execution',exitCode:1,category:'permission_denied'}],
  }), error => {
    assert.match(error.message,/Missing bridge-result.json/);
    assert.match(error.message,/exit 1.*permission_denied/);
    assert.equal(error.message.includes(cwd),false);
    return true;
  });
});

const structuredEvents = (text, artifact) => [{text:JSON.stringify({response:{text},artifact})},{usage:{total_tokens:5}}];
const structured = {prepareResult: events => prepareArtifactResult(events,{toolRelay:false})};

test('ordinary text succeeds without running a shell or writing a manifest', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  let calls = 0;
  const events = await completeArtifactRun(async () => {
    calls++;
    return structuredEvents('Hola',{task:'answer',status:'text',files:[]});
  },cwd,before,structured);
  assert.equal(calls,1);
  assert.equal(events[0].text,'Hola');
  assert.equal(events.some(event=>event.files),false);
});

test('structured delivery repairs a missing file and only publishes validated output', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  let calls = 0;
  const events = await completeArtifactRun(async repair => {
    if (++calls === 2) {
      assert.match(repair,/missing/);
      await writeFile(join(cwd,'outputs/result.pdf'),'%PDF-1.7 fixture');
    }
    return structuredEvents(calls === 1 ? 'False success' : 'Validated output',{task:'edit',status:'files',files:['outputs/result.pdf']});
  },cwd,before,structured);
  assert.equal(calls,2);
  assert.equal(events[0].text,'Validated output');
  assert.equal(events.find(event=>event.usage).usage.total_tokens,10);
  assert.equal(events.at(-1).files[0].filename,'result.pdf');
});

test('structured delivery rejects helper scripts, escaped paths and fake binary files', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  await writeFile(join(cwd,'outputs/edit.py'),'print(1)');
  await writeFile(join(cwd,'outputs/fake.pdf'),'print(1)');
  for (const path of ['outputs/edit.py','../escape.pdf','outputs/fake.pdf']) {
    await assert.rejects(completeArtifactRun(async () => structuredEvents('Edited',{task:'edit',status:'files',files:[path]}),cwd,before,structured));
  }
});

test('malformed structured output gets one repair and cannot fall back to unvalidated text', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  let calls = 0;
  await assert.rejects(completeArtifactRun(async () => {
    calls++;
    return [{text:'Edited successfully'}];
  },cwd,before,structured),/structured response\/artifact/);
  assert.equal(calls,2);
});

test('repair cannot downgrade a failed file delivery to an ordinary answer', async t => {
  const cwd = await workspace(t), before = await snapshotWorkspace(cwd);
  let calls = 0;
  await assert.rejects(completeArtifactRun(async () => ++calls === 1
    ? structuredEvents('File ready',{task:'edit',status:'files',files:['outputs/missing.pdf']})
    : structuredEvents('Done',{task:'answer',status:'text',files:[]}),cwd,before,structured),/Cannot replace a rejected file delivery/);
  assert.equal(calls,2);
});
