import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
test('real Langfuse SDK exports hierarchy, distinct traces, sessions, cancellation and no document payload',async()=>{
  const batches=[];
  const collector=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    let body=Buffer.concat(chunks);if(req.headers['content-encoding']==='gzip')body=gunzipSync(body);
    try{batches.push(JSON.parse(body.toString()));}catch{batches.push({unparsed:body.toString('hex').slice(0,100)});}
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');
  });
  await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
  const script=`
    const {traceBridgeRequest,shutdownTracing}=await import('./src/langfuse-tracing.mjs');
    const ctx={telemetrySessionKey:'a'.repeat(64),telemetryUserKey:'b'.repeat(64)};
    for(let i=0;i<3;i++) {
      const controller=new AbortController();
      const r={context:ctx,model:'gpt-codex',cliOptions:{provider:'codex'},signal:controller.signal,executionId:'run-'+i,
        attachments:[{filename:'private.docx',data:'UEsDBSECRET_DOCX'}]};
      try {await traceBridgeRequest(r,async()=>{
        r.onBridgeActivity({provider:'codex',type:'command_execution',id:'cmd',item:{command:'python test.py',aggregated_output:'SECRET_OUTPUT'},state:'started'});
        if(i===2){controller.abort();throw Error('SECRET_ERROR');}
        r.onBridgeActivity({provider:'codex',type:'command_execution',id:'cmd',item:{command:'python test.py'},state:'completed',exitCode:0});
        return {text:'SECRET_DOCUMENT',files:[],usage:{prompt_tokens:2,completion_tokens:3}};
      });}catch{};
    }
    await shutdownTracing();
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{
    cwd:new URL('..',import.meta.url),env:{...process.env,LANGFUSE_BASE_URL:`http://127.0.0.1:${collector.address().port}`,
      LANGFUSE_PUBLIC_KEY:'pk-lf-test',LANGFUSE_SECRET_KEY:'sk-lf-test',OTEL_TRACES_SAMPLER:'always_on',LANGFUSE_LOG_LEVEL:'ERROR',LANGFUSE_TRACING_ENABLED:'true',OTEL_BSP_SCHEDULE_DELAY:'50'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stdout.on('data',c=>stderr+=c);child.stderr.on('data',c=>stderr+=c);
  const code=await new Promise(resolve=>child.on('close',resolve));
  await new Promise(resolve=>collector.close(resolve));
  assert.equal(code,0,stderr);
  const spans=batches.flatMap(b=>b.resourceSpans ?? []).flatMap(r=>r.scopeSpans ?? []).flatMap(s=>s.spans ?? []);
  assert.ok(spans.length>=9,JSON.stringify(batches)+' '+stderr);
  const roots=spans.filter(s=>s.name==='bridge.request');assert.equal(roots.length,3);
  assert.equal(new Set(roots.map(s=>s.traceId)).size,3);
  const attribute=(span,key)=>span.attributes.find(a=>a.key===key)?.value?.stringValue;
  for(const s of spans)assert.equal(attribute(s,'session.id'),'a'.repeat(64));
  const rootMeta=roots[0].attributes.filter(a=>a.key.includes('metadata'));
  assert.match(JSON.stringify(rootMeta),/codex/,JSON.stringify(rootMeta));
  assert.ok(spans.filter(s=>s.name==='code.execute.python').some(s=>s.attributes.some(a=>a.key.includes('metadata') && JSON.stringify(a).includes('completed'))));
  for(const s of spans.filter(s=>s.name==='code.execute.python')){
    const parent=spans.find(p=>p.spanId===s.parentSpanId);assert.equal(parent?.name,'model.codex');
  }
  assert.doesNotMatch(JSON.stringify(batches),/SECRET_|UEsDB/);
  assert.ok(spans.some(s=>JSON.stringify(s.attributes).includes('cancelled')));
});
