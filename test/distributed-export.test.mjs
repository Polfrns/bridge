import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

for (const mode of ['redacted','debug']) {
  test(`Bridge authenticates HTTP parent and exports safe ${mode} text`,async()=>{
    const batches=[];
    const collector=createServer(async(req,res)=>{
      const chunks=[];for await(const c of req)chunks.push(c);
      let body=Buffer.concat(chunks);if(req.headers['content-encoding']==='gzip')body=gunzipSync(body);
      batches.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');
    });
    await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
    const script=`
      const {createServer}=await import('node:http');
      const {verifyContext}=await import('./src/request-context.mjs');
      const {traceBridgeRequest,shutdownTracing}=await import('./src/langfuse-tracing.mjs');
      const server=createServer(async(req,res)=>{
        try {
          const request={context:verifyContext(req.headers,'gpt-codex',process.env.BRIDGE_API_KEY),
            cliOptions:{provider:'codex'},model:'gpt-codex',prompt:'VISIBLE_QUESTION password=PRIVATE_PASSWORD',signal:new AbortController().signal};
          let calls=0;
          await traceBridgeRequest(request,async()=>{
            calls++;request.onBridgeActivity({id:'http-tool',provider:'codex',operation:'workspace.read',state:'started'});
            request.onBridgeActivity({id:'http-tool',provider:'codex',operation:'workspace.read',state:'completed'});
            return {text:'VISIBLE_ANSWER Bearer PRIVATE_AUTH'};
          });
          if(calls!==1)throw Error('executed twice');res.end('ok');
        }catch(error){res.statusCode=500;res.end(error.message);}
      });
      server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
      process.stdin.resume();process.stdin.on('data',async()=>{await new Promise(r=>server.close(r));await shutdownTracing();process.exit(0)});
    `;
    const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,
      LANGFUSE_TRACING_ENABLED:'true',LANGFUSE_BASE_URL:`http://127.0.0.1:${collector.address().port}`,LANGFUSE_PUBLIC_KEY:'pk-test',LANGFUSE_SECRET_KEY:'sk-test',
      BRIDGE_API_KEY:'k'.repeat(32),OBSERVABILITY_TRACE_SECRET:'t'.repeat(32),OBSERVABILITY_CONTENT_MODE:mode,OTEL_TRACES_SAMPLER:'always_on'},stdio:['pipe','pipe','pipe']});
    let errors='';child.stderr.on('data',c=>errors+=c);
    const port=await new Promise((resolve,reject)=>{child.stdout.once('data',c=>resolve(Number(c.toString().trim())));child.once('error',reject);});
    const sign=(data,key)=>{const raw=Buffer.from(JSON.stringify(data)).toString('base64url');return [raw,createHmac('sha256',key).update(raw).digest('hex')];};
    const identity={userId:'user-http',tenantId:'',conversationId:'conversation-http',model:'gpt-codex',options:{},timestamp:Date.now()};
    const hash=parts=>createHmac('sha256','k'.repeat(32)).update(JSON.stringify(parts)).digest('hex');
    const traceparent='00-'+'1'.repeat(32)+'-'+'2'.repeat(16)+'-01';
    const [ctx,sig]=sign(identity,'k'.repeat(32));
    const [tc,ts]=sign({timestamp:Date.now(),traceparent,tracestate:'',
      userId:hash(['telemetry-user','','user-http']),sessionId:hash(['telemetry-session','','user-http','conversation-http'])},'t'.repeat(32));
    const headers={'X-Roko-Context':ctx,'X-Roko-Signature':sig,traceparent,'X-Observability-Context':tc,'X-Observability-Signature':ts};
    const signed=await fetch(`http://127.0.0.1:${port}`,{headers});assert.equal(signed.status,200,await signed.text());
    const unsigned=await fetch(`http://127.0.0.1:${port}`,{headers:{'X-Roko-Context':ctx,'X-Roko-Signature':sig,traceparent}});assert.equal(unsigned.status,200);
    child.stdin.write('stop');const exit=await new Promise(resolve=>child.on('close',resolve));await new Promise(resolve=>collector.close(resolve));assert.equal(exit,0,errors);
    const spans=batches.flatMap(b=>b.resourceSpans??[]).flatMap(r=>r.scopeSpans??[]).flatMap(s=>s.spans??[]);
    const roots=spans.filter(s=>s.name==='bridge.request');assert.equal(roots.length,2);
    for(const root of roots)assert.equal(root.attributes.find(a=>a.key==='langfuse.observation.metadata.contentMode')?.value.stringValue,mode);
    const attached=roots.find(s=>s.traceId==='1'.repeat(32));assert.ok(attached);assert.equal(attached.parentSpanId,'2'.repeat(16));
    assert.ok(roots.some(s=>s.traceId!=='1'.repeat(32)));
    for(const tool of spans.filter(s=>s.name==='workspace.read'))assert.ok(spans.some(p=>p.spanId===tool.parentSpanId&&p.name==='model.codex'));
    const output=JSON.stringify(batches);assert.doesNotMatch(output,/PRIVATE_|user-http|conversation-http/);
    if(mode==='debug'){assert.match(output,/VISIBLE_QUESTION/);assert.match(output,/VISIBLE_ANSWER/);}else assert.doesNotMatch(output,/VISIBLE_/);
  });
}
