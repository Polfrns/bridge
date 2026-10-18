import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexEvents } from '../src/codex-events.mjs';
import { parseToolDecision } from '../src/protocol.mjs';

const item = (type, id, text) => ({ type, item: { type: 'agent_message', id, text } });
const completed = { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } };
async function collect(events, options) {
  const output = [];
  for await (const event of readCodexEvents(events, options)) output.push(event);
  return output;
}

test('tool relay emits only the last completed message, excluding progress and snapshots', async () => {
  const final = JSON.stringify({ action: 'message', text: 'Archivo editado', name: '', arguments_json: '{}' });
  const output = await collect([
    item('item.completed', 'progress', 'Voy a editar el archivo.'),
    item('item.updated', 'answer', '{"action":'),
    item('item.completed', 'answer', final), completed,
  ], { toolRelay: true });
  assert.equal(output.map((event) => event.text || '').join(''), final);
  assert.deepEqual(parseToolDecision(output[0].text, { toolRelay: true, toolChoice: 'auto' }), { type: 'message', text: 'Archivo editado' });
});

test('ordinary text still emits incremental snapshots once', async () => {
  const output = await collect([item('item.updated', 'one', 'Hola'), item('item.completed', 'one', 'Hola Pol'), completed]);
  assert.equal(output.map((event) => event.text || '').join(''), 'Hola Pol');
});

test('failed structured turn does not leak progress as a tool decision', async () => {
  const output = [];
  await assert.rejects(async () => {
    for await (const event of readCodexEvents([
      item('item.completed', 'one', 'Preparando'), { type: 'turn.failed', error: { message: 'Failed' } },
    ], { toolRelay: true })) output.push(event);
  }, /Failed/);
  assert.deepEqual(output, []);
});

test('an unfinished turn is rejected', async () => {
  await assert.rejects(collect([item('item.completed', 'one', 'Hola')]), /successful turn/);
});

test('failed shell output is captured as a diagnostic, never assistant text', async () => {
  const diagnostics = [];
  const output = await collect([
    {type:'item.completed',item:{type:'command_execution',status:'failed',exit_code:1,command:'hidden-command',aggregated_output:'Access is denied: private contents'}},
    item('item.completed','answer','Final answer'), completed,
  ], {toolRelay:true,onDiagnostic: diagnostic => diagnostics.push(diagnostic)});
  assert.deepEqual(diagnostics,[{type:'command_execution',exitCode:1,category:'permission_denied'}]);
  assert.equal(output.map(event=>event.text||'').join(''),'Final answer');
});
