import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolTraceLifecycle} from '../src/langfuse-tracing.mjs';

const harness = () => {
  const created = [];
  const lifecycle = createToolTraceLifecycle((name, config) => {
    const span = {name, config, updates: [], ended: 0,
      update(x) {this.updates.push(x)}, end() {this.ended++}};
    created.push(span);
    return span;
  });
  return {created, lifecycle};
};

function terminalUpdate(span, state) {
  // Content updates can precede the lifecycle update; their array position is
  // not part of the contract. There must still be exactly one terminal state.
  const terminal = span.updates.filter(update => update.metadata?.state !== undefined);
  assert.equal(terminal.length, 1, 'one terminal lifecycle update per observation');
  assert.equal(terminal[0].metadata.state, state);
  return terminal[0];
}

test('one tool observation per operation, complete once', () => {
  const {created,lifecycle} = harness();
  const event = {provider:'codex', type:'command_execution', id:'sdk-id', state:'started', command:'secret'};
  lifecycle.event(event); lifecycle.event(event);
  lifecycle.event({...event, state:'completed'});
  lifecycle.finish();
  assert.equal(created.length,1);
  assert.equal(created[0].ended,1);
  const completed = terminalUpdate(created[0], 'completed');
  assert.ok(completed.metadata.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(created), /secret|sdk-id/);
});

test('failures, missing starts, cancellation and isolation', () => {
  const a = harness(), b = harness();
  a.lifecycle.event({provider:'claude', type:'Read', id:'same', state:'started'});
  b.lifecycle.event({provider:'claude', type:'Read', id:'same', state:'started'});
  a.lifecycle.finish('request_cancelled');
  b.lifecycle.event({provider:'claude', type:'Read', id:'same', state:'completed'});
  const cancelled = terminalUpdate(a.created[0], 'cancelled');
  assert.equal(cancelled.level,'ERROR');
  assert.equal(cancelled.metadata.finishReason,'request_cancelled');
  terminalUpdate(b.created[0], 'completed');
  assert.equal(a.created[0].ended,1);
  assert.equal(b.created[0].ended,1);
  a.lifecycle.event({provider:'codex',type:'file_change',id:'unseen',state:'failed'});
  assert.equal(a.created.length,2);
  const failed = terminalUpdate(a.created[1], 'failed');
  assert.equal(failed.metadata.missingStart,true);
  assert.equal(failed.level,'ERROR');
  assert.equal(a.created[1].ended,1);
});

test('invalid tools are ignored and tracing failures cannot break execution', () => {
  const l = createToolTraceLifecycle(() => {throw Error('telemetry offline')});
  assert.doesNotThrow(() => {
    l.event({provider:'codex',type:'reasoning',id:'r',state:'started'});
    l.event({provider:'codex',type:'command_execution',id:'r',state:'started'});
    l.event({provider:'codex',type:'command_execution',id:'r',state:'completed'});
    l.finish();
  });
});
