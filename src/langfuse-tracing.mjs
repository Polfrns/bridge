/** Langfuse SDK v5 / OpenTelemetry; fail-open, one provider invocation per request. */
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
export function traceBridgeActivity(event) {
  if (!startSpan) return;
  try {
    const span = startSpan('bridge.tool', {
      metadata: {provider: event.provider, tool: event.type, state: event.state},
    });
    span.end();
  } catch { /* Noncritical. */ }
}
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
  try {
    return await observe('bridge.request', async root => {
      update(root, {userId: request.context?.userKey, sessionId: request.context?.conversationKey,
        metadata: {provider: request.cliOptions?.provider, model: request.model,
          attachmentCount: request.attachments?.length ?? 0}});
      return observe('bridge.model-run', async generation => {
        update(generation, {model: request.model});
        try {
          const result = await runOnce();
          update(generation, {usageDetails: usageDetails(result.usage),
            metadata: {generatedFileCount: result.files?.length ?? 0}});
          return result;
        } catch (error) {
          update(generation, {level: 'ERROR', statusMessage: error?.name || 'provider_failed'});
          throw error;
        }
      }, {asType: 'generation'});
    });
  } catch (error) {
    if (failure) throw failure;
    console.error('[bridge tracing] noncritical failure:', error?.message);
    return runOnce();
  }
}
export async function shutdownTracing() {
  await ready;
  if (!sdk) return;
  try {await sdk.shutdown();} catch (error) {console.error('[bridge tracing] shutdown:', error?.message);}
}
