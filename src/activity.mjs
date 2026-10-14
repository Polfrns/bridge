import { createHash } from 'node:crypto';
/** Safe, observable tool activity – never a model chain-of-thought or raw tool data. */
const LABELS = Object.freeze({
  command_execution: 'Comando del workspace',
  file_change: 'Modificación de archivos',
  mcp_tool_call: 'Herramienta MCP interna',
  web_search: 'Búsqueda web',
  image_generation: 'Generación de imagen',
  collab_tool_call: 'Operación de agente',
  todo_list: 'Plan de trabajo',
  exec_command: 'Comando del workspace',
  reasoning: null,
});
const CLAUDE_TOOLS = new Set(['Read','Write','Edit','Glob','Grep','WebSearch','WebFetch','Bash','mcp__workspace__execute']);
const MAX_ACTIVITY = 120;

export function safeActivity(value) {
  if (!value || typeof value !== 'object') return null;
  const {provider, type, state} = value;
  if (!['codex','claude'].includes(provider) || !['started','completed','failed'].includes(state)) return null;
  const label = provider === 'codex' ? LABELS[type] : CLAUDE_TOOLS.has(type) ? ({
    Read: 'Lectura de archivo', Write: 'Escritura de archivo', Edit: 'Edición de archivo',
    Glob: 'Búsqueda de archivos', Grep: 'Búsqueda de texto', WebSearch: 'Búsqueda web',
    WebFetch: 'Consulta web', Bash: 'Comando del workspace',
    mcp__workspace__execute: 'Comando del workspace',
  })[type] : null;
  if (!label) return null;
  // Stable opaque operation id. Never send SDK ids, file paths or tool arguments.
  const id = createHash('sha256').update(`${provider}:${type}:${String(value.id ?? type)}`).digest('base64url').slice(0, 24);
  return {provider, type, state, label, id};
}

export function activityLine(value) {
  const event = safeActivity(value);
  if (!event) return null;
  const action = event.state === 'started' ? 'Iniciada' : event.state === 'completed' ? 'Completada' : 'Fallida';
  return `• ${event.provider === 'codex' ? 'Codex' : 'Claude'} · ${event.label} — ${action}\n`;
}

/** Cap and deduplicate progress per request. Callbacks are synchronous and best-effort. */
export function createActivityReporter(send, {max = MAX_ACTIVITY} = {}) {
  let count = 0;
  const states = new Map();
  return value => {
    const event = safeActivity(value);
    if (!event || count >= max) return;
    const key = `${event.provider}:${value.id ?? event.type}`;
    if (states.get(key) === event.state) return;
    states.set(key, event.state);
    count++;
    try { send(event); } catch { /* Telemetry/UI must not affect inference. */ }
  };
}

/** Private Roko display metadata, carried in reasoning_content but never executed as a tool. */
export function activityCardRecord(value) {
  const event = safeActivity(value);
  if (!event) return null;
  // No prompts, reasoning, file paths, command text or tool output are transmitted.
  const payload = {v: 1, id: event.id, provider: event.provider, type: event.type, state: event.state};
  return `[[ROKO_BRIDGE_TOOL_V1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}]]\n`;
}
