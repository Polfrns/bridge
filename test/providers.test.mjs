import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliOptions } from '../src/cli-options.mjs';
import { validateResponsesRequest, parseToolDecision } from '../src/protocol.mjs';
import { runProvider } from '../src/providers.mjs';

test('Codex SDK validates structured text, LibreChat functions and actual files without a model-written manifest', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  const executable = join(dir, 'fake-codex.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2).join(' ');
if (!args.includes('mcp_servers={}') || !args.includes('features.shell_tool=true') || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) process.exit(2);
if (!args.includes('model_reasoning_effort=\"high\"') || !args.includes('model_verbosity=\"low\"') || !process.env.CODEX_HOME.includes('run-') || !process.env.HOME.includes('run-')) process.exit(3);
const argv = process.argv.slice(2);
if (argv[argv.indexOf('--sandbox')+1] !== 'workspace-write' || !args.includes('sandbox_mode=\"workspace-write\"') || !args.includes('approval_policy=\"never\"')) process.exit(5);
if (input.includes('summary-test')) {
 const summary = input.includes('summary-test-none') ? 'none' : 'detailed';
 if (!argv.includes('model_reasoning_summary='+JSON.stringify(summary)) || !argv.includes('web_search="live"') || !argv.includes('sandbox_workspace_write.network_access=true')) process.exit(6);
}
const cwd = argv[argv.indexOf('--cd')+1];
const schema = JSON.parse(readFileSync(argv[argv.indexOf('--output-schema')+1],'utf8'));
if (!schema.properties.artifact || !schema.properties.response || existsSync(join(cwd,'bridge-result.json'))) process.exit(4);
let response = {text:'Hola Pol'}, artifact = {task:'answer',status:'text',files:[]};
if (schema.properties.response.properties.action) response = {action:'tool_call',text:'',name:'lookup',arguments_json:'{"query":"hello"}'};
if (input.includes('create-real') || input.includes('create-missing')) {
 response = {text:'result.pdf ready'}; artifact = {task:'create',status:'files',files:['outputs/result.pdf']};
 if (input.includes('create-real')) writeFileSync(join(cwd,'outputs/result.pdf'),Buffer.from('JVBERi0xLjcKJcK1wrYKCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCgoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvQ291bnQgMS9LaWRzWzQgMCBSXT4+CmVuZG9iagoKMyAwIG9iago8PD4+CmVuZG9iagoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDU5NSA4NDJdL1JvdGF0ZSAwL1Jlc291cmNlcyAzIDAgUi9QYXJlbnQgMiAwIFI+PgplbmRvYmoKCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDYyIDAwMDAwIG4gCjAwMDAwMDAxMTQgMDAwMDAgbiAKMDAwMDAwMDEzNSAwMDAwMCBuIAoKdHJhaWxlcgo8PC9TaXplIDUvUm9vdCAxIDAgUi9JRFs8QzNBOEMyQjIxNEMzOTNDM0FBMDQxMzEwNzRDM0E2QzI+PDdERjM1MkQ3RUM0QjUzNUY3NDJGMjRENjNERkJGNTQwPl0+PgpzdGFydHhyZWYKMjI2CiUlRU9GCg==','base64'));
}
if (input.includes('unsupported-edit')) {
 response = {text:'This edit is unavailable'}; artifact = {task:'edit',status:'unsupported',files:[]};
}
for (const event of [
 {type:'thread.started',thread_id:'test'},
 ...(input.includes('summary-test') ? [{type:'item.completed',item:{id:'summary',type:'reasoning',text:'Visible SDK summary'}}] : []),
 {type:'item.updated',item:{id:'one',type:'agent_message',text:'Hola'}},
 {type:'item.completed',item:{id:'one',type:'agent_message',text:JSON.stringify({response,artifact})}},
 {type:'turn.completed',usage:{input_tokens:10,output_tokens:3,cached_input_tokens:2}}
]) console.log(JSON.stringify(event));
`);
  await chmod(executable, 0o755);
  const authDir = join(dir, 'auth');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(authDir);
  await writeFile(join(authDir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake' } }));
  const previousAuth = process.env.CODEX_AUTH_DIR;
  const previousData = process.env.BRIDGE_DATA_DIR;
  process.env.CODEX_AUTH_DIR = authDir;
  process.env.BRIDGE_DATA_DIR = join(dir, 'runtime');
  const previous = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = executable;
  t.after(async () => { if (previous === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previous; if (previousAuth === undefined) delete process.env.CODEX_AUTH_DIR; else process.env.CODEX_AUTH_DIR = previousAuth; if (previousData === undefined) delete process.env.BRIDGE_DATA_DIR; else process.env.BRIDGE_DATA_DIR = previousData; await rm(dir, { recursive: true, force: true }); });
  const request = { model: 'gpt-codex', system: '', prompt: 'Hi', attachments: [], context: {userKey: 'user-a', conversationKey: 'conversation-a'}, cliOptions: resolveCliOptions('gpt-codex', {reasoning_effort: 'high', verbosity: 'low'}) };
  const collect = async extra => {
    const result = [];
    for await (const event of runProvider({...request,...extra},new AbortController().signal)) result.push(event);
    return result;
  };
  const events = await collect({});
  assert.equal(events.map(e => e.text || '').join(''), 'Hola Pol');
  assert.equal(events.at(-1).usage.total_tokens, 13);
  for (const reasoning_summary of ['detailed','none']) {
    const progress=[];
    const summaries = await collect({onProviderProgress:event=>progress.push(event),prompt:'summary-test-'+reasoning_summary,webSearch:true,cliOptions:resolveCliOptions('gpt-codex',{reasoning_effort:'high',verbosity:'low',reasoning_summary,web_search:true})});
    assert.equal(progress.some(event=>event.text === 'Visible SDK summary'),reasoning_summary !== 'none');
    assert.equal(summaries.some(event=>event.reasoning),false);
  }
  const relay = {...request,...validateResponsesRequest({model:'gpt-codex',input:'lookup hello',tools:[{type:'function',name:'lookup',description:'Lookup a value',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}]})};
  const toolEvents = await collect(relay);
  assert.deepEqual(parseToolDecision(toolEvents.map(event=>event.text||'').join(''),relay),{type:'tool_call',name:'lookup',arguments:{query:'hello'}});
  const fileEvents = await collect({prompt:'create-real'});
  assert.equal(fileEvents.at(-1).files[0].filename,'result.pdf');
  await assert.rejects(collect({prompt:'create-missing'}),/Cannot replace a rejected file delivery/);
  const unsupported = await collect({prompt:'unsupported-edit'});
  assert.equal(unsupported[0].text,'This edit is unavailable');
  assert.equal(unsupported.some(event=>event.files),false);
});
