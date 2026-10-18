import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBridge } from '../src/server.mjs';
import { resolveCliOptions, codexResponseConfig, codexThreadOptions } from '../src/cli-options.mjs';
import { readCodexEvents } from '../src/codex-events.mjs';
import { signedHeaders } from './helpers/identity.mjs';

const key = 'parameters-http-key-'.repeat(4);
for (const api of ['chat','responses']) for (const stream of [false,true]) test(`${api} ${stream ? 'stream' : 'JSON'} forwards UI values and public summaries`,async t=>{
  let observed;
  const server = createBridge({key,provider:async function*(request){
    observed=request;
    yield {reasoning:'Public summary supplied by SDK'};
    yield {text:request.toolRelay ? JSON.stringify({action:'tool_call',text:'',name:'lookup',arguments_json:'{}'}) : 'Answer'};
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.close();server.closeAllConnections();});
  const post= async (options,extra={})=>{
    const body={model:'gpt-codex-deep',stream,...(api==='chat'?{messages:[{role:'user',content:'Weather?'}]}:{input:'Weather?'}),...extra};
    return fetch(`http://127.0.0.1:${server.address().port}/v1/${api==='chat'?'chat/completions':'responses'}`,{method:'POST',headers:signedHeaders(key,body.model,{options}),body:JSON.stringify(body)});
  };
  for(const web_search of [true,false]) for(const summary of ['detailed','none']){
    const options={reasoning_effort:'minimal',verbosity:'high',reasoning_summary:summary,web_search};
    const res=await post(options);assert.equal(res.status,200);
    const text=await res.text();
    assert.equal(observed.webSearch,web_search);
    assert.deepEqual(codexResponseConfig(observed.cliOptions),{model_verbosity:'high',model_reasoning_summary:summary});
    assert.equal(codexThreadOptions(observed,'/tmp').webSearchMode,web_search?'live':'disabled');
    assert.equal(codexThreadOptions(observed,'/tmp').modelReasoningEffort,'minimal');
    assert.equal(text.includes('Public summary supplied by SDK'),summary!=='none');
    if(api==='responses'){
      if(stream){
        assert.equal(text.includes('response.reasoning_summary_text.delta'),summary!=='none');
        const events=text.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
        assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i+1));
        const answerEvent=events.find(e=>e.type==='response.output_text.delta');
        assert.equal(answerEvent.output_index,summary==='none'?0:1);
      }else{const parsed=JSON.parse(text);assert.equal(parsed.output.at(-1).content[0].text,'Answer');}
    }
  }
  // Reasoning occupies index zero; function calls must still use the next index.
  const tools=api==='chat'?[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}]:[{type:'function',name:'lookup',parameters:{type:'object',properties:{}}}];
  const toolRes=await post({reasoning_summary:'detailed'},{tools});assert.equal(toolRes.status,200);
  const payload=await toolRes.text();
  if(api==='responses' && stream){const events=payload.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));assert.equal(events.find(e=>e.type==='response.function_call_arguments.delta').output_index,1);}
  else if(api==='responses') assert.equal(JSON.parse(payload).output[1].name,'lookup');
});

test('CLI validators reject unavailable generation controls and unsafe configuration',()=>{
  for(const body of [{temperature:0.4},{top_p:0.2},{max_output_tokens:10},{max_tokens:10},{stop:['END']},{frequency_penalty:1},{seed:3},{cli_options:{web_search:'true'}},{cli_options:{sandbox_mode:'danger-full-access'}}]) assert.throws(()=>resolveCliOptions('gpt-codex',body,{},{}));
  assert.doesNotThrow(()=>resolveCliOptions('gpt-codex',{temperature:1,top_p:1,frequency_penalty:0,presence_penalty:0}, {},{}));
  assert.throws(()=>resolveCliOptions('claude-max',{web_search:true},{},{}),/only enabled on Codex/);
  assert.equal(resolveCliOptions('gpt-codex',{cli_options:{web_search:false}},{web_search:true},{}).web_search,false);
});

test('Codex completed SDK summaries are separate from final text and never duplicated',async()=>{
  const input=[{type:'item.updated',item:{id:'r',type:'reasoning',text:'Part'}},{type:'item.completed',item:{id:'r',type:'reasoning',text:'Public summary'}},{type:'item.completed',item:{id:'a',type:'agent_message',text:'Final'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}];
  const collect=async includeReasoning=>{const result=[];for await(const e of readCodexEvents(input,{toolRelay:true,includeReasoning}))result.push(e);return result;};
  const on=await collect(true);assert.deepEqual(on.filter(e=>e.reasoning),[{reasoning:'Public summary'}]);assert.equal(on.find(e=>e.text).text,'Final');
  assert.equal((await collect(false)).some(e=>e.reasoning),false);
});
