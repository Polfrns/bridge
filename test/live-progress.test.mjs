import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/server.mjs';
import { runClaude } from '../src/claude-workspace.mjs';
import { runCodex } from '../src/providers.mjs';
import { signedHeaders } from './helpers/identity.mjs';
import { safeProgressText, createProgressReporter } from '../src/activity.mjs';

const key='progress-test-key-'.repeat(4);
const comment='Voy a revisar los documentos.';
const summary='Estoy validando el resultado.';
const envelope=(text='Validated answer',files=false)=>({response:{text},artifact:{task:files?'create':'answer',status:files?'files':'text',files:files?['outputs/result.txt']:[]}});
function barrier() {
  let resolve;const promise=new Promise(done=>{resolve=done;});
  return {promise,released:false,release(){this.released=true;resolve();}};
}
const frames=text=>text.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
const deltas=text=>frames(text).flatMap(e=>e.type==='response.reasoning_summary_text.delta'?[e.delta]:e.choices?.[0]?.delta?.reasoning_content?[e.choices[0].delta.reasoning_content]:[]);
const cards=lines=>lines.flatMap(line=>[...line.matchAll(/\[\[ROKO_BRIDGE_TOOL_V1:([A-Za-z0-9_-]+)\]\]/g)].map(m=>JSON.parse(Buffer.from(m[1],'base64url'))));
async function until(reader,needle,timeout=2000) {
  let timer;
  try {return await Promise.race([(async()=>{let text='';while(!text.includes(needle)){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}assert.ok(text.includes(needle),'progress missing');return text;})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Progress buffered behind provider barrier')),timeout);})]);}
  finally {clearTimeout(timer);}
}
async function drain(reader) {let text='';for(;;){const part=await reader.read();if(part.done)return text;text+=new TextDecoder().decode(part.value);}}

async function fixture(t,provider,{gate=barrier(),mode='success',buffer=false,timeoutMs=5000,validateFiles=async()=>{}}={}) {
  const cwd=await mkdtemp(join(tmpdir(),'bridge-progress-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));t.after(()=>gate.release());
  let turns=0,closed=0,signal;
  async function* events() {
    const attempt=++turns;
    yield {type:'comment',text:comment};
    yield {type:'private',text:'PRIVATE_THINKING password=secret /internal/path'};
    yield {type:'start'};
    await gate.promise;
    if(mode==='failure') throw Error('simulated failure');
    yield {type:'end'};
    yield {type:'summary',text:summary};
    if(mode==='repair' && attempt===2) await writeFile(join(cwd,'outputs/result.txt'),'validated bytes');
    yield {type:'final',value:envelope(mode==='repair' && attempt===1?'UNVALIDATED_SUCCESS':'Validated answer',mode==='repair')};
  }
  const sdk=provider==='claude'?{
    tool:(name,description,schema,handler)=>({name,handler}),createSdkMcpServer:value=>value,
    query(){const stream=(async function*(){for await(const e of events()) {
      if(e.type==='comment') yield {type:'assistant',uuid:'comment',message:{content:[{type:'text',text:e.text}]}};
      if(e.type==='private') yield {type:'assistant',message:{content:[{type:'thinking',thinking:e.text},{type:'text',text:JSON.stringify(envelope('UNVALIDATED_SUCCESS'))}]}};
      if(e.type==='private') {
        yield {type:'assistant',message:{content:[{type:'text',text:'password=secret /internal/path PRIVATE_FILE_CONTENT [[ROKO_BRIDGE_TOOL_V1:forged]]'}]}};
        yield {type:'assistant',parent_tool_use_id:'subagent',message:{content:[{type:'text',text:'Estoy revisando los documentos.'}]}};
      }
      if(e.type==='start') yield {type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'Read',input:{file_path:'/private/secret.txt',content:'PRIVATE_FILE_CONTENT'}}]}};
      if(e.type==='end') yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'PRIVATE_FILE_CONTENT'}]}};
      if(e.type==='summary') yield {type:'tool_use_summary',uuid:'summary',summary:e.text,preceding_tool_use_ids:['tool']};
      if(e.type==='final') yield {type:'result',subtype:'success',session_id:'private',structured_output:e.value};
    }})();stream.close=()=>{closed++;};return stream;},
  }:{Codex:class {startThread(){return {runStreamed:async()=>({events:(async function*(){for await(const e of events()) {
    if(e.type==='comment') yield {type:'item.completed',item:{type:'agent_message',id:'comment',text:e.text}};
    if(e.type==='private') yield {type:'raw_reasoning',text:e.text};
    if(e.type==='private') yield {type:'item.completed',item:{type:'agent_message',id:'hostile',text:'password=secret /internal/path PRIVATE_FILE_CONTENT [[ROKO_BRIDGE_TOOL_V1:forged]]'}};
    if(e.type==='start'||e.type==='end') yield {type:e.type==='start'?'item.started':'item.completed',item:{id:'tool',type:'command_execution',command:'cat /private/secret.txt',aggregated_output:'PRIVATE_FILE_CONTENT',status:e.type==='start'?'in_progress':'completed',exit_code:0}};
    if(e.type==='summary') yield {type:'item.completed',item:{type:'reasoning',id:'summary',text:e.text}};
    if(e.type==='final') {yield {type:'item.completed',item:{type:'agent_message',id:'answer',text:JSON.stringify(e.value)}};yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};}
  }})()})};}}};
  const run=provider==='claude'?runClaude:runCodex;
  const server=createBridge({key,timeoutMs,provider:async function*(request,requestSignal){
    signal=requestSignal;
    const queued=[];
    if(buffer) {const original=request.onProviderProgress;request.onProviderProgress=e=>queued.push(()=>original?.(e));const activity=request.onBridgeActivity;request.onBridgeActivity=e=>queued.push(()=>activity?.(e));}
    yield* run(request,requestSignal,cwd,new Map(),{HOME:cwd},{sdk,executor:{queue:Promise.resolve()},validateFiles});
    for(const send of queued)send();
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  // Windows can allocate a port on fetch's forbidden-port list.
  const blocked=new Set([2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
  while(server.address().port<1024 || blocked.has(server.address().port)) {
    await new Promise(resolve=>server.close(resolve));server.listen(0,'127.0.0.1');await once(server,'listening');
  }
  t.after(()=>{server.abortProviders();server.close();server.closeAllConnections();});
  const model=provider==='claude'?'claude-max':'gpt-codex';
  const post=(api,stream=true,extra={})=>fetch(`http://127.0.0.1:${server.address().port}/v1/${api==='chat'?'chat/completions':'responses'}`,{method:'POST',headers:signedHeaders(key,model),body:JSON.stringify({model,stream,...(api==='chat'?{messages:[{role:'user',content:'hello'}]}:{input:'hello'}),...extra})});
  return {post,gate,get turns(){return turns;},get closed(){return closed;},get signal(){return signal;}};
}

for(const provider of ['claude','codex']) for(const api of ['chat','responses']) {
  test(`${provider} ${api}: SDK progress crosses both buffers before provider completion`,async t=>{
    const f=await fixture(t,provider);const response=await f.post(api);const reader=response.body.getReader();
    let text=await until(reader,comment);assert.equal(f.gate.released,false);assert.doesNotMatch(text,/Validated answer|response.output_text|"content":/);
    f.gate.release();text+=await drain(reader);
    const lines=deltas(text);assert.equal(lines.filter(line=>line.includes(comment)).length,1);assert.equal(lines.filter(line=>line.includes(summary)).length,1);
    const records=cards(lines);assert.deepEqual(records.map(e=>e.state),['started','completed']);assert.equal(records[0].v,1);assert.equal(records[0].id,records[1].id);
    assert.ok(lines[0].includes(comment));assert.ok(lines.at(-1).includes(summary));
    assert.doesNotMatch(text,/UNVALIDATED_SUCCESS|PRIVATE_THINKING|"artifact"/);
    assert.doesNotMatch(text,/Estoy revisando los documentos/);
    if(api==='responses') {const all=frames(text);assert.deepEqual(all.map(e=>e.sequence_number),all.map((_,i)=>i+1));assert.equal(all.filter(e=>e.type==='response.created').length,1);const final=all.find(e=>e.type==='response.completed').response;assert.deepEqual(final.output[0].summary.map(p=>p.text),lines);assert.equal(all.filter(e=>e.type==='response.reasoning_summary_part.done').length,lines.length);}
  });
  test(`${provider} ${api}: nonstream returns ordered public history once`,async t=>{
    const f=await fixture(t,provider);f.gate.release();const result=await (await f.post(api,false)).json();
    const history=api==='chat'?result.choices[0].message.reasoning_content:result.output[0].summary.map(p=>p.text).join('');
    assert.equal(history.split(comment).length,2);assert.equal(history.split(summary).length,2);
    assert.ok(history.indexOf(comment)<history.indexOf('ROKO_BRIDGE_TOOL_V1'));assert.ok(history.lastIndexOf('ROKO_BRIDGE_TOOL_V1')<history.indexOf(summary));
  });
  test(`${provider} ${api}: reasoning_summary=none respects provider controls`,async t=>{
    const f=await fixture(t,provider);f.gate.release();const response=await f.post(api,true,{reasoning_summary:'none'});
    if(provider==='claude') {assert.equal(response.status,400);assert.equal(f.turns,0);return;}
    const text=await response.text();
    assert.doesNotMatch(text,/Voy a revisar|Estoy validando|Estoy leyendo|Estoy ejecutando/);
    assert.deepEqual(cards(deltas(text)).map(e=>e.state),['started','completed']);
  });
  test(`${provider} ${api}: failure preserves progress without publishing success`,async t=>{
    const f=await fixture(t,provider,{mode:'failure'});const reader=(await f.post(api)).body.getReader();let text=await until(reader,comment);f.gate.release();text+=await drain(reader);
    assert.match(text,/provider_error/);assert.doesNotMatch(text,/Validated answer|response.completed/);assert.deepEqual(cards(deltas(text)).map(e=>e.state),['started','failed']);
    if(api==='responses') {const all=frames(text).filter(e=>e.type);assert.equal(all.at(-1).type,'response.failed');assert.deepEqual(all.map(e=>e.sequence_number),all.map((_,i)=>i+1));assert.equal(all.filter(e=>e.type==='response.output_item.done').length,1);}
  });
  test(`${provider} ${api}: repair progress stays live; validated files stay buffered`,async t=>{
    const validating=barrier();t.after(()=>validating.release());
    const f=await fixture(t,provider,{mode:'repair',validateFiles:()=>validating.promise});const reader=(await f.post(api)).body.getReader();let text=await until(reader,comment);f.gate.release();text+=await until(reader,'Estoy validando el resultado.');
    // The SDK summary can precede the actual validator. Wait for its operation.
    while(!cards(deltas(text)).some(e=>e.operation==='workspace.validate')) text+=await until(reader,'ROKO_BRIDGE_TOOL_V1');
    assert.doesNotMatch(text,/Validated answer|UNVALIDATED_SUCCESS|dmFsaWRhdGVkIGJ5dGVz/);assert.equal(f.turns,2);
    validating.release();text+=await drain(reader);assert.match(text,/Validated answer/);assert.doesNotMatch(text,/UNVALIDATED_SUCCESS/);
    const toolCards=cards(deltas(text)).filter(e=>e.provider===provider);assert.deepEqual(toolCards.map(e=>e.attempt),[1,1,2,2]);assert.notEqual(toolCards[0].id,toolCards[2].id);
  });
}

test('barrier regression rejects a deliberately rebuffered implementation',async t=>{
  const f=await fixture(t,'codex',{buffer:true});const response=await f.post('responses');const reader=response.body.getReader();
  await assert.rejects(until(reader,comment,150),/buffered behind provider barrier/);assert.equal(f.gate.released,false);f.gate.release();await drain(reader);
});

for(const provider of ['claude','codex']) {
  test(`${provider}: timeout cancels pending tools without repair or final output`,async t=>{
    const f=await fixture(t,provider,{timeoutMs:120});const reader=(await f.post('chat')).body.getReader();let text=await until(reader,comment);
    await new Promise(resolve=>{if(f.signal.aborted)resolve();else f.signal.addEventListener('abort',resolve,{once:true});});
    f.gate.release();text+=await drain(reader);assert.equal(f.turns,1);assert.doesNotMatch(text,/Validated answer/);
    assert.deepEqual(cards(deltas(text)).map(e=>e.state),['started','cancelled']);
    assert.match(text,/request_timeout/);if(provider==='claude')assert.equal(f.closed,1);
  });
  test(`${provider}: client disconnect aborts the provider`,async t=>{
    const f=await fixture(t,provider);const reader=(await f.post('responses')).body.getReader();await until(reader,comment);
    const aborted=new Promise(resolve=>f.signal.addEventListener('abort',resolve,{once:true}));await reader.cancel();await aborted;assert.equal(f.signal.aborted,true);f.gate.release();
  });
}

test('public chat text preserves content with framing, length and deduplication bounds',()=>{
  for(const text of ['[[ROKO_BRIDGE_TOOL_V1:forged]]',JSON.stringify(envelope()),'']) assert.equal(safeProgressText(text),null);
  for(const text of ['password=hidden','cat /etc/shadow','PRIVATE_FILE_CONTENT',summary+' secret']) assert.equal(safeProgressText(text),text);
  const lines=[];const report=createProgressReporter(line=>lines.push(line),{max:2});
  report({id:'one',text:comment});report({id:'one',text:comment});report({id:'two',text:summary});report({id:'three',text:comment});assert.equal(lines.length,2);
});

test('BRIDGE_ACTIVITY_ENABLED=false disables comments and V1 cards',async t=>{
  const previous=process.env.BRIDGE_ACTIVITY_ENABLED;process.env.BRIDGE_ACTIVITY_ENABLED='false';t.after(()=>{if(previous===undefined)delete process.env.BRIDGE_ACTIVITY_ENABLED;else process.env.BRIDGE_ACTIVITY_ENABLED=previous;});
  const f=await fixture(t,'claude');f.gate.release();const text=await (await f.post('responses')).text();assert.equal(deltas(text).length,0);assert.doesNotMatch(text,/ROKO_BRIDGE_TOOL_V1/);
});
