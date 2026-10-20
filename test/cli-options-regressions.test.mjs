import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_EFFORTS, CLAUDE_EFFORTS, resolveCliOptions, codexThreadOptions,
  claudeModelOptions, applyCliRequestOptions } from '../src/cli-options.mjs';
import { validateRequest, validateResponsesRequest } from '../src/protocol.mjs';
import { workspaceInstructions } from '../src/workspace-instructions.mjs';

test('every exposed effort reaches the corresponding SDK option unchanged', () => {
  for (const effort of CODEX_EFFORTS) {
    const cliOptions = resolveCliOptions('gpt-codex', { reasoning: { effort } }, {}, {});
    assert.equal(codexThreadOptions({ cliOptions, webSearch: false }, '/tmp').modelReasoningEffort, effort);
  }
  for (const effort of CLAUDE_EFFORTS) {
    const options = resolveCliOptions('claude-max', { reasoning_effort: effort }, {}, {});
    assert.equal(claudeModelOptions(options).effort, effort);
  }
  assert.equal(resolveCliOptions('gpt-codex', {}, {}, {}).reasoning_effort, 'medium');
  assert.equal(resolveCliOptions('gpt-codex-deep', {}, {}, {}).reasoning_effort, 'high');
});

test('invalid nested options and inherited model names fail as client errors', () => {
  for (const body of [null, [], 'text', { reasoning: [] }, { reasoning: 'high' }, { text: [] }, { text: 'low' }]) {
    assert.throws(() => resolveCliOptions('gpt-codex', body, {}, {}), error => error.status === 400);
  }
  for (const model of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => resolveCliOptions(model, {}, {}, {}), error => error.status === 400);
  }
});

test('native search instructions follow the effective switch and never enter saved system state', () => {
  for (const validate of [validateRequest, validateResponsesRequest]) {
    const request = validate({ model: 'gpt-codex', messages: [{ role: 'user', content: 'Search' }],
      input: 'Search', tools: [{ type: 'web_search' }] });
    assert.equal(request.webSearch, true);
    assert.doesNotMatch(request.system, /Live web search is available/);
    assert.match(workspaceInstructions(request, '/tmp'), /Live web search is available/);
    applyCliRequestOptions(request, resolveCliOptions('gpt-codex', { web_search: false }, {}, {}));
    assert.equal(request.webSearch, false);
    assert.doesNotMatch(workspaceInstructions(request, '/tmp'), /Live web search is available/);
  }
});
