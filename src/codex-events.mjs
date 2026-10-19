import { openAIUsage } from './protocol.mjs';

export function codexFailureDiagnostic(item) {
  if (item?.type === 'command_execution' && (item.status === 'failed' || Number.isInteger(item.exit_code) && item.exit_code !== 0)) {
    const output = item.aggregated_output || '';
    const category = /MAX_PATH|filename.*too long|path.*too long|ERROR_FILENAME_EXCED_RANGE/i.test(output) ? 'path_length'
      : /CreateProcessWithLogonW|sandbox.*(?:fail|setup|unavailable)|sandbox.*not.*initializ/i.test(output) ? 'windows_sandbox_setup'
      : /access is denied|permission denied|UnauthorizedAccess/i.test(output) ? 'permission_denied'
      : /not found|no such file|cannot find|not recognized|no se reconoce|no se encuentra/i.test(output) ? 'missing_path_or_executable'
      : 'command_failed';
    return { type: item.type, exitCode: item.exit_code, category };
  }
  if (item?.type === 'file_change' && item.status === 'failed') return { type: item.type, category: 'patch_failed' };
  if (item?.type === 'mcp_tool_call' && item.status === 'failed') return { type: item.type, category: 'tool_failed' };
  return null;
}

export async function* readCodexEvents(events, { toolRelay = false, includeReasoning = false, signal, onProgress, onDiagnostic = () => {}, onItemCompleted = () => {}, onActivity = () => {} } = {}) {
  const seen = new Map();
  let completed = false;
  let finalResponse = '';
  for await (const event of events) {
    signal?.throwIfAborted();
    if (['item.started', 'item.completed'].includes(event.type) && event.item?.type) {
      onActivity({provider: 'codex', type: event.item.type, id: event.item.id,
        item: event.item, exitCode: event.item.exit_code, errorCategory: codexFailureDiagnostic(event.item)?.category,
        state: event.type === 'item.started' ? 'started' : codexFailureDiagnostic(event.item) ? 'failed' : 'completed'});
    }
    if (event.type === 'item.completed') {
      onItemCompleted(event.item);
      const diagnostic = codexFailureDiagnostic(event.item);
      if (diagnostic) onDiagnostic(diagnostic, event.item);
      // The SDK labels these as public reasoning summaries; do not read raw reasoning.
      if (includeReasoning && event.item?.type === 'reasoning' && event.item.text) {
        if (onProgress) onProgress({provider:'codex',id:event.item.id,text:event.item.text});
        else yield { reasoning: event.item.text };
      }
    }
    if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item?.type === 'agent_message') {
      const text = event.item.text || '';
      if (toolRelay) {
        // No phase field in the pinned SDK. Structured final output is never
        // progress; the public channel accepts only safe operational sentences.
        if (includeReasoning && event.type === 'item.completed' && text && !/^\s*[\[{]/.test(text)) {
          onProgress?.({provider:'codex',id:event.item.id,text});
        }
        // Like Codex SDK Thread.run, only the last completed agent message is final.
        if (event.type === 'item.completed') finalResponse = text;
        continue;
      }
      const previous = seen.get(event.item.id) || '';
      if (!text.startsWith(previous)) throw new Error('Codex replaced a streamed message; cannot emit it safely.');
      if (text.length > previous.length) yield { text: text.slice(previous.length) };
      seen.set(event.item.id, text);
    } else if (event.type === 'turn.completed') {
      if (toolRelay) yield { text: finalResponse };
      yield { usage: openAIUsage(event.usage) };
      completed = true;
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      throw new Error(event.error?.message || event.message || 'Codex failed.');
    }
  }
  if (!completed) throw new Error('Codex ended without a successful turn.');
}
