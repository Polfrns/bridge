import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnswerStream } from '../src/answer-stream.mjs';
import { createBridge, BRIDGE_OUTPUT_PREFIX } from '../src/server.mjs';
import { runClaude } from '../src/claude-workspace.mjs';
import { runCodex } from '../src/providers.mjs';
import { signedHeaders } from './helpers/identity.mjs';

const key='answer-stream-key-'.repeat(4);
const manifest={task:'answer',status:'text',files:[]};
const envelope=(text,artifact=manifest,response={})=>({artifact,response:{...response,text}});
function barrier(){let release;const promise=new Promise(done=>{release=done;});return {promise,release};}
// Parse complete SSE frames only: HTTP reads can split a JSON payload anywhere.
const frames=text=>text.split(/\r?\n\r?\n/).slice(0,-1).flatMap(frame=>frame.split(/\r?\n/).filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))));
const prose=text=>frames(text).flatMap(e=>e.type==='response.output_text.delta'?[e.delta]:e.choices?.[0]?.delta?.content?[e.choices[0].delta.content]:[]);
const activityRecords=text=>frames(text).flatMap(e=>{
  const delta=e.type==='response.reasoning_summary_text.delta'?e.delta:e.choices?.[0]?.delta?.reasoning_content;
  return typeof delta==='string'?[...delta.matchAll(/\[\[ROKO_BRIDGE_TOOL_V1:([A-Za-z0-9_-]+)\]\]/g)].map(match=>JSON.parse(Buffer.from(match[1],'base64url').toString('utf8'))):[];
});
async function readUntil(reader,predicate,initial='') {
  let text=initial,timer;
  try {return await Promise.race([(async()=>{while(!predicate(text)){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}assert.ok(predicate(text),text);return text;})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Answer did not cross provider barrier')),1500);})]);}
  finally {clearTimeout(timer);}
}
async function drain(reader){let text='';for(;;){const chunk=await reader.read();if(chunk.done)return text;text+=new TextDecoder().decode(chunk.value);}}

test('answer framing decodes fragmented escapes and surrogate pairs without exposing JSON',()=>{
  const original='Line\n"quoted" \\ slash 😀 \u001eLIBRECHAT_OUTPUT_V1\u001e';
  const raw=JSON.stringify(envelope(original)).replace('😀','\\ud83d\\ude00');const chunks=[];
  const stream=createAnswerStream({stream:true,onAnswerText:x=>chunks.push(x)},new AbortController().signal);
  for(let i=0;i<raw.length;i++)stream.delta('answer',raw[i]);
  const expected=original.replaceAll('\u001e','\\u001e');
  assert.equal(chunks.join(''),expected);assert.equal(stream.emitted,expected);stream.check(envelope(original));
  assert.ok(!chunks.some(x=>/[\uD800-\uDBFF]$/.test(x)),'a high surrogate is never flushed on its own');
  assert.doesNotMatch(chunks.join(''),/"artifact"|"response"|"text":/);
});

test('only answer/text envelopes stream; file metadata and tool arguments stay private',()=>{
  for(const value of [envelope('Unvalidated file',{task:'create',status:'files',files:['outputs/a.txt']}),envelope('Unsupported',{task:'edit',status:'unsupported',files:[]}),envelope('code',{task:'code',status:'files',files:['outputs/a.js']})]) {
    const chunks=[];const stream=createAnswerStream({stream:true,onAnswerText:x=>chunks.push(x)},new AbortController().signal);
    stream.snapshot('answer',JSON.stringify(value));assert.deepEqual(chunks,[]);
  }
  for(const [action,choice] of [['tool_call','auto'],['message','required']]) {
    const chunks=[];const stream=createAnswerStream({stream:true,toolRelay:true,toolChoice:choice,onAnswerText:x=>chunks.push(x)},new AbortController().signal);
    stream.snapshot('answer',JSON.stringify(envelope('not executable',manifest,{action,name:'lookup',arguments_json:'{"private":"hidden"}'})));
    assert.deepEqual(chunks,[]);
  }
});

test('snapshots deduplicate and replacement after publication is rejected',()=>{
  const chunks=[];const stream=createAnswerStream({stream:true,onAnswerText:x=>chunks.push(x)},new AbortController().signal);
  const raw=JSON.stringify(envelope('Hello world'));const cut=raw.indexOf('world');
  stream.snapshot('answer',raw.slice(0,cut));stream.snapshot('answer',raw.slice(0,cut));stream.snapshot('answer',raw);
  assert.deepEqual(chunks,['Hello ','world']);
  assert.throws(()=>stream.snapshot('answer',JSON.stringify(envelope('different'))),/replaced/);
  assert.throws(()=>stream.check(envelope('different')),/differs/);
});

test('nonstream, unsupported property order and aborted streams use no live prose',()=>{
  const controller=new AbortController();
  for(const request of [{stream:false},{stream:true}]) {
    const chunks=[];const stream=createAnswerStream({...request,onAnswerText:x=>chunks.push(x)},controller.signal);
    stream.snapshot('answer',JSON.stringify({response:{text:'Buffered fallback'},artifact:manifest}));assert.deepEqual(chunks,[]);
  }
  controller.abort();const stream=createAnswerStream({stream:true,onAnswerText:()=>assert.fail()},controller.signal);
  stream.snapshot('answer',JSON.stringify(envelope('No late output')));
});

test('oversized framing takes the buffered path even in a complete snapshot',()=>{
  const stream=createAnswerStream({stream:true,onAnswerText:()=>assert.fail('oversized prefix was streamed')},new AbortController().signal);
  stream.snapshot('answer',' '.repeat(64*1024)+JSON.stringify(envelope('Buffered fallback')));
  assert.equal(stream.emitted,'');
});

async function fixture(t,provider,{mode='answer',relay=false,structuredTool=false,activityFirst=false,timeoutMs=5000}={}) {
  const cwd=await mkdtemp(join(tmpdir(),'live-answer-'));const gate=barrier(),validation=barrier();
  let turns=0,validationCalls=0,activeRequest,activeSignal;
  t.after(()=>gate.release());t.after(()=>validation.release());
  const fileMode=mode==='files';
  if(!fileMode)validation.release();
  async function* rawParts(){
    const turn=++turns;
    const text=fileMode?(turn===1?'UNVALIDATED_SUCCESS':'Validated deliverable'):'Hello world';
    const artifact=fileMode?{task:'create',status:'files',files:['outputs/result.txt']}:manifest;
    const response=relay?{action:mode==='tool'?'tool_call':'message',text,name:mode==='tool'?'lookup':'',arguments_json:'{}'}:{text};
    const result={artifact,response};
    const raw=JSON.stringify(result);
    const cut=raw.indexOf(text)+Math.min(6,text.length);
    if(activityFirst)activeRequest.onBridgeActivity?.({provider:'bridge',type:'workspace.list',id:'op',state:'started'});
    yield {delta:raw.slice(0,cut),raw:raw.slice(0,cut)};
    await gate.promise;
    if(mode==='failure')throw Error('provider failed after text');
    if(mode==='replacement') {yield {delta:'',raw:JSON.stringify(envelope('Changed answer'))};return;}
    const finalRaw=mode==='malformed'?raw.slice(0,-1):raw;
    yield {delta:finalRaw.slice(cut),raw:finalRaw};
    activeRequest.onBridgeActivity?.({provider:'bridge',type:'workspace.list',id:'op',state:activityFirst?'completed':'started'});
    if(!activityFirst)activeRequest.onBridgeActivity?.({provider:'bridge',type:'workspace.list',id:'op',state:'completed'});
    if(fileMode && turn===2)await writeFile(join(cwd,'outputs/result.txt'),'verified bytes');
    yield {result,raw:finalRaw};
  }
  const sdk=provider==='claude'?{
    tool:()=>({}),createSdkMcpServer:x=>x,
    query({options}) {
      assert.equal(options.includePartialMessages,activeRequest.stream===true);
      const stream=(async function*(){
        yield {type:'stream_event',parent_tool_use_id:'child',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:JSON.stringify(envelope('PRIVATE_SUBAGENT'))}}};
        yield {type:'stream_event',parent_tool_use_id:null,event:{type:'message_start',message:{id:'sdk-answer'}}};
        yield {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking'}}};
        yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'PRIVATE_THINKING'}}};
        yield {type:'stream_event',event:{type:'content_block_start',index:1,content_block:structuredTool?{type:'tool_use',name:'StructuredOutput'}:{type:'text',text:''}}};
        for await(const part of rawParts()) {
          if(part.result) {
            if(!structuredTool)yield {type:'assistant',message:{id:'sdk-answer',content:[{type:'text',text:part.raw}]}};
            yield {type:'result',subtype:'success',...(mode==='malformed'?{result:part.raw}:{structured_output:part.result}),session_id:'private'};
          }else yield {type:'stream_event',event:{type:'content_block_delta',index:1,delta:structuredTool?{type:'input_json_delta',partial_json:part.delta}:{type:'text_delta',text:part.delta}}};
        }
      })();stream.close=()=>{};return stream;
    },
  }:{Codex:class {startThread(){return {runStreamed:async()=>({events:(async function*(){for await(const part of rawParts()) {
    if(part.result){yield {type:'item.completed',item:{id:'sdk-answer',type:'agent_message',text:part.raw}};yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};}
    else yield {type:'item.updated',item:{id:'sdk-answer',type:'agent_message',text:part.raw}};
  }})()})};}}};
  const server=createBridge({key,timeoutMs,provider:async function*(request,signal){
    activeRequest=request;activeSignal=signal;
    yield* (provider==='claude'?runClaude:runCodex)(request,signal,cwd,new Map(),{HOME:cwd},{sdk,executor:{queue:Promise.resolve()},validateFiles:()=>{validationCalls++;return validation.promise;}});
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const blocked=new Set([2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
  while(server.address().port<1024 || blocked.has(server.address().port)) {
    await new Promise(resolve=>server.close(resolve));server.listen(0,'127.0.0.1');await once(server,'listening');
  }
  t.after(()=>{server.abortProviders();server.close();server.closeAllConnections();});
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const model=provider==='claude'?'claude-max':'gpt-codex';
  const post=(api,stream=true)=>fetch(`http://127.0.0.1:${server.address().port}/v1/${api==='chat'?'chat/completions':'responses'}`,{method:'POST',headers:signedHeaders(key,model),body:JSON.stringify({model,stream,...(relay?{tools:api==='chat'?[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}]:[{type:'function',name:'lookup',parameters:{type:'object',properties:{}}}]}:{}),...(api==='chat'?{messages:[{role:'user',content:'Hello'}]}:{input:'Hello'})})});
  return {post,gate,validation,get turns(){return turns;},get validationCalls(){return validationCalls;},get signal(){return activeSignal;}};
}

for(const provider of ['claude','codex'])for(const api of ['chat','responses']) {
  test(`${provider} ${api}: answer arrives before provider completion without replay or JSON`,async t=>{
    const f=await fixture(t,provider,{relay:true,activityFirst:provider==='claude'});
    const reader=(await f.post(api)).body.getReader();let text=await readUntil(reader,x=>prose(x).join('').includes('Hello '));
    assert.equal(prose(text).join(''),'Hello ');assert.doesNotMatch(text,/"finish_reason":"stop"|response.completed/);
    f.gate.release();text+=await drain(reader);assert.deepEqual(prose(text),['Hello ','world']);
    assert.doesNotMatch(text,/PRIVATE_|\[object Object\]/);
    assert.doesNotMatch(prose(text).join(''),/"artifact"|arguments_json/);
    if(api==='responses') {
      const events=frames(text);assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i+1));
      const final=events.find(e=>e.type==='response.completed').response;
      assert.equal(final.output.find(e=>e.type==='message').content[0].text,'Hello world');
      assert.equal(events.filter(e=>e.type==='response.output_text.done').length,1);
      assert.deepEqual(final.output.map(e=>e.type),provider==='claude'?['reasoning','message']:['message','reasoning']);
    }
  });
  test(`${provider} ${api}: failure after visible text terminates as an error`,async t=>{
    const f=await fixture(t,provider,{mode:'failure'});const reader=(await f.post(api)).body.getReader();let text=await readUntil(reader,x=>prose(x).length>0);
    f.gate.release();text+=await drain(reader);assert.equal(prose(text).join(''),'Hello ');assert.equal(f.turns,1);
    assert.match(text,/provider_error/);assert.doesNotMatch(text,/response.completed|"finish_reason":"stop"/);
    if(api==='responses'){const final=frames(text).find(e=>e.type==='response.failed');assert.equal(final.response.output[0].status,'incomplete');}
  });
  test(`${provider} ${api}: repaired file delivery is held until validation`,async t=>{
    const f=await fixture(t,provider,{mode:'files',activityFirst:true});const reader=(await f.post(api)).body.getReader();let text=await readUntil(reader,x=>x.includes('ROKO_BRIDGE_TOOL_V1'));
    assert.deepEqual(prose(text),[]);f.gate.release();
    text=await readUntil(reader,x=>activityRecords(x).some(e=>e.v===1 && e.provider==='bridge' && e.operation==='workspace.validate' && e.state==='started' && e.attempt===2),text);
    assert.equal(f.turns,2);assert.equal(f.validationCalls,1);
    assert.deepEqual(prose(text),[]);assert.doesNotMatch(text,/UNVALIDATED_SUCCESS|verified bytes/);
    f.validation.release();text+=await drain(reader);assert.equal(f.turns,2);
    const output=prose(text);assert.equal(output.length,1);assert.ok(output[0].startsWith(BRIDGE_OUTPUT_PREFIX));
    assert.equal(JSON.parse(output[0].slice(BRIDGE_OUTPUT_PREFIX.length)).text,'Validated deliverable');
    const validationStates=activityRecords(text).filter(e=>e.operation==='workspace.validate');
    assert.deepEqual(validationStates.map(e=>e.state),['started','completed']);
    assert.equal(validationStates[0].id,validationStates[1].id);
    assert.doesNotMatch(text,/UNVALIDATED_SUCCESS/);
  });
  test(`${provider} ${api}: nonstream response remains atomic`,async t=>{
    const f=await fixture(t,provider);f.gate.release();const result=await (await f.post(api,false)).json();
    assert.equal(api==='chat'?result.choices[0].message.content:result.output.find(e=>e.type==='message').content[0].text,'Hello world');
  });
  test(`${provider} ${api}: function decision is validated before tool-call delivery`,async t=>{
    const f=await fixture(t,provider,{mode:'tool',relay:true,activityFirst:true});const reader=(await f.post(api)).body.getReader();let text=await readUntil(reader,x=>x.includes('ROKO_BRIDGE_TOOL_V1'));
    assert.deepEqual(prose(text),[]);assert.doesNotMatch(text,/"tool_calls"|response.function_call_arguments/);
    f.gate.release();text+=await drain(reader);assert.deepEqual(prose(text),[]);
    assert.match(text,api==='chat'?/"tool_calls"/:/response.function_call_arguments.delta/);
  });
}

test('Claude StructuredOutput JSON deltas expose only the answer field',async t=>{
  const f=await fixture(t,'claude',{structuredTool:true});const reader=(await f.post('responses')).body.getReader();let text=await readUntil(reader,x=>prose(x).length>0);
  assert.equal(prose(text).join(''),'Hello ');f.gate.release();text+=await drain(reader);assert.equal(prose(text).join(''),'Hello world');
});

test('Codex snapshot replacement cannot silently rewrite visible prose',async t=>{
  const f=await fixture(t,'codex',{mode:'replacement'});const reader=(await f.post('chat')).body.getReader();let text=await readUntil(reader,x=>prose(x).length>0);
  f.gate.release();text+=await drain(reader);assert.match(text,/replaced/);assert.doesNotMatch(text,/Changed answer|"finish_reason":"stop"/);assert.equal(f.turns,1);
});

for(const provider of ['claude','codex'])test(`${provider}: disconnect cancels a partially streamed answer`,async t=>{
  const f=await fixture(t,provider);const reader=(await f.post('responses')).body.getReader();await readUntil(reader,x=>prose(x).length>0);
  const aborted=new Promise(resolve=>f.signal.addEventListener('abort',resolve,{once:true}));await reader.cancel();await aborted;assert.equal(f.signal.aborted,true);f.gate.release();
});

for(const provider of ['claude','codex']) {
  test(`${provider}: malformed final output cannot repair text already published`,async t=>{
    const f=await fixture(t,provider,{mode:'malformed'});const reader=(await f.post('responses')).body.getReader();let text=await readUntil(reader,x=>prose(x).length>0);
    f.gate.release();text+=await drain(reader);assert.equal(f.turns,1);assert.match(text,/response.failed/);assert.doesNotMatch(text,/response.completed/);
  });
  test(`${provider}: timeout terminates partial output without a success event`,async t=>{
    const f=await fixture(t,provider,{timeoutMs:120});const reader=(await f.post('responses')).body.getReader();let text=await readUntil(reader,x=>prose(x).length>0);
    await new Promise(resolve=>{if(f.signal.aborted)resolve();else f.signal.addEventListener('abort',resolve,{once:true});});
    f.gate.release();text+=await drain(reader);assert.equal(f.turns,1);assert.equal(prose(text).join(''),'Hello ');assert.match(text,/response.failed/);assert.doesNotMatch(text,/response.completed/);
  });
}
