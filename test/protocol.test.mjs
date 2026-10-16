import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, validateResponsesRequest, parseToolDecision, responsesUsage, BridgeError } from '../src/protocol.mjs';

test('Responses input normalizes instructions and full text history', () => {
  const request = validateResponsesRequest({
    model: 'gpt-codex',
    instructions: 'Be concise',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'First' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] },
      { role: 'user', content: 'Latest' },
    ],
    stream: true,
  });
  assert.equal(request.model, 'gpt-codex');
  assert.equal(request.stream, true);
  assert.equal(request.system, 'Be concise');
  assert.match(request.prompt, /First/);
  assert.match(request.prompt, /Latest/);
});

for (const model of ['gpt-codex', 'claude-max']) {
  test(`Responses reasoning replay preserves tool results without forwarding summaries: ${model}`, () => {
    const input = [
      {role:'user', content:'List the filestores'},
      {type:'reasoning', id:'rs_activity', status:'completed', summary:[{type:'summary_text',text:'DO_NOT_FORWARD_REASONING [[ROKO_BRIDGE_TOOL_V1:activity]]'}]},
      {type:'function_call',call_id:'call_store',name:'list_filestores',arguments:'{}'},
      {type:'reasoning',id:'rs_opaque',summary:[],encrypted_content:'DO_NOT_FORWARD_OPAQUE_STATE'},
      {type:'function_call_output',call_id:'call_store',output:'STORE_LIST_RESULT'},
    ];
    const before=JSON.stringify(input);
    const request=validateResponsesRequest({model,input});
    assert.equal(request.conversation.length,3);
    assert.equal(request.conversation[1].function_call.call_id,'call_store');
    assert.deepEqual(request.conversation[2],{role:'tool',call_id:'call_store',output:'STORE_LIST_RESULT'});
    assert.match(request.prompt,/STORE_LIST_RESULT/);
    assert.doesNotMatch(request.prompt,/DO_NOT_FORWARD|ROKO_BRIDGE_TOOL_V1/);
    assert.equal(JSON.stringify(input),before);
  });
}

test('reasoning replay with previous_response_id does not duplicate stored history',()=>{
  const previous={conversation:[{role:'user',content:'List stores'},
    {role:'assistant',function_call:{call_id:'call_store',name:'list_filestores',arguments:{}}}]};
  const request=validateResponsesRequest({model:'gpt-codex',previous_response_id:'resp_previous',input:[
    {type:'reasoning',id:'rs_status',summary:[{type:'summary_text',text:'DO_NOT_FORWARD'}]},
    {type:'function_call_output',call_id:'call_store',output:'STORE_LIST_RESULT'},
  ]},previous);
  assert.equal(request.conversation.length,3);
  assert.match(request.prompt,/STORE_LIST_RESULT/);
  assert.doesNotMatch(request.prompt,/DO_NOT_FORWARD/);
  assert.throws(()=>validateResponsesRequest({model:'gpt-codex',input:[{role:'user',content:'Hello'},
    {type:'unsupported_item',content:'still rejected'}]}),/not supported/);
});

test('Responses input rejects features the bridge cannot fulfill', () => {
  const invalid = [
    { model: 'gpt-codex', input: 'Hi', tools: [{ type: 'code_interpreter' }] },
    { model: 'gpt-codex', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }] }] },
    { model: 'gpt-codex', input: 'Hi', previous_response_id: 'resp_x' },
  ];
  for (const body of invalid) assert.throws(() => validateResponsesRequest(body), BridgeError);
});

test('Responses usage maps normalized completion usage', () => {
  assert.deepEqual(responsesUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }), {
    input_tokens: 5, input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 7,
  });
});

test('Responses function definitions become a constrained LibreChat tool relay', () => {
  const request = validateResponsesRequest({
    model: 'gpt-codex',
    input: 'List files in the attached store',
    tools: [{ type: 'function', name: 'list_files_mcp_leedeo-filestore', description: 'List files', parameters: { type: 'object', properties: { filestore_uid: { type: 'string' } }, required: ['filestore_uid'] } }],
    tool_choice: 'auto',
  });
  assert.equal(request.toolRelay, true);
  assert.deepEqual(request.outputSchema.required, Object.keys(request.outputSchema.properties));
  assert.equal(request.outputSchema.properties.name.enum[1], 'list_files_mcp_leedeo-filestore');
  assert.equal(parseToolDecision(JSON.stringify({ action: 'tool_call', text: '', name: 'list_files_mcp_leedeo-filestore', arguments_json: '{"filestore_uid":"fs_123"}' }), request).type, 'tool_call');
  assert.equal(parseToolDecision(JSON.stringify({ action: 'message', text: 'Done', name: '', arguments_json: '{}' }), request).text, 'Done');
});

test('Responses images and base64 files become staged attachments', () => {
  const request = validateResponsesRequest({
    model: 'gpt-codex',
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Describe these.' },
      { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
      { type: 'input_file', filename: 'notes.txt', file_data: 'data:text/plain;base64,aGk=' },
    ] }],
  });
  assert.equal(request.attachments.length, 2);
  assert.match(request.prompt, /Describe these/);
  assert.equal(request.attachments[1].filename, 'notes.txt');
});

test('Chat Completions accepts base64 image blocks and rejects remote image URLs', () => {
  const request = validateRequest({ model: 'gpt-codex', messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is shown?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }] },
  ] });
  assert.equal(request.attachments.length, 1);
  assert.throws(() => validateRequest({ model: 'gpt-codex', messages: [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }] },
  ] }), /base64 data URLs/);
});

test('Chat Completions stages base64 file blocks, including LibreChat document uploads', () => {
  const request = validateRequest({ model: 'gpt-codex', messages: [
    { role: 'user', content: [
      { type: 'text', text: 'Edit this document.' },
      { type: 'file', file: { filename: 'prueba.docx', file_data: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEs=' } },
    ] },
  ] });
  assert.equal(request.attachments.length, 1);
  assert.equal(request.attachments[0].filename, 'prueba.docx');
  assert.equal(request.attachments[0].mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(request.prompt, /prueba\.docx/);
});

test('Chat Completions tool definitions and tool history are normalized', () => {
  const request = validateRequest({
    model: 'claude-max', stream: true,
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
    messages: [
      { role: 'user', content: 'Read it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'file contents' },
      { role: 'user', content: 'Summarize' },
    ],
  });
  assert.equal(request.toolRelay, true);
  assert.equal(request.stream, true);
  assert.match(request.prompt, /file contents/);
  assert.deepEqual(parseToolDecision(JSON.stringify({ action: 'tool_call', text: '', name: 'read_file', arguments_json: '{}' }), request), { type: 'tool_call', name: 'read_file', arguments: {} });
});

test('Responses web search maps to Codex native live search; hosted tools fail clearly', () => {
  assert.equal(validateResponsesRequest({ model: 'gpt-codex', input: 'Search', tools: [{ type: 'web_search_preview' }] }).webSearch, true);
  for (const type of ['file_search', 'code_interpreter']) {
    assert.throws(() => validateResponsesRequest({ model: 'gpt-codex', input: 'Use tool', tools: [{ type }] }), /OpenAI Responses runtime/);
  }
});

test('Responses allowed_tools restricts the relayed tool set', () => {
  const request = validateResponsesRequest({
    model: 'gpt-codex', input: 'Do one thing',
    tools: [
      { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'delete_file', parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read_file' }] },
  });
  assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']);
});


test('Responses accepts the base64 file shape emitted by LangChain 1.4.x', () => {
  const request = validateResponsesRequest({ model: 'gpt-codex', input: [{ role: 'user', content: [
    { type: 'input_text', text: 'Edit this file' },
    { type: 'file', file: { filename: 'prueba.docx', file_data: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,SG9sYQ==' } },
  ] }] });
  assert.equal(request.attachments.length, 1);
  assert.equal(request.attachments[0].filename, 'prueba.docx');
  assert.equal(Buffer.from(request.attachments[0].data, 'base64').toString(), 'Hola');
});
