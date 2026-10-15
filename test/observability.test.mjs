import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyOperation,generatedOperation} from '../src/operations.mjs';
import {safeActivity,createActivityReporter,activityCardRecord} from '../src/activity.mjs';
import {createToolTraceLifecycle,traceBridgeRequest} from '../src/langfuse-tracing.mjs';
import {trustedTraceContext} from '../src/trace-context.mjs';
import {verifyContext} from '../src/request-context.mjs';
import {completeArtifactRun} from '../src/artifacts.mjs';
import privacy from '../src/privacy.cjs';

test('Codex classification uses real structured command, patch, MCP and web fields',()=>{
  assert.equal(classifyOperation({provider:'codex',type:'command_execution',item:{command:'python3 hello.py'}}),'code.execute.python');
  assert.equal(classifyOperation({provider:'codex',type:'command_execution',item:{command:'/usr/bin/node hello.js'}}),'code.execute.javascript');
  for(const command of ['sh -c "python hello.py"','echo python','python a.py && curl x','cat /secret'])
    assert.equal(classifyOperation({provider:'codex',type:'command_execution',item:{command}}),'command_execution');
  assert.equal(classifyOperation({provider:'codex',type:'file_change',item:{changes:[{kind:'add',path:'a.py'}]}}),'workspace.write');
  assert.equal(classifyOperation({provider:'codex',type:'mcp_tool_call',item:{tool:'list_files',arguments:{password:'SENSITIVE'}}}),'mcp.list_files');
  assert.equal(classifyOperation({provider:'codex',type:'web_search',item:{query:'secret'}}),'web.search');
  assert.equal(classifyOperation({provider:'codex',type:'reasoning',item:{text:'execute python'}}),null);
});
test('Claude tool names and workspace command classify without exporting inputs',()=>{
  for(const [type,operation] of Object.entries({Read:'workspace.read',Write:'workspace.write',Edit:'workspace.edit',Glob:'workspace.list',Grep:'workspace.search',WebSearch:'web.search',WebFetch:'web.fetch'}))
    assert.equal(classifyOperation({provider:'claude',type}),operation);
  const e=safeActivity({provider:'claude',type:'mcp__workspace__execute',input:{command:'python test.py',secret:'SENSITIVE'},id:'secret-id',state:'started'});
  assert.equal(e.operation,'code.execute.python'); assert.doesNotMatch(JSON.stringify(e),/SENSITIVE|test.py|secret-id/);
});
test('V1 extended markers are idempotent, timed, and terminal states cannot regress',()=>{
  const received=[];const report=createActivityReporter(e=>received.push(e));
  const e={provider:'codex',type:'web_search',id:'a'};
  report({...e,state:'started'});report({...e,state:'started'});report({...e,state:'cancelled'});report({...e,state:'completed'});
  assert.deepEqual(received.map(x=>x.state),['started','cancelled']);assert.ok(received[1].durationMs>=0);
  const a=received[0];assert.equal(safeActivity(a).id,a.id);
  const decoded=JSON.parse(Buffer.from(activityCardRecord(a).match(/:([\w-]+)\]\]/)[1],'base64url'));
  assert.equal(decoded.id,a.id); assert.equal(decoded.v,1);assert.equal(decoded.operation,'web.search');
});
test('one span per operation and attempt; cancellation/error closes exactly once',()=>{
  const spans=[]; const l=createToolTraceLifecycle((name,options)=>{const s={name,options,ended:0,update(x){this.result=x},end(){this.ended++}};spans.push(s);return s;});
  const e={provider:'claude',type:'Write',id:'a',state:'started'};
  l.event(e);l.event({...e,state:'failed'});l.event({...e,state:'failed'});
  l.event({...e,attempt:2});l.finish('request_cancelled');
  assert.equal(spans.length,2);assert.ok(spans.every(s=>s.ended===1));
  assert.equal(spans[0].result.metadata.state,'failed');assert.equal(spans[1].result.metadata.state,'cancelled');
  assert.equal(spans[0].name,'workspace.write');
});
test('signed sessions remain stable per user, separate per conversation and tenant',()=>{
  const key='k'.repeat(32),now=Date.now();
  const make=(userId,conversationId,tenantId='')=>{
    const value=Buffer.from(JSON.stringify({userId,conversationId,tenantId,model:'gpt-codex',options:{},timestamp:now})).toString('base64url');
    return verifyContext({'x-roko-context':value,'x-roko-signature':createHmac('sha256',key).update(value).digest('hex')},'gpt-codex',key,now);
  };
  assert.equal(make('a','x').telemetrySessionKey,make('a','x').telemetrySessionKey);
  assert.notEqual(make('a','x').telemetrySessionKey,make('b','x').telemetrySessionKey);
  assert.notEqual(make('a','x').telemetrySessionKey,make('a','y').telemetrySessionKey);
  assert.notEqual(make('a','x','t1').telemetrySessionKey,make('a','x','t2').telemetrySessionKey);
  assert.notEqual(make('a','x','t1').ownerKey,make('a','x','t2').ownerKey);
});
test('W3C context requires a fresh service HMAC, never trusts raw headers',()=>{
  const key='t'.repeat(32),now=Date.now();
  const payload={timestamp:now,traceparent:'00-'+'1'.repeat(32)+'-'+'2'.repeat(16)+'-01',tracestate:'',sessionId:'3'.repeat(64),userId:'4'.repeat(64)};
  const raw=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const headers={'x-observability-context':raw,'x-observability-signature':createHmac('sha256',key).update(raw).digest('hex')};
  assert.equal(trustedTraceContext(headers,key,now).traceparent,payload.traceparent);
  assert.equal(trustedTraceContext(headers,key,now+61000),null);
  assert.equal(trustedTraceContext({...headers,'x-observability-context':raw+'x'},key,now),null);
  assert.equal(trustedTraceContext({traceparent:payload.traceparent},key,now),null);
});
test('DOCX, PDF, source code, credentials and binary never reach export; model input is unchanged',()=>{
  const input={messages:[{content:[{type:'file',source_type:'base64',mime_type:'application/pdf',data:Buffer.from('%PDF-DOCSECRET').toString('base64')}]}],
    docx:{data:'UEsDBBQABgAIAAA_DOCSECRET'},code:'API_KEY="SECRET_CODE"',Authorization:'Bearer SECRET_AUTH',password:'SECRET_PASSWORD',
    command:'python -c "SECRET_COMMAND"',env:{LANGFUSE_SECRET_KEY:'SECRET_KEY'},binary:Buffer.from('SECRET_BINARY')};
  const original=JSON.stringify(input);
  const safe=JSON.stringify(privacy.sanitizeData(input));
  assert.doesNotMatch(safe,/DOCSECRET|SECRET_|UEsDB|JVBER/);assert.equal(JSON.stringify(input),original);
  let exported;const processor=privacy.protectProcessor({onEnd:s=>exported=s});
  const source={name:'model.codex',attributes:{'langfuse.observation.input':original,'http.request.header.authorization':'SECRET_AUTH'},events:[{name:'SECRET_EVENT'}],status:{code:2,message:'SECRET_ERROR'}};
  processor.onEnd(source);assert.doesNotMatch(JSON.stringify(exported),/SECRET_|DOCSECRET/);assert.equal(source.attributes['langfuse.observation.input'],original);
});
test('artifact events only after actual py/docx/pdf collection and validation; repair is attempt 2',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'obs-artifact-'));const activity=[];
  try {
    const {mkdir}=await import('node:fs/promises');await mkdir(join(cwd,'outputs'));
    for(const ext of ['py','docx','pdf']) {
      let turn=0;
      const bytes=ext==='pdf'?'%PDF-1.4\nverified':'actual-file-bytes';
      const manifest={task:'code',status:'files',files:[`outputs/a.${ext}`]};
      await completeArtifactRun(async()=>{turn++;await writeFile(join(cwd,`outputs/a.${ext}`),bytes);return [{text:'done'}];},cwd,new Map(),{
        prepareResult:events=>({events,manifest}), validateFiles:async()=>{if(turn===1)throw Error('repair');},onActivity:e=>activity.push(e)});
      const generated=activity.filter(e=>e.type===generatedOperation('a.'+ext));
      assert.equal(generated.length,1);assert.equal(generated[0].attempt,2);assert.equal(generated[0].state,'completed');
    }
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('tracing disabled executes once and closes UI activity on cancellation',async()=>{
  const c=new AbortController();let count=0;const events=[];
  const r={cliOptions:{provider:'codex'},signal:c.signal,onBridgeActivity:e=>events.push(e)};
  await assert.rejects(traceBridgeRequest(r,async()=>{count++;r.onBridgeActivity({provider:'codex',type:'web_search',id:'a',state:'started'});c.abort();throw Error('cancel');}));
  assert.equal(count,1);assert.equal(events.at(-1).state,'cancelled');
});
