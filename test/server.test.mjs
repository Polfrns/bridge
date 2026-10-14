import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { BRIDGE_OUTPUT_PREFIX, createBridge } from '../src/server.mjs';

const key = 'test-key-'.repeat(8);
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
import { signedHeaders } from './helpers/identity.mjs';
const body = { model: 'gpt-codex', messages: [{ role: 'user', content: 'Hola' }] };
async function serve(t, provider, options = {}) {
  const server = createBridge({ key, provider, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.abortProviders(); server.close(); server.closeAllConnections(); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function* ok() { yield { text: 'Hola ' }; yield { text: 'Pol' }; yield { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }; }
const post = (url, payload, customHeaders = headers, path = '/v1/chat/completions') => fetch(url + path, { method: 'POST', headers: { ...signedHeaders(key, payload.model), ...customHeaders }, body: JSON.stringify(payload) });

test('health and model discovery require no inference; models require authentication', async t => {
  const url = await serve(t, async function* () { assert.fail('unexpected inference'); });
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + '/v1/models')).status, 401);
  const result = await (await fetch(url + '/v1/models', { headers })).json();
  assert.deepEqual(result.data.map(m => m.id), ['gpt-codex', 'gpt-codex-fast', 'gpt-codex-deep', 'claude-max', 'claude-max-fast', 'claude-max-deep']);
});
test('plain completion includes response and usage', async t => {
  const url = await serve(t, ok);
  const res = await post(url, body); assert.equal(res.status, 200);
  const result = await res.json(); assert.equal(result.choices[0].message.content, 'Hola Pol');
  assert.equal(result.usage.total_tokens, 7);
});
test('generated files are returned in a marked assistant payload', async t => {
  const url = await serve(t, async function* () {
    yield { text: 'File is ready.' };
    yield {
      files: [
        {
          filename: 'answer.txt',
          mimeType: 'text/plain',
          bytes: 2,
          data: 'b2s=',
        },
      ],
    };
  });
  const response = await post(url, body);
  const result = await response.json();
  const content = result.choices[0].message.content;

  assert.ok(content.startsWith(BRIDGE_OUTPUT_PREFIX));
  assert.deepEqual(JSON.parse(content.slice(BRIDGE_OUTPUT_PREFIX.length)), {
    text: 'File is ready.',
    files: [{ filename: 'answer.txt', mimeType: 'text/plain', data: 'b2s=' }],
  });
});
test('streamed generated files remain in one marked assistant content delta', async t => {
  const url = await serve(t, async function* () {
    yield { text: 'File is ready.' };
    yield {
      files: [{ filename: 'answer.txt', mimeType: 'text/plain', bytes: 2, data: 'b2s=' }],
    };
  });
  const response = await post(url, { ...body, stream: true });
  const chunks = (await response.text())
    .split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice('data: '.length)));
  const contentChunks = chunks.filter(chunk => chunk.choices[0]?.delta?.content);

  assert.equal(contentChunks.length, 1);
  const content = contentChunks[0].choices[0].delta.content;
  assert.ok(content.startsWith(BRIDGE_OUTPUT_PREFIX));
  assert.deepEqual(JSON.parse(content.slice(BRIDGE_OUTPUT_PREFIX.length)), {
    text: 'File is ready.',
    files: [{ filename: 'answer.txt', mimeType: 'text/plain', data: 'b2s=' }],
  });
});
test('stream emits content, stop, optional usage and DONE', async t => {
  const url = await serve(t, ok);
  const res = await post(url, { ...body, stream: true, stream_options: { include_usage: true } });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const output = await res.text();
  assert.match(output, /"content":"Hola Pol"/);
  assert.match(output, /"finish_reason":"stop"/); assert.match(output, /"total_tokens":7/);
  assert.match(output, /data: \[DONE\]/);
});
test('full history and instructions are passed independently per request', async t => {
  const inputs = [];
  const url = await serve(t, async function* (request) { inputs.push(request); yield { text: 'OK' }; });
  await post(url, { ...body, messages: [{ role: 'system', content: 'Català' }, { role: 'user', content: 'Nom Pol' }, { role: 'assistant', content: 'Entès' }, { role: 'user', content: 'Nom?' }] });
  await post(url, body);
  assert.equal(inputs[0].system, 'Català'); assert.match(inputs[0].prompt, /Nom Pol/);
  assert.equal(inputs[1].system, ''); assert.doesNotMatch(inputs[1].prompt, /Nom Pol/);
});
test('native web search is supported; remote image URLs fail clearly; unsupported models are rejected', async t => {
  const url = await serve(t, async function* (request) { assert.equal(request.webSearch, true); yield { text: 'OK' }; });
  assert.equal((await post(url, { ...body, tools: [{ type: 'web_search_preview' }] })).status, 200);
  assert.equal((await post(url, { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com' } }] }] })).status, 422);
  assert.equal((await post(url, { ...body, model: 'unknown' })).status, 400);
});
test('invalid JSON, media type and oversized bodies return clear errors', async t => {
  const url = await serve(t, ok, { maxBytes: 256 });
  assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await post(url, body, { Authorization: headers.Authorization, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(url, { ...body, padding: 'x'.repeat(300) })).status, 413);
});
test('provider error never becomes a successful completion', async t => {
  const url = await serve(t, async function* () { throw new Error('Backend unavailable'); });
  assert.equal((await post(url, body)).status, 502);
  const output = await (await post(url, { ...body, stream: true })).text();
  assert.match(output, /"error"/); assert.doesNotMatch(output, /"finish_reason":"stop"/);
});
test('timeout aborts backend', async t => {
  const url = await serve(t, async function* (_, signal) { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }, { timeoutMs: 30 });
  const res = await post(url, body); assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /timed out/);
});
test('concurrency is bounded while a provider is active', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const url = await serve(t, async function* () { started(); await ready; yield { text: 'OK' }; }, { maxConcurrent: 1 });
  const first = post(url, body); await start;
  assert.equal((await post(url, body)).status, 429);
  release(); assert.equal((await first).status, 200);
});
test('text content blocks are accepted', async t => {
  const url = await serve(t, ok);
  assert.equal((await post(url, { ...body, messages: [{ role: 'user', content: [{ type: 'text', text: 'document text' }] }] })).status, 200);
});

test('Responses API returns a completed response object', async t => {
  const url = await serve(t, ok);
  const res = await post(url, { model: 'gpt-codex', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hola' }] }] }, headers, '/v1/responses');
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.object, 'response'); assert.equal(result.status, 'completed');
  assert.equal(result.output[0].content[0].text, 'Hola Pol');
  assert.equal(result.usage.input_tokens, 5); assert.equal(result.usage.total_tokens, 7);
});
test('Responses stream emits ordered response events and DONE', async t => {
  const url = await serve(t, ok);
  const res = await post(url, { model: 'gpt-codex', input: 'Hola', stream: true }, headers, '/v1/responses');
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const output = await res.text();
  assert.match(output, /event: response.created/); assert.match(output, /event: response.output_text.delta/);
  assert.match(output, /"delta":"Hola Pol"/); assert.match(output, /event: response.output_text.done/);
  assert.match(output, /event: response.completed/); assert.match(output, /data: \[DONE\]/);
  const sequence = [...output.matchAll(/"sequence_number":(\d+)/g)].map(m => Number(m[1]));
  assert.deepEqual(sequence, sequence.map((_, i) => i + 1));
});
test('Responses API supports built-in web search and accepts base64 image input', async t => {
  const url = await serve(t, async function* (request) { assert.equal(request.webSearch, true); yield { text: 'OK' }; });
  assert.equal((await post(url, { model: 'gpt-codex', input: 'Hi', tools: [{ type: 'web_search_preview' }] }, headers, '/v1/responses')).status, 200);
  const mediaUrl = await serve(t, async function* (request) { assert.equal(request.attachments[0].mimeType, 'image/png'); yield { text: 'Image received' }; });
  const imageRes = await post(mediaUrl, { model: 'gpt-codex', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }] }, headers, '/v1/responses');
  assert.equal(imageRes.status, 200);
  assert.equal((await post(url, { model: 'gpt-codex', previous_response_id: 'resp_x', input: 'Hi' }, headers, '/v1/responses')).status, 400);
});

test('Responses API relays a function call in a standard completed response', async t => {
  const url = await serve(t, async function* (request) {
    assert.equal(request.toolRelay, true);
    yield { text: JSON.stringify({ action: 'tool_call', text: '', name: 'list_files_mcp_leedeo-filestore', arguments_json: '{"filestore_uid":"fs_1"}' }) };
  });
  const res = await post(url, {
    model: 'gpt-codex', input: 'List files',
    tools: [{ type: 'function', name: 'list_files_mcp_leedeo-filestore', parameters: { type: 'object', properties: { filestore_uid: { type: 'string' } } } }],
  }, headers, '/v1/responses');
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.output[0].type, 'function_call');
  assert.equal(result.output[0].name, 'list_files_mcp_leedeo-filestore');
  assert.equal(JSON.parse(result.output[0].arguments).filestore_uid, 'fs_1');
  assert.ok(result.id.startsWith('resp_'));
});

test('Chat Completions relays a function call and finish_reason', async t => {
  const url = await serve(t, async function* () {
    yield { text: JSON.stringify({ action: 'tool_call', text: '', name: 'read_file', arguments_json: '{"path":"a.txt"}' }) };
  });
  const res = await post(url, { ...body, tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }] });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.equal(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments).path, 'a.txt');
});

test('Responses API streams function-call events for LibreChat to execute', async t => {
  const url = await serve(t, async function* () {
    yield { text: JSON.stringify({ action: 'tool_call', text: '', name: 'read_file', arguments_json: '{"path":"report.pdf"}' }) };
  });
  const res = await post(url, { model: 'gpt-codex', input: 'Read', stream: true, tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }] }, headers, '/v1/responses');
  const output = await res.text();
  assert.match(output, /event: response\.function_call_arguments\.delta/);
  assert.match(output, /"name":"read_file"/);
  assert.match(output, /event: response\.completed/);
});

test('Responses API continues from previous_response_id after a tool result', async t => {
  const inputs = [];
  const url = await serve(t, async function* (request) {
    inputs.push(request.prompt);
    if (inputs.length === 1) yield { text: JSON.stringify({ action: 'tool_call', text: '', name: 'read_file', arguments_json: '{"path":"a.txt"}' }) };
    else yield { text: JSON.stringify({ action: 'message', text: 'The file says hello.', name: '', arguments_json: '{}' }) };
  });
  const first = await post(url, { model: 'gpt-codex', input: 'Read a file', tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }] }, headers, '/v1/responses');
  const response = await first.json();
  const result = await post(url, { model: 'gpt-codex', previous_response_id: response.id, input: [{ type: 'function_call_output', call_id: response.output[0].call_id, output: 'hello' }] }, headers, '/v1/responses');
  assert.equal(result.status, 200);
  assert.equal((await result.json()).output[0].content[0].text, 'The file says hello.');
  assert.match(inputs[1], /hello/);
});

// Progress is a status report, not an executable LibreChat function call.
test('bridge tools stream safe activity before final response', async t => {
  const url = await serve(t, async function* (request) {
    request.onBridgeActivity?.({provider:'codex',type:'command_execution',id:'c1',state:'started',command:'secret=abc'});
    await new Promise(resolve => setTimeout(resolve, 10));
    request.onBridgeActivity?.({provider:'codex',type:'command_execution',id:'c1',state:'completed'});
    yield {text:'Done'};
  });
  const result = await post(url, {...body,stream:true});
  const output = await result.text();
  assert.equal(result.status, 200);
  assert.match(output, /reasoning_content/);
  assert.match(output, /Comando del workspace/);
  assert.match(output, /"content":"Done"/);
  assert.doesNotMatch(output, /secret=abc/);
  assert.doesNotMatch(output, /"tool_calls":/);
  assert.ok(output.indexOf('reasoning_content') < output.indexOf('"content":"Done"'));
});
