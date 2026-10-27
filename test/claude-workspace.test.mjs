import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runClaude, EXEC_TOOL, WEB_TOOLS, publicWebUrl, claudeWorkspaceServer } from '../src/claude-workspace.mjs';
import { snapshotWorkspace } from '../src/output-files.mjs';
import { validateFinishedFiles } from '../src/file-toolkit.mjs';

const request = {system:'Respect user intent.',prompt:'Hello',attachments:[],cliOptions:{provider:'claude',reasoning_effort:'high'}};
const envelope = (text, artifact={task:'answer',status:'text',files:[]}) => ({response:{text},artifact});
async function workspace(t) {
  const root=await mkdtemp(join(tmpdir(),'claude-workspace-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=join(root,'workspace');await mkdir(cwd);return {root,cwd,before:await snapshotWorkspace(cwd)};
}
function scriptedSdk(turn) {
  const calls=[];
  return {calls,tool:(name,description,schema,handler)=>({name,description,schema,handler}),createSdkMcpServer: config=>config,
    query(input) {
      calls.push(input);let closed=false;
      const stream=(async function* () {
        const blocks=[];for await(const value of input.prompt) blocks.push(...value.message.content);
        yield {type:'assistant',message:{content:[{type:'text',text:'Do not publish this unvalidated success claim.'}]}};
        yield {type:'result',subtype:'success',session_id:'private-session',usage:{input_tokens:3,output_tokens:2},...await turn(input,blocks,calls.length)};
      })(); stream.close=()=>{closed=true;}; input.wasClosed=()=>closed;return stream;
    }};
}
async function run(cwd,before,sdk,extras={},input=request) {
  const events=[];for await(const event of runClaude(input,new AbortController().signal,cwd,before,{HOME:join(cwd,'private-home')},{sdk,executor:{queue:Promise.resolve(),execute:()=>{throw Error('No shell expected');}},validateFiles:async()=>{},...extras}))events.push(event);return events;
}

test('scripted Claude ordinary answer is validated, buffered, and never invokes a shell',async t=>{
  const {cwd,before}=await workspace(t);const sdk=scriptedSdk(async()=>({structured_output:envelope('Hola')}));
  const events=await run(cwd,before,sdk);assert.equal(events.find(event=>event.text).text,'Hola');assert.equal(events.some(event=>event.files),false);
  const options=sdk.calls[0].options;
  assert.deepEqual(options.tools,['Read','Write','Edit']);assert.ok(options.allowedTools.includes(EXEC_TOOL));
  assert.equal(options.persistSession,true);assert.equal(options.strictMcpConfig,true);assert.deepEqual(options.settingSources,[]);
  assert.match(options.systemPrompt,/file-tools.py/);assert.doesNotMatch(options.systemPrompt,/has no shell/);
  assert.equal(sdk.calls[0].wasClosed(),true);
});

test('file permission hook denies outside paths even when Read is pre-approved',async t=>{
  const {root,cwd,before}=await workspace(t);const sdk=scriptedSdk(async()=>({structured_output:envelope('Hola')}));await run(cwd,before,sdk);
  const options=sdk.calls[0].options,hook=options.hooks.PreToolUse[0].hooks[0];
  assert.equal((await hook({tool_input:{file_path:join(root,'secret')}})).hookSpecificOutput.permissionDecision,'deny');
  assert.deepEqual(await hook({tool_input:{file_path:'outputs/new.txt'}}),{});
  assert.equal((await options.canUseTool('Bash',{command:'echo unsafe'})).behavior,'deny');
  if(process.platform!=='win32') {
    await symlink(root,join(cwd,'escape'));
    assert.equal((await hook({tool_input:{file_path:'escape/new.txt'}})).hookSpecificOutput.permissionDecision,'deny');
  }
});

test('repair resumes the private Claude session and returns only the selected deliverable',async t=>{
  const {cwd,before}=await workspace(t);
  const sdk=scriptedSdk(async(input,blocks,number)=>{
    if(number===1){assert.equal(input.options.resume,undefined);await mkdir(join(cwd,'work'),{recursive:true});await writeFile(join(cwd,'work/helper.py'),'helper');}
    else {assert.equal(input.options.resume,'private-session');assert.match(blocks[0].text,/rejected.*missing/s);await writeFile(join(cwd,'outputs/result.txt'),'actual edited file');}
    return {structured_output:envelope(number===1?'False success':'Valid file',{task:'edit',status:'files',files:['outputs/result.txt']})};
  });
  const events=await run(cwd,before,sdk);assert.equal(sdk.calls.length,2);assert.equal(events.find(e=>e.text).text,'Valid file');
  assert.equal(events.find(e=>e.usage).usage.total_tokens,10);assert.deepEqual(events.at(-1).files.map(f=>f.filename),['result.txt']);
  assert.equal(Buffer.from(events.at(-1).files[0].data,'base64').toString(),'actual edited file');
});

test('Claude cannot deliver an unexecuted helper as an Office edit',async t=>{
  const {cwd,before}=await workspace(t);const sdk=scriptedSdk(async()=>{
    await writeFile(join(cwd,'outputs/edit.py'),'print("not an edited DOCX")');return {structured_output:envelope('Edited',{task:'edit',status:'files',files:['outputs/edit.py']})};
  });
  await assert.rejects(run(cwd,before,sdk),/helper script/);assert.equal(sdk.calls.length,2);
});

test('LibreChat tool relay preserves the action schema inside the artifact envelope',async t=>{
  const {cwd,before}=await workspace(t);const decision={action:'tool_call',text:'',name:'search',arguments_json:'{"q":"current"}'};
  const outputSchema={type:'object',properties:{action:{type:'string'},text:{type:'string'},name:{type:'string'},arguments_json:{type:'string'}}};
  const sdk=scriptedSdk(async()=>({structured_output:{response:decision,artifact:{task:'answer',status:'text',files:[]}}}));
  const events=await run(cwd,before,sdk,{}, {...request,toolRelay:true,outputSchema});
  assert.deepEqual(JSON.parse(events.find(e=>e.text).text),decision);assert.deepEqual(sdk.calls[0].options.outputFormat.schema.properties.response,outputSchema);
});

test('normalized images and original PDF blocks still reach Claude',async t=>{
  const {cwd,before}=await workspace(t);const path=join(cwd,'image.png');await writeFile(path,Buffer.from([1,2,3]));
  const sdk=scriptedSdk(async(input,blocks)=>{
    assert.deepEqual(blocks.map(b=>b.type),['text','image','document']);assert.equal(blocks[1].source.data,'AQID');assert.equal(blocks[2].source.data,'JVBERg==');return {structured_output:envelope('Read')};
  });
  await run(cwd,before,sdk,{}, {...request,visionImages:[{path,mimeType:'image/png'}],attachments:[{filename:'input.pdf',mimeType:'application/pdf',data:'JVBERg=='}]});
});

test('workspace tool reports execution errors so Claude can repair, and returns captured output',async()=>{
  const sdk=scriptedSdk(()=>{}),diagnostics=[];
  const server=claudeWorkspaceServer(sdk,{execute:async()=>({exitCode:4,stdout:'',stderr:'bad document'})},new AbortController().signal,diagnostics);
  const result=await server.tools[0].handler({command:'edit'});assert.equal(result.isError,true);assert.equal(diagnostics[0].exitCode,4);assert.match(result.content[0].text,/bad document/);
  const failed=claudeWorkspaceServer(sdk,{execute:async()=>{throw Error('sandbox unavailable');}},new AbortController().signal,diagnostics);
  assert.equal((await failed.tools[0].handler({command:'edit'})).isError,true);
});

test('real pinned Claude SDK accepts the in-process workspace tool definition',async()=>{
  const sdk=await import('@anthropic-ai/claude-agent-sdk');
  const server=claudeWorkspaceServer(sdk,{execute:async()=>({exitCode:0,stdout:'okay',stderr:''})},new AbortController().signal,[]);
  assert.equal(server.type,'sdk');assert.equal(server.name,'workspace');assert.ok(server.instance);
  const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'workspace-test',version:'1.0.0'});
  await server.instance.connect(serverTransport);await client.connect(clientTransport);
  try {
    const listing=await client.listTools();assert.equal(listing.tools[0].name,'execute');
    const result=await client.callTool({name:'execute',arguments:{command:'fixture',timeout_ms:1000}});
    assert.equal(JSON.parse(result.content[0].text).stdout,'okay');
  } finally {await client.close();await server.instance.close();}
});

test('an SDK failure aborts the active shell before returning control for workspace cleanup',async t=>{
  const {cwd,before}=await workspace(t);let finished=false,started;
  const launched=new Promise(done=>{started=done;});
  const executor={queue:Promise.resolve(),execute(command,{signal}){
    const pending=new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{finished=true;reject(new Error('shell aborted'));},{once:true});started();});
    this.queue=pending.catch(()=>{});return pending;
  }};
  const sdk=scriptedSdk(()=>{});
  sdk.query=input=>{
    const stream=(async function*(){
      void input.options.mcpServers.workspace.tools[0].handler({command:'long command'}).catch(()=>{});
      await launched;throw new Error('SDK disconnected');
    })();stream.close=()=>{};return stream;
  };
  await assert.rejects(run(cwd,before,sdk,{executor}),/SDK disconnected/);assert.equal(finished,true);
});

test('scripted Claude executes a real Python DOCX edit and repairs corrupt output before delivery', {skip:!process.env.FILE_TEST_PYTHON},async t=>{
  const {cwd,before}=await workspace(t),python=process.env.FILE_TEST_PYTHON;
  const sdk=scriptedSdk(async(input,blocks,number)=>{
    const handler=input.options.mcpServers.workspace.tools[0].handler;
    if(number===1) await writeFile(join(cwd,'outputs/result.docx'),'fake office file');
    else {
      assert.equal(input.options.resume,'private-session');assert.match(blocks[0].text,/zip/i);
      await writeFile(join(cwd,'work/edit.py'),"from docx import Document\nfrom docx.shared import RGBColor\nd=Document();r=d.add_paragraph().add_run('Edited by Claude workflow');r.font.color.rgb=RGBColor.from_string('FF0000');d.save('outputs/result.docx')\n");
      assert.equal((await handler({command:'execute fixture'})).isError,false);
    }
    return {structured_output:envelope(number===1?'Unvalidated':'Edited document',{task:'edit',status:'files',files:['outputs/result.docx']})};
  });
  // The executor substitute runs only the test's fixed fixture; OS sandbox enforcement has separate host probes.
  const executor={queue:Promise.resolve(),execute:async()=>{const result=await promisify(execFile)(python,[join(cwd,'work/edit.py')],{cwd});return {exitCode:0,...result};}};
  const events=await run(cwd,before,sdk,{executor,validateFiles:files=>validateFinishedFiles(files,cwd,{python,env:process.env})});
  assert.equal(sdk.calls.length,2);assert.equal(events.find(e=>e.text).text,'Edited document');
  const output=events.at(-1).files[0];assert.equal(output.filename,'result.docx');assert.equal(Buffer.from(output.data,'base64').subarray(0,2).toString(),'PK');
  const result=await promisify(execFile)(python,['-c',"from docx import Document; d=Document('outputs/result.docx'); assert str(d.paragraphs[0].runs[0].font.color.rgb)=='FF0000';print(d.paragraphs[0].text)"],{cwd});
  assert.match(result.stdout,/Edited by Claude workflow/);assert.equal((await readFile(join(cwd,'outputs/result.docx'))).length,output.bytes);
});

test('Claude gets native web tools only when web search is enabled',async t=>{
  const {cwd,before}=await workspace(t);
  const off=scriptedSdk(async()=>({structured_output:envelope('Hola')}));await run(cwd,before,off);
  assert.deepEqual(off.calls[0].options.tools,['Read','Write','Edit']);
  assert.equal((await off.calls[0].options.canUseTool('WebSearch',{query:'news'})).behavior,'deny');
  const on=scriptedSdk(async()=>({structured_output:envelope('Hola')}));await run(cwd,before,on,{},{...request,webSearch:true});
  const options=on.calls[0].options;
  assert.deepEqual(options.tools,['Read','Write','Edit',...WEB_TOOLS]);
  assert.equal((await options.canUseTool('WebSearch',{query:'news'})).behavior,'allow');
  assert.equal((await options.canUseTool('WebFetch',{url:'http://127.0.0.1:3080/api'})).behavior,'deny');
  const fetchHook=options.hooks.PreToolUse.find(entry=>entry.matcher==='^WebFetch$').hooks[0];
  assert.equal((await fetchHook({tool_input:{url:'http://192.168.1.1/'}})).hookSpecificOutput.permissionDecision,'deny');
});

test('WebFetch targets must be public http(s) addresses',async()=>{
  const resolveTo=address=>async()=>[{address}];
  for(const url of ['https://example.com/a','http://93.184.216.34/']) assert.equal(await publicWebUrl(url,resolveTo('93.184.216.34')),true);
  for(const url of ['file:///etc/passwd','ftp://example.com/','https://user:pw@example.com/','http://localhost:3080/','http://LibreChat:3080/',
    'http://cli-bridge:4000/','http://router.lan/','http://nas.local/','http://10.0.0.5/','http://172.21.0.2/','http://192.168.1.43:8443/',
    'http://169.254.169.254/latest','http://[::1]/','http://[::ffff:127.0.0.1]/','http://[::ffff:7f00:1]/','http://[64:ff9b::a00:1]/','http://[fd00::1]/','http://0.0.0.0/','not a url'])
    assert.equal(await publicWebUrl(url,resolveTo('93.184.216.34')),false,url);
  assert.equal(await publicWebUrl('https://rebind.example/',resolveTo('192.168.1.43')),false);
  assert.equal(await publicWebUrl('https://split.example/',async()=>[{address:'93.184.216.34'},{address:'10.0.0.1'}]),false);
  assert.equal(await publicWebUrl('https://missing.example/',async()=>{throw Object.assign(Error('ENOTFOUND'),{code:'ENOTFOUND'});}),false);
});
