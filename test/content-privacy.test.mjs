import test from 'node:test';
import assert from 'node:assert/strict';
import privacy from '../src/privacy.cjs';
for (const mode of ['redacted','debug','invalid']) {
  test(`content mode ${mode}: documents, secrets, commands and bytes never export`,()=>{
    process.env.OBSERVABILITY_CONTENT_MODE=mode;
    const source={messages:[{role:'user',content:'VISIBLE_QUESTION API_KEY="PRIVATE_KEY" password=PRIVATE_PASSWORD secret=PRIVATE_SECRET Bearer PRIVATE_AUTH'},
      {type:'file',source_type:'base64',mime_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',data:'UEsDBPRIVATE_DOCX'},
      {type:'file',mime_type:'application/pdf',data:'JVBERi0PRIVATE_PDF'}],
      code:'print("VISIBLE_CODE")\nTOKEN="PRIVATE_TOKEN"',Authorization:'PRIVATE_AUTH',command:'echo PRIVATE_COMMAND',
      CLAUDE_BRIDGE_KEY:'PRIVATE_BRIDGE_KEY',AWS_ACCESS_KEY_ID:'PRIVATE_AWS_KEY',
      connection:'postgres://PRIVATE_USER:PRIVATE_PASS@db/test',
      env:{DB_PASSWORD:'PRIVATE_DB'},binary:Buffer.from('PRIVATE_BINARY')};
    const before=JSON.stringify(source);
    const span={name:'model.codex',attributes:{'langfuse.observation.input':JSON.stringify(source),'langfuse.observation.output':'VISIBLE_ANSWER'},events:[],status:{code:0}};
    const safe=privacy.sanitizeSpan(span);const exported=JSON.stringify(safe);
    assert.doesNotMatch(exported,/PRIVATE_|UEsDB|JVBERi0/);assert.equal(JSON.stringify(source),before);
    if(mode==='debug'){assert.match(exported,/VISIBLE_QUESTION|VISIBLE_CODE/);assert.match(exported,/VISIBLE_ANSWER/);}
    else assert.doesNotMatch(exported,/VISIBLE_/);
    delete process.env.OBSERVABILITY_CONTENT_MODE;
  });
}
test('debug output has a total text budget, cycles and huge fields fail closed',()=>{
  process.env.OBSERVABILITY_CONTENT_MODE='debug';process.env.OBSERVABILITY_CONTENT_MAX_CHARS='256';
  const input={text:'a '.repeat(5000),password:'PRIVATE_PASSWORD'};input.self=input;
  const result=JSON.stringify(privacy.sanitizeContent(input));assert.ok(result.length<600);assert.doesNotMatch(result,/PRIVATE_PASSWORD/);
  assert.equal(privacy.sanitizeContent('a'.repeat(1000001)),'[oversized content]');
  delete process.env.OBSERVABILITY_CONTENT_MODE;delete process.env.OBSERVABILITY_CONTENT_MAX_CHARS;
});

// Regression: measurements survive the privacy boundary without opening content.
for (const mode of ['redacted','debug']) {
  test(`numeric usage/cost JSON survives export in ${mode}`,()=>{
    process.env.OBSERVABILITY_CONTENT_MODE=mode;
    const usage={input:123,output:45,total:168};
    const cost={input:0.001,output:0.002,total:0.003};
    const attributes={'langfuse.observation.usage_details':JSON.stringify(usage),
      'langfuse.observation.cost_details':JSON.stringify(cost),
      'langfuse.observation.input':JSON.stringify({Authorization:'Bearer PRIVATE_USAGE_SECRET',data:'UEsDBPRIVATE_DOCX'})};
    const before=JSON.stringify(attributes);
    const safe=privacy.sanitizeAttributes(attributes);
    assert.deepEqual(JSON.parse(safe['langfuse.observation.usage_details']),usage);
    assert.deepEqual(JSON.parse(safe['langfuse.observation.cost_details']),cost);
    assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_|UEsDB/);
    assert.equal(JSON.stringify(attributes),before);
    delete process.env.OBSERVABILITY_CONTENT_MODE;
  });
}
test('metering rejects strings, nesting, secret fields and invalid numbers',()=>{
  const key='langfuse.observation.usage_details';
  const source={input:0,output:2,cache_read_input_tokens:4,password:123,Authorization:'PRIVATE_SECRET',
    total:'6',cached_tokens:-1,reasoning_tokens:Infinity,input_tokens:NaN,output_tokens:{data:'PRIVATE_DOC'}};
  assert.deepEqual(JSON.parse(privacy.sanitizeAttributes({[key]:source})[key]),{input:0,output:2,cache_read_input_tokens:4});
  for (const bad of ['{bad','[]','null','1','"PRIVATE_SECRET"','x'.repeat(16385),{input:-1},{input:'12'},{input:Infinity}]) {
    assert.equal(privacy.sanitizeAttributes({[key]:bad})[key],undefined);
  }
});
test('Roko Bridge replicas have zero accounting; direct models and Bridge keep usage',()=>{
  const usageKey='langfuse.observation.usage_details', costKey='langfuse.observation.cost_details';
  const usage=JSON.stringify({input:123,output:45,total:168}),cost=JSON.stringify({total:0.003});
  for (const model of ['gpt-codex','gpt-codex-fast','gpt-codex-deep','claude-max','claude-max-fast','claude-max-deep','direct-model']) {
    for (const provider of ['roko','bridge']) {
      let exported;
      const span={name:'model.other',attributes:{'langfuse.observation.type':'generation',
        'langfuse.observation.model.name':model,[usageKey]:usage,[costKey]:cost,'gen_ai.usage.input_tokens':123},events:[],status:{code:0}};
      privacy.protectProcessor({onEnd:s=>exported=s},{provider}).onEnd(span);
      const replica=provider==='roko' && model!=='direct-model';
      assert.deepEqual(JSON.parse(exported.attributes[usageKey]),replica?{input:0,output:0,total:0}:JSON.parse(usage));
      assert.deepEqual(JSON.parse(exported.attributes[costKey]),replica?{input:0,output:0,total:0}:JSON.parse(cost));
      assert.equal(exported.attributes['langfuse.observation.metadata.usageAccounting'],replica?'bridge_replica':undefined);
      if(replica)assert.equal(exported.attributes['gen_ai.usage.input_tokens'],undefined);
      assert.equal(span.attributes[usageKey],usage);
    }
  }
});
