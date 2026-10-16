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
