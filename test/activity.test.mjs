import test from 'node:test';
import assert from 'node:assert/strict';
import {activityLine, activityCardRecord, createActivityReporter, safeActivity} from '../src/activity.mjs';

test('whitelisted activity only; no arguments, paths or tool outputs', () => {
  const event = {provider: 'codex', type: 'command_execution', id: 'a', state: 'started',
    command: 'cat /secrets', aggregated_output: 'password=abc', file_path: '/private/doc'};
  assert.equal(activityLine(event), '• Codex · Comando del workspace — Iniciada\n');
  assert.equal(JSON.stringify(safeActivity(event)).includes('password'), false);
  assert.equal(activityLine({...event, type: 'agent_message'}), null);
  assert.equal(activityLine({provider: 'claude',type: 'SomeUntrustedName', state: 'completed'}), null);
  assert.equal(activityLine({provider: 'claude',type: 'mcp__workspace__execute', state: 'failed'}),
    '• Claude · Comando del workspace — Fallida\n');
});
test('activity reporter deduplicates states and bounds event volume', () => {
  const received = [];
  const report = createActivityReporter(value => received.push(value), {max: 2});
  const event = {provider:'codex', type:'file_change', id:'abc', state:'started'};
  report(event); report(event); report({...event, state:'completed'});
  report({...event, state:'failed'});
  assert.deepEqual(received.map(x=>x.state), ['started','completed']);
});

test('structured tool-card events contain only bounded, opaque metadata', () => {
  const input = {provider: 'codex', type: 'command_execution', state: 'started', id: 'secret/id',
    command: 'cat /etc/shadow', file_path: '/confidential', aggregated_output: 'PASSWORD=xyz'};
  const record = activityCardRecord(input);
  assert.match(record, /^\[\[ROKO_BRIDGE_TOOL_V1:[A-Za-z0-9_-]+\]\]\n$/);
  const encoded = record.match(/:([A-Za-z0-9_-]+)\]\]/)[1];
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(decoded).sort(), ['id','operation','provider','state','type','v']);
  assert.equal(decoded.state, 'started');
  assert.equal(decoded.provider, 'codex');
  assert.doesNotMatch(record + JSON.stringify(decoded), /secret|shadow|confidential|PASSWORD/);
  assert.equal(activityCardRecord({...input, type: 'agent_message'}), null);
  assert.equal(activityCardRecord({...input, provider: 'other'}), null);
  assert.equal(decoded.id, JSON.parse(Buffer.from(activityCardRecord({...input,state:'completed'}).match(/:([A-Za-z0-9_-]+)\]\]/)[1], 'base64url').toString('utf8')).id);
});
