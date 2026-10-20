import { chatActivity } from './chat-activity.mjs';
/** Fail-open instrumentation; the application is invoked at most once. */
import {safeActivity} from './activity.mjs';
import privacy from './privacy.cjs';
let sdk, tracing, api;
const ready = (async()=>{
  if(process.env.LANGFUSE_TRACING_ENABLED==='false' || !process.env.LANGFUSE_BASE_URL || !process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)return;
  try {
    const [{NodeSDK},{LangfuseSpanProcessor},t,a]=await Promise.all([
      import('@opentelemetry/sdk-node'),import('@langfuse/otel'),import('@langfuse/tracing'),import('@opentelemetry/api')]);
    sdk=new NodeSDK({spanProcessors:[privacy.protectProcessor(new LangfuseSpanProcessor({
      mask:({data})=>privacy.maskData(data),mediaUploadEnabled:false,
    }))]});
    sdk.start(); tracing=t; api=a;
  } catch {sdk=undefined; console.error('[bridge tracing] initialization unavailable');}
})();
export function createToolTraceLifecycle(open,{max=1000}={}) {
  const active=new Map(), finished=new Set();
  const content = value => {
    const chat = chatActivity(value);
    return {input:privacy.sanitizeContent(chat?.command ?? chat?.arguments), output:privacy.sanitizeContent(chat?.toolOutput)};
  };
  let opened=0;
  function close(item,state,extra={}) {
    try {item.span.update({level:['failed','cancelled'].includes(state)?'ERROR':'DEFAULT',metadata:{...item.event,state,
      durationMs:extra.missingStart ? undefined:Math.max(0,Date.now()-item.started),...extra}});}catch{}
    try {item.span.end();}catch{}
  }
  return {
    event(value) {
      const e=safeActivity(value); if(!e || finished.has(e.id))return;
      const item=active.get(e.id);
      if(e.state==='started') {
        if(item || opened>=max)return;
        try {const span=open(e.operation,{metadata:{...e,state:'started'},...content(value)});
          if(span){active.set(e.id,{span,event:e,started:Date.now()});opened++;}}catch{}
      } else {
        finished.add(e.id);
        if(item){active.delete(e.id); item.event={...item.event,...e}; try {item.span.update(content(value));}catch{} close(item,e.state);}
        else if(opened<max) {
          try {const span=open(e.operation,{metadata:e,...content(value)});
            if(span){opened++;close({span,event:e,started:Date.now()},e.state,{missingStart:true});}}catch{}
        }
      }
    },
    finish(reason='interrupted') {
      for(const [id,item] of active){finished.add(id);close(item,reason==='request_cancelled'?'cancelled':'failed',{finishReason:reason});}
      active.clear();
    },
  };
}
export function traceBridgeActivity() {}
export async function traceBridgeRequest(request,execute) {
  await ready;
  const original=request.onBridgeActivity;
  const pending=new Map();
  let tools;
  request.onBridgeActivity=value=>{
    const e=safeActivity(value); if(!e)return;
    if(e.state==='started')pending.set(e.id,value);else pending.delete(e.id);
    try {original?.(value);}catch{}
    tools?.event(value);
  };
  let execution, failure;
  const once=()=>execution ??= Promise.resolve().then(execute).catch(error=>{failure=error;throw error;});
  const update=(span,data)=>{try {span.update(data);}catch{}};
  const identity={userId:request.context?.telemetryUserKey ?? request.context?.userKey,
    sessionId:request.context?.telemetrySessionKey ?? request.context?.conversationKey};
  const provider=request.cliOptions?.provider ?? 'other';
  const category=()=>request.signal?.aborted ? ['timeout','client_disconnected','shutdown'].includes(request.signal.reason?.code) ? request.signal.reason.code : 'cancelled' : 'provider_failed';
  const metadata={provider,executionId:request.executionId,attachmentCount:request.attachments?.length ?? 0};
  const run=()=>tracing.propagateAttributes({...identity,...(!request.context?.traceContext ? {traceName:'bridge.request'} : {})},()=>
    tracing.startActiveObservation('bridge.request',async root=>{
      update(root,{metadata,input:privacy.sanitizeContent(request.messages ?? request.prompt)});
      try {
        const result=await tracing.startActiveObservation(`model.${provider}`,async generation=>{
          update(generation,{model:request.model,input:privacy.sanitizeContent(request.messages ?? request.prompt),metadata:{...metadata,state:'started'}});
          tools=createToolTraceLifecycle((name,attributes)=>generation.startObservation(name,attributes,{asType:'tool'}));
          try {
            const result=await once();
            update(generation,{output:privacy.sanitizeContent(result.text),usageDetails:result.usage ? {input:result.usage.prompt_tokens ?? result.usage.input_tokens ?? 0,
              output:result.usage.completion_tokens ?? result.usage.output_tokens ?? 0}:undefined,
              metadata:{...metadata,state:'completed',generatedFileCount:result.files?.length ?? 0}});
            return result;
          }catch(error){update(generation,{level:'ERROR',statusMessage:request.signal?.aborted?'cancelled':'provider_failed',
            metadata:{...metadata,state:request.signal?.aborted?'cancelled':'failed',errorCategory:category()}});throw error;}
          finally {tools?.finish(request.signal?.aborted?'request_cancelled':failure?'provider_failed':'missing_tool_result');}
        },{asType:'generation'});
        update(root,{output:privacy.sanitizeContent(result.text),metadata:{...metadata,state:'completed'}});return result;
      }catch(error){update(root,{level:'ERROR',statusMessage:request.signal?.aborted?'cancelled':'provider_failed',
        metadata:{...metadata,state:request.signal?.aborted?'cancelled':'failed',errorCategory:category()}});throw error;}
    }));
  try {
    if(!sdk || !tracing)return await once();
    let ctx=api.ROOT_CONTEXT;
    const incoming=request.context?.traceContext;
    if(incoming){
      const [,traceId,spanId,flags]=incoming.traceparent.split('-');
      ctx=api.trace.setSpanContext(ctx,{traceId,spanId,traceFlags:parseInt(flags,16),isRemote:true,
        ...(incoming.tracestate?{traceState:api.createTraceState(incoming.tracestate)}:{})});
    }
    try {return await api.context.with(ctx,run);}catch(error){if(failure)throw failure;return await once();}
  } finally {
    const reason=request.signal?.aborted?'request_cancelled':failure?'provider_failed':'missing_tool_result';
    for(const value of pending.values()) {
      const e={...value,state:request.signal?.aborted?'cancelled':'failed',errorCategory:request.signal?.aborted ? category() : reason};
      try {original?.(e);}catch{} tools?.event(e);
    }
    tools?.finish(reason);
    request.onBridgeActivity=original;
  }
}
export async function shutdownTracing(){await ready;try {await sdk?.shutdown();}catch{}}
