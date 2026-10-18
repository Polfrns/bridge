import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

for (const provider of ['bridge','roko']) {
  test(`real Langfuse SDK exports numeric accounting for ${provider}`, {timeout:30000}, async()=>{
    const batches=[];
    const collector=createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      let body=Buffer.concat(chunks);
      if(req.headers['content-encoding']==='gzip')body=gunzipSync(body);
      batches.push(JSON.parse(body));
      res.writeHead(200,{'content-type':'application/json'});res.end('{}');
    });
    await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
    try {
      const script=`
        import {NodeSDK} from '@opentelemetry/sdk-node';
        import {LangfuseSpanProcessor} from '@langfuse/otel';
        import * as tracing from '@langfuse/tracing';
        import privacy from './src/privacy.cjs';
        const sdk=new NodeSDK({spanProcessors:[privacy.protectProcessor(new LangfuseSpanProcessor({
          mask:({data})=>privacy.maskData(data),mediaUploadEnabled:false
        }),{provider:process.env.TEST_ACCOUNTING_PROVIDER})]});
        sdk.start();
        await tracing.startActiveObservation('model.codex',async span=>{
          span.update({model:'gpt-codex',usageDetails:{input:123,output:45,total:168},
            costDetails:{input:0.001,output:0.002,total:0.003},
            input:{Authorization:'PRIVATE_SECRET',data:'UEsDBPRIVATE_DOCX'}});
        },{asType:'generation'});
        await sdk.shutdown();
      `;
      const child=spawn(process.execPath,['--input-type=module','-e',script],{
        cwd:fileURLToPath(new URL('../',import.meta.url)),
        env:{...process.env,LANGFUSE_TRACING_ENABLED:'true',LANGFUSE_BASE_URL:`http://127.0.0.1:${collector.address().port}`,
          LANGFUSE_PUBLIC_KEY:'pk-local-test',LANGFUSE_SECRET_KEY:'sk-local-test',OBSERVABILITY_CONTENT_MODE:'redacted',
          TEST_ACCOUNTING_PROVIDER:provider,OTEL_TRACES_SAMPLER:'always_on'},stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
      const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}).finally(()=>clearTimeout(timer));
      assert.equal(code,0,output);
      const spans=batches.flatMap(b=>b.resourceSpans??[]).flatMap(r=>r.scopeSpans??[]).flatMap(s=>s.spans??[]);
      assert.equal(spans.length,1,JSON.stringify(batches));
      const attr=key=>spans[0].attributes.find(a=>a.key===key)?.value.stringValue;
      assert.deepEqual(JSON.parse(attr('langfuse.observation.usage_details')),provider==='bridge'?{input:123,output:45,total:168}:{input:0,output:0,total:0});
      assert.deepEqual(JSON.parse(attr('langfuse.observation.cost_details')),provider==='bridge'?{input:0.001,output:0.002,total:0.003}:{input:0,output:0,total:0});
      assert.doesNotMatch(JSON.stringify(batches),/PRIVATE_|UEsDB/);
    } finally {await new Promise(resolve=>collector.close(resolve));}
  });
}
