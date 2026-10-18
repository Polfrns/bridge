import {createHmac,timingSafeEqual} from 'node:crypto';
export function trustedTraceContext(headers, key=process.env.OBSERVABILITY_TRACE_SECRET, now=Date.now()) {
  if(!key || key.length<32)return null;
  const raw=headers['x-observability-context'], signature=headers['x-observability-signature'];
  if(typeof raw!=='string' || raw.length>2048 || !/^[a-f0-9]{64}$/.test(signature ?? ''))return null;
  const expected=createHmac('sha256',key).update(raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return null;
  try {
    const p=JSON.parse(Buffer.from(raw,'base64url').toString());
    if(!Number.isSafeInteger(p.timestamp) || Math.abs(now-p.timestamp)>60000 ||
       !/^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-0[01]$/.test(p.traceparent) ||
       !/^[a-f0-9]{64}$/.test(p.sessionId) || !/^[a-f0-9]{64}$/.test(p.userId) ||
       typeof p.tracestate!=='string' || p.tracestate.length>512)return null;
    return p;
  } catch {return null;}
}
