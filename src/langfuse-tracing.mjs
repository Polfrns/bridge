/** Langfuse SDK v5 / OpenTelemetry; fail-open, one provider invocation per request. */
import { safeActivity } from './activity.mjs';

const enabled = Boolean(process.env.LANGFUSE_BASE_URL && process.env.LANGFUSE_PUBLIC_KEY &&
  process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_TRACING_ENABLED !== 'false');
let sdk;
let observe;
let startSpan;
const ready = enabled ? (async () => {
  try {
    const [{NodeSDK}, {LangfuseSpanProcessor}, tracing] = await Promise.all([
      import('@opentelemetry/sdk-node'), import('@langfuse/otel'), import('@langfuse/tracing'),
    ]);
    sdk = new NodeSDK({spanProcessors: [new LangfuseSpanProcessor()]});
    sdk.start();
    observe = tracing.startActiveObservation;
    startSpan = tracing.startObservation;
    console.log('[bridge tracing] Langfuse enabled');
  } catch (error) {
    sdk = undefined;
    console.error('[bridge tracing] disabled:', error?.message);
  }
})() : Promise.resolve();

function usageDetails(usage) {
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const result = {};
  if (Number.isFinite(input)) result.input = input;
  if (Number.isFinite(output)) result.output = output;
  return Object.keys(result).length ? result : undefined;
}
/** One isolated lifecycle per request. No raw arguments, paths, content or SDK IDs. */
export function createToolTraceLifecycle(open, {max = 120} = {}) {
  const active = new Map();
  let opened = 0;
  const close = (item, status, metadata = {}) => {
    try {
      item.span.update({level: status === 'failed' ? 'ERROR' : 'DEFAULT',
        metadata: {provider: item.provider, tool: item.type, state: status,
          durationMs: Math.max(0, Date.now() - item.started), ...metadata}});
    } catch { /* telemetry must not affect tools */ }
    try { item.span.end(); } catch { /* telemetry must not affect tools */ }
  };
  return {
    event(value) {
      const evt = safeActivity(value);
      if (!evt) return;
      // Use only the hashed, opaque ID generated for display events.
      const key = evt.id;
      if (evt.state === 'started') {
        if (active.has(key) || opened >= max) return;
        try {
          const span = open('bridge.tool', {asType: 'tool',
            metadata: {provider: evt.provider, tool: evt.type, state: 'started', operationId: key}});
          if (span) { active.set(key, {span, started: Date.now(), provider: evt.provider, type: evt.type}); opened++; }
        } catch { /* telemetry must not affect tools */ }
      } else {
        const item = active.get(key);
        if (item) {
          active.delete(key);
          close(item, evt.state);
        } else if (opened < max) {
          // Some providers emit a terminal event with no start event.
          try {
            const span = open('bridge.tool', {asType: 'tool',
              metadata: {provider: evt.provider, tool: evt.type, operationId: key}});
            if (span) { opened++; close({span, started: Date.now(), provider: evt.provider, type: evt.type}, evt.state, {missingStart: true}); }
          } catch { /* telemetry must not affect tools */ }
        }
      }
    },
    finish(reason = 'interrupted') {
      for (const item of active.values()) close(item, 'failed', {finishReason: reason});
      active.clear();
    },
  };
}

/** Backwards-compatible no-op: tool spans are now scoped inside traceBridgeRequest. */
export function traceBridgeActivity() {}
export async function traceBridgeRequest(request, execute) {
  await ready;
  if (!sdk || !observe) return execute();
  let execution;
  let failure;
  const runOnce = () => {
    if (!execution) execution = Promise.resolve().then(execute).catch(err => {failure = err; throw err;});
    return execution;
  };
  const update = (span, value) => {try {span.update(value);} catch { /* Noncritical. */ }};
  const originalActivity = request.onBridgeActivity;
  try {
    return await observe('bridge.request', async root => {
      update(root, {userId: request.context?.userKey, sessionId: request.context?.conversationKey,
        metadata: {provider: request.cliOptions?.provider, model: request.model,
          attachmentCount: request.attachments?.length ?? 0}});
      return observe('bridge.model-run', async generation => {
        update(generation, {model: request.model});
        const tools = createToolTraceLifecycle((name, options) => startSpan?.(name, options));
        request.onBridgeActivity = event => {
          // The UI callback is the existing source of truth for activity;
          // telemetry is independent, best-effort and cannot block it.
          try { originalActivity?.(event); } catch { /* best effort */ }
          tools.event(event);
        };
        let succeeded = false;
        try {
          const result = await runOnce();
          succeeded = true;
          update(generation, {usageDetails: usageDetails(result.usage),
            metadata: {generatedFileCount: result.files?.length ?? 0}});
          return result;
        } catch (error) {
          update(generation, {level: 'ERROR', statusMessage: error?.name || 'provider_failed'});
          throw error;
        } finally {
          tools.finish(succeeded ? 'missing_tool_result' : 'provider_failed');
          request.onBridgeActivity = originalActivity;
        }
      }, {asType: 'generation'});
    });
  } catch (error) {
    if (failure) throw failure;
    console.error('[bridge tracing] noncritical failure:', error?.message);
    return runOnce();
  } finally {
    request.onBridgeActivity = originalActivity;
  }
}
export async function shutdownTracing() {
  await ready;
  if (!sdk) return;
  try {await sdk.shutdown();} catch (error) {console.error('[bridge tracing] shutdown:', error?.message);}
}
