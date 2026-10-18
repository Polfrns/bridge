import { createHash, randomUUID } from 'node:crypto';
import { classifyOperation, OPERATION_LABELS } from './operations.mjs';
const SAFE = Symbol('safeActivity');
const MAX_ACTIVITY = 1000;
export function safeActivity(value) {
  if (value?.[SAFE]) return value;
  if (!value || !['codex','claude','bridge'].includes(value.provider) ||
      !['started','completed','failed','cancelled'].includes(value.state)) return null;
  const operation = classifyOperation(value);
  if (!operation) return null;
  const id = createHash('sha256').update(`${value.provider}:${value.type}:${String(value.id ?? value.type)}:${value.attempt ?? 1}`).digest('base64url').slice(0,24);
  const result = {provider:value.provider, type:value.type, state:value.state,
    label:OPERATION_LABELS[operation] ?? operation, id, operation};
  for (const key of ['durationMs','attempt','exitCode','startedAt','endedAt']) {
    if (Number.isFinite(value[key]) && Math.abs(value[key]) < Number.MAX_SAFE_INTEGER) result[key] = value[key];
  }
  if (/^[a-z_]{1,50}$/.test(value.errorCategory ?? '')) result.errorCategory = value.errorCategory;
  const input=value.item ?? value.input ?? {};
  const affected=value.filename ?? input.file_path ?? (input.changes?.length===1 ? input.changes[0].path : undefined);
  const extension=typeof affected==='string' ? affected.replace(/\\/g,'/').split('/').pop().match(/\.[a-zA-Z0-9]{1,12}$/)?.[0].toLowerCase():undefined;
  if(extension) result.extension=extension;
  if (/^[A-Za-z0-9_.-]{1,80}$/.test(input.server ?? '')) result.mcpServer=input.server;
  if (typeof value.extension === 'string' && /^\.[a-z0-9]{1,12}$/.test(value.extension)) result.extension = value.extension;
  if (Number.isSafeInteger(value.bytes) && value.bytes >= 0) result.bytes = value.bytes;
  // Basenames are opt-in; file content and internal paths are never included.
  if (process.env.OBSERVABILITY_FILE_NAMES === 'true' && typeof affected === 'string') {
    const filename = affected.replace(/\\/g,'/').split('/').pop();
    if (/^[\p{L}\p{N} ._-]{1,100}$/u.test(filename) && !/env|secret|credential|token|password/i.test(filename)) result.filename = filename;
  }
  Object.defineProperty(result, SAFE, {value:true});
  return result;
}
export function activityLine(value) {
  const e = safeActivity(value);
  if (!e) return null;
  return `• ${e.provider === 'codex' ? 'Codex' : e.provider === 'claude' ? 'Claude' : 'Bridge'} · ${e.label} — ${{started:'Iniciada',completed:'Completada',failed:'Fallida',cancelled:'Cancelada'}[e.state]}\n`;
}
export function createActivityReporter(send, {max=MAX_ACTIVITY}={}) {
  const states = new Map();
  return value => {
    const event = safeActivity(value);
    if (!event) return;
    const previous = states.get(event.id);
    if ((!previous && states.size >= max) || previous?.state === event.state || (previous && previous.state !== 'started')) return;
    const now=Date.now();
    const startedAt=previous?.startedAt ?? event.startedAt ?? (event.state==='started' ? now : undefined);
    states.set(event.id,{state:event.state,startedAt});
    const timed={...event,...(startedAt===undefined?{}:{startedAt}),
      ...(event.state==='started'?{}:{endedAt:now,...(startedAt===undefined?{}:{durationMs:Math.max(0,now-startedAt)})})};
    Object.defineProperty(timed, SAFE, {value:true});
    try {send(timed);} catch { /* Activity cannot break inference. */ }
  };
}
export function activityCardRecord(value) {
  const e = safeActivity(value);
  if (!e) return null;
  const {label, ...data} = e;
  return `[[ROKO_BRIDGE_TOOL_V1:${Buffer.from(JSON.stringify({v:1,...data})).toString('base64url')}]]\n`;
}
export async function activityOperation(request, type, metadata, execute) {
  const id = randomUUID(), startedAt = Date.now();
  const base = {provider:'bridge',type,id,...metadata,startedAt};
  const send = event => {try { request.onBridgeActivity?.(event); } catch { /* Best effort. */ }};
  send({...base,state:'started'});
  try {
    const result = await execute();
    send({...base,state:'completed',endedAt:Date.now(),durationMs:Date.now()-startedAt});
    return result;
  } catch (error) {
    send({...base,state:request.signal?.aborted ? 'cancelled':'failed',endedAt:Date.now(),durationMs:Date.now()-startedAt,
      errorCategory:request.signal?.aborted ? 'cancelled':'operation_failed'});
    throw error;
  }
}
