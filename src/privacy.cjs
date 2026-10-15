'use strict';
// Export-boundary policy: preserve measurements and bounded technical enums only.
const REDACTED = '[redacted]';
const ENUM = /^(provider|tool|operation|state|status|errorCategory|finishReason|extension|mimeType|type|model|service|category|filename|mcpServer)$/;
const COUNTER = /^(durationMs|attempt|exitCode|startedAt|endedAt|bytes|attachmentCount|generatedFileCount|missingStart|truncated|observedAt)$/;
function sanitizeData(data, depth=0, seen=new WeakSet()) {
  if (depth > 6) return REDACTED;
  if (data == null || typeof data === 'boolean' || typeof data === 'number') return data;
  if (typeof data === 'string') {
    if (data.length <= 65536 && /^[\[{]/.test(data.trim())) {
      try {return JSON.stringify(sanitizeData(JSON.parse(data),depth+1,seen));} catch { /* opaque text */ }
    }
    return REDACTED;
  }
  if (typeof data !== 'object' || Buffer.isBuffer(data) || ArrayBuffer.isView(data)) return REDACTED;
  if (seen.has(data)) return REDACTED;
  seen.add(data);
  if (Array.isArray(data)) return data.slice(0,30).map(v=>sanitizeData(v,depth+1,seen));
  const out={};
  for(const [key,value] of Object.entries(data).slice(0,60)) {
    if (COUNTER.test(key) && ['number','boolean'].includes(typeof value)) out[key]=value;
    else if (ENUM.test(key) && typeof value==='string' && value.length<=120 && /^[A-Za-z0-9_. -]+$/.test(value)
      && !/token|password|secret|credential|authorization/i.test(value)
      && (key !== 'filename' || process.env.OBSERVABILITY_FILE_NAMES==='true')) out[key]=value;
    else if (/^(id|executionId|operationId)$/.test(key) && typeof value==='string' && /^[A-Za-z0-9_-]{16,80}$/.test(value)) out[key]=value;
    else if (key==='missingStart' && typeof value==='boolean') out[key]=value;
  }
  return out;
}
function sanitizeAttributes(attributes={}) {
  const out={};
  for(const [key,value] of Object.entries(attributes)) {
    if (/input|output|prompt|completion|command|content|body|header|url|path|query|statement|exception|stack|secret|token(?!s)|authorization|cookie/i.test(key)
      && !/usage|tokens|token_count/i.test(key)) {out[key]=REDACTED; continue;}
    if (key.includes('metadata')) {
      if (key.endsWith('.metadata')) {
        let data=value; try {if(typeof value==='string')data=JSON.parse(value);} catch {data=null;}
        out[key]=JSON.stringify(sanitizeData(data));
      } else {
        const field=key.split('.').pop();
        out[key]=ENUM.test(field) || COUNTER.test(field) ? sanitizeData({[field]:value})[field] : REDACTED;
      }
    } else if (typeof value==='number' || typeof value==='boolean') out[key]=value;
    else if (/^(session.id|user.id|langfuse.(session|user).id)$/.test(key) && /^[a-f0-9]{64}$/.test(value)) out[key]=value;
    else if (/^(langfuse.observation.(type|level|model.name)|langfuse.trace.name|service.name|service.version|langfuse.environment|langfuse.release|mcp.tool.name)$/.test(key)
      && typeof value==='string' && /^[A-Za-z0-9_. -]{1,120}$/.test(value)) out[key]=value;
    else if (/^(id|executionId|operationId)$/.test(key) && typeof value==='string' && /^[A-Za-z0-9_-]{16,80}$/.test(value)) out[key]=value;
    else if (key==='missingStart' && typeof value==='boolean') out[key]=value;
  }
  return out;
}
function sanitizeSpan(span) {
  // Clone the export view, never mutate model messages, live spans, or another exporter.
  const clean = Object.create(Object.getPrototypeOf(span));
  Object.assign(clean, span, {attributes:sanitizeAttributes(span.attributes),events:[],links:[],status:{code:span.status?.code ?? 0}});
  clean.name = typeof span.name==='string' && /^[A-Za-z0-9_.-]{1,140}$/.test(span.name) && !/secret|password|credential|authorization/i.test(span.name) ? span.name : 'operation';
  const resource=span.resource;
  if(resource) clean.resource={...resource, attributes:sanitizeAttributes(resource.attributes)};
  return clean;
}
function protectProcessor(processor, {provider}={}) {
  return {
    onStart:(span,ctx)=>{try {processor.onStart(span,ctx);} catch {}},
    onEnd:span=>{try {
      const safe=sanitizeSpan(span);
      if(provider) {
        safe.attributes['langfuse.observation.metadata.provider']=provider;
        safe.attributes['langfuse.observation.metadata.state']=span.status?.code===2 ? 'failed':'completed';
        if(safe.attributes['langfuse.observation.type']==='generation')safe.name='model.other';
      }
      processor.onEnd(safe);
    } catch {}},
    forceFlush:async()=>{try {await processor.forceFlush();} catch {}},
    shutdown:async()=>{try {await processor.shutdown();} catch {}},
  };
}
module.exports={sanitizeData,sanitizeAttributes,sanitizeSpan,protectProcessor};
