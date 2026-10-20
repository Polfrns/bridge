import { activitySummary } from './activity-summary.mjs';
import { safeActivity, createActivityReporter } from './activity.mjs';

export const CHAT_RECORD_MAX_BYTES = 32768;
export const CHAT_RECORD_MAX_ENCODED = 65536;
const COMMAND_BYTES = 4096;
const ARGUMENT_BYTES = 6144;
const OUTPUT_BYTES = 8192;
const DESCRIPTION_BYTES = 1024;

/** @typedef {{command?: string, arguments?: string, toolOutput?: string, description?: string, summary?: string, filename?: string}} ChatDisplayFields */

function displayText(value, limit) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length > limit ? bytes.subarray(0, limit).toString('utf8') + '\n[truncado]' : text;
}

/** Tool-result text only; attachment/image payloads are not chat diagnostics. */
function resultText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .slice(0, 20).map(block => block.text).join('\n');
}

/** User-facing projection. Telemetry uses safeActivity and its export policy. */
export function chatActivity(value) {
  const event = safeActivity(value);
  if (!event) return null;
  const result = { ...event };
  // Existing external MCP cards have their own input/output presentation in Roko.
  if (value.type === 'mcp_tool_call' || value.type?.startsWith('mcp__') && value.type !== 'mcp__workspace__execute') return result;
  const input = value.item ?? value.input ?? {};
  const command = input.command ?? value.command;
  const selected = {};
  for (const key of ['command', 'description', 'file_path', 'path', 'pattern', 'glob', 'offset', 'limit', 'old_string', 'new_string', 'replace_all', 'content', 'query', 'url']) {
    const field = input[key];
    if (typeof field === 'string') selected[key] = displayText(field, ARGUMENT_BYTES);
    else if (typeof field === 'number' && Number.isFinite(field) || typeof field === 'boolean') selected[key] = field;
  }
  if (Array.isArray(input.changes)) selected.changes = input.changes.slice(0, 30).map(change => ({
    path: displayText(change?.path, 512), kind: displayText(change?.kind, 32),
  }));
  if (typeof command === 'string') result.command = displayText(command, COMMAND_BYTES);
  if (Object.keys(selected).length) result.arguments = displayText(JSON.stringify(selected, null, 2), ARGUMENT_BYTES);
  result.description = displayText(input.description, DESCRIPTION_BYTES);
  result.toolOutput = displayText(input.aggregated_output ?? resultText(value.result), OUTPUT_BYTES);
  const filename = value.filename ?? input.file_path ?? input.path;
  if (typeof filename === 'string') result.filename = displayText(filename.replace(/\\/g, '/').split('/').pop(), 256);
  result.summary = activitySummary(value, result);
  return result;
}

export function chatActivityRecord(event) {
  const { label, ...data } = event;
  let json = JSON.stringify({ v: 1, ...data });
  // JSON escaping can expand text beyond the sum of its UTF-8 budgets.
  for (const key of ['toolOutput', 'arguments', 'command', 'description']) {
    if (Buffer.byteLength(json) <= CHAT_RECORD_MAX_BYTES) break;
    if (data[key]) data[key] = displayText(data[key], 512);
    json = JSON.stringify({ v: 1, ...data });
  }
  if (Buffer.byteLength(json) > CHAT_RECORD_MAX_BYTES) return null;
  return `[[ROKO_BRIDGE_TOOL_V1:${Buffer.from(json).toString('base64url')}]]\n`;
}

export function createChatActivityReporter(send, { max = 1000 } = {}) {
  /** @type {Map<string, ChatDisplayFields>} */
  const details = new Map();
  const report = createActivityReporter(event => {
    const content = details.get(event.id) ?? {};
    send({ ...event, ...content });
    if (event.state !== 'started') details.delete(event.id);
  }, { max });
  return value => {
    const event = chatActivity(value);
    if (!event || !details.has(event.id) && details.size >= max) return;
    const content = { ...(details.get(event.id) ?? {}) };
    for (const key of ['command', 'arguments', 'toolOutput', 'description', 'filename', 'summary']) {
      if (event[key] !== undefined) content[key] = event[key];
    }
    details.set(event.id, content);
    report(value);
  };
}
