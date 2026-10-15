import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { validateRequest, validateResponsesRequest, parseToolDecision, responsesUsage, BridgeError } from './protocol.mjs';
import { runProvider } from './providers.mjs';
import { traceBridgeRequest, shutdownTracing } from './langfuse-tracing.mjs';
import { createActivityReporter, activityCardRecord } from './activity.mjs';
import { MODEL_IDS } from './presets.mjs';
import { verifyContext } from './request-context.mjs';
import { resolveCliOptions, applyCliRequestOptions } from './cli-options.mjs';
import {
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_FILE_COUNT,
  MAX_OUTPUT_TOTAL_BYTES,
} from './output-files.mjs';

export const BRIDGE_OUTPUT_PREFIX = '\u001eLIBRECHAT_OUTPUT_V1\u001e';
export const BRIDGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000;
const MAX_RESPONSE_STATES = 1000;

async function collect(provider, request, signal) {
  let text = '', usage, totalFileBytes = 0;
  const reasoning = [];
  const files = [];
  for await (const event of provider(request, signal)) {
    signal.throwIfAborted();
    if (event.text) text += event.text;
    if (typeof event.reasoning === 'string' && request.cliOptions.reasoning_summary !== 'none') reasoning.push(event.reasoning.replaceAll('[[ROKO_BRIDGE_TOOL_V1:', '[bridge activity text:')); 
    if (event.usage) usage = event.usage;
    if (event.files) {
      if (!Array.isArray(event.files)) {
        throw new BridgeError(502, 'Provider returned invalid generated file metadata.', 'invalid_output_file');
      }
      for (const file of event.files) {
        if (
          !file ||
          typeof file.filename !== 'string' ||
          !file.filename ||
          typeof file.mimeType !== 'string' ||
          !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ||
          typeof file.data !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)
        ) {
          throw new BridgeError(502, 'Provider returned invalid generated file metadata.', 'invalid_output_file');
        }
        const bytes = Buffer.from(file.data, 'base64').length;
        if (
          bytes !== file.bytes ||
          bytes > MAX_OUTPUT_FILE_BYTES ||
          totalFileBytes + bytes > MAX_OUTPUT_TOTAL_BYTES ||
          files.length >= MAX_OUTPUT_FILE_COUNT
        ) {
          throw new BridgeError(413, 'Generated files exceed the bridge output limits.', 'output_too_large');
        }
        totalFileBytes += bytes;
        files.push({
          filename: file.filename,
          mimeType: file.mimeType,
          data: file.data,
        });
      }
    }
  }
  signal.throwIfAborted();
  if (!text) throw new Error('Provider returned no assistant text.');
  return { text, usage, files, reasoning };
}

function bridgeOutputContent(text, files) {
  if (files.length === 0) return text;
  return BRIDGE_OUTPUT_PREFIX + JSON.stringify({ text, files });
}

export function createBridge({ key, provider = runProvider, timeoutMs = 180000, maxConcurrent = 2, maxBytes = 20 * 1024 * 1024 }) {
  if (!key || key.length < 32) throw new Error('Set BRIDGE_API_KEY to at least 32 characters (npm run setup).');
  let active = 0;
  const controllers = new Set();
  const responseStates = new Map();
  function authorize(header) {
    const candidate = Buffer.from(header || '');
    const expected = Buffer.from('Bearer ' + key);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function saveState(id, state) {
    const now = Date.now();
    for (const [key, value] of responseStates) if (value.savedAt < now - RESPONSE_STATE_TTL_MS) responseStates.delete(key);
    responseStates.set(id, { ...state, savedAt: now });
    while (responseStates.size > MAX_RESPONSE_STATES) responseStates.delete(responseStates.keys().next().value);
  }
  const server = createServer(async (req, res) => {
    let controller, timer, heartbeat, acquired = false;
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok', version: BRIDGE_VERSION, tools: true, images: true, responsesApi: true, webSearch: true, fileSearch: false, codeInterpreter: false });
      if (!authorize(req.headers.authorization)) return json(res, 401, { error: { message: 'Invalid bridge key.', type: 'authentication_error' } });
      if (path === '/v1/models' && req.method === 'GET') return json(res, 200, {
        object: 'list', data: MODEL_IDS.map(id => ({ id, object: 'model', owned_by: 'local-bridge' }))
      });
      const api = path === '/v1/chat/completions' ? 'chat' : path === '/v1/responses' ? 'responses' : null;
      if (!api || req.method !== 'POST') throw new BridgeError(404, 'Not found.');
      if (active >= maxConcurrent) throw new BridgeError(429, 'Bridge busy; retry after the current request finishes.', 'busy');
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new BridgeError(415, 'Use Content-Type: application/json.');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw new BridgeError(413, 'Request too large.');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BridgeError(400, 'Invalid JSON.'); }

      const context = verifyContext(req.headers, body.model, key);
      const cliOptions = resolveCliOptions(body.model, body, context.options);
      let previous = null;
      if (api === 'responses' && body.previous_response_id) {
        previous = responseStates.get(body.previous_response_id);
        if (!previous || previous.ownerKey !== context.ownerKey || previous.savedAt < Date.now() - RESPONSE_STATE_TTL_MS) {
          throw new BridgeError(400, 'previous_response_id is unknown or expired. Send the full input history.');
        }
      }
      const request = api === 'responses' ? validateResponsesRequest(body, previous) : validateRequest(body);
      request.context = context;
      applyCliRequestOptions(request, cliOptions);
      if (process.env.BRIDGE_DEBUG_ATTACHMENTS === '1') {
        console.log('[bridge attachments]', JSON.stringify({
          api, model: request.model, count: request.attachments.length,
          files: request.attachments.map(({ filename, mimeType, data }) => ({
            filename, mimeType, bytes: Buffer.byteLength(data, 'base64'),
          })),
        }));
      }
      if (active >= maxConcurrent) throw new BridgeError(429, 'Bridge busy.', 'busy');
      active++; acquired = true;
      controller = new AbortController(); controllers.add(controller);
      request.signal = controller.signal;
      res.on('close', () => { if (!res.writableEnded) controller.abort(Object.assign(new Error('Client disconnected.'),{code:'client_disconnected'})); });
      timer = setTimeout(() => controller.abort(Object.assign(new Error('Request timed out.'),{code:'timeout'})), timeoutMs);
      if (request.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
      }
      const id = (api === 'responses' ? 'resp_' : 'chatcmpl-') + randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const activityLines = [];
      let responseSequence=0, liveParts=0;
      let responsesProgressStarted=false;
      const liveReasoningId='rs_'+randomUUID().replaceAll('-','');
      const sendResponseEvent=(type,data)=>{
        responseSequence++;
        res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data,sequence_number:responseSequence})}\n\n`);
      };
      const responseProgress=line=>{
        if(!responsesProgressStarted) {
          const pending={id,object:'response',created_at:created,status:'in_progress',model:request.model,output:[],error:null};
          sendResponseEvent('response.created',{response:pending});
          sendResponseEvent('response.in_progress',{response:pending});
          sendResponseEvent('response.output_item.added',{output_index:0,item:{id:liveReasoningId,type:'reasoning',summary:[]}});
          responsesProgressStarted=true;
        }
        const location={item_id:liveReasoningId,output_index:0,summary_index:liveParts++};
        const part={type:'summary_text',text:line};
        sendResponseEvent('response.reasoning_summary_part.added',{...location,part:{type:'summary_text',text:''}});
        sendResponseEvent('response.reasoning_summary_text.delta',{...location,delta:line});
        sendResponseEvent('response.reasoning_summary_text.done',{...location,text:line});
        sendResponseEvent('response.reasoning_summary_part.done',{...location,part});
      };
      request.executionId = id;
      const activityEnabled = process.env.BRIDGE_ACTIVITY_ENABLED !== 'false';
      request.onBridgeActivity = activityEnabled ? createActivityReporter(event => {
        const line = activityCardRecord(event);
        if (!line) return;
        activityLines.push(line);
        // Transport *display-only* tool events through preserved reasoning deltas.
        // Roko renders these with its actual MCP ToolCall component; no execution replay.
        if (request.stream && api === 'responses' && !res.destroyed && !res.writableEnded) responseProgress(line);
        if (request.stream && api === 'chat' && !res.destroyed && !res.writableEnded) {
          res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created,
            model: request.model, choices: [{ index: 0, delta: {reasoning_content: line}, finish_reason: null }] }) + '\n\n');
        }
      }) : undefined;
      const collected = await traceBridgeRequest(request, () => collect(provider, request, controller.signal));
      if (activityLines.length && !request.stream) {
        collected.reasoning.unshift(...activityLines);
      }
      const decision = parseToolDecision(collected.text, request);

      if (api === 'chat') {
        const content = bridgeOutputContent(decision.text, collected.files);
        const choice = decision.type === 'tool_call'
          ? { index: 0, message: { role: 'assistant', content: content || null, tool_calls: [{ id: 'call_' + randomUUID(), type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.arguments) } }] }, finish_reason: 'tool_calls' }
          : { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' };
        if (collected.reasoning.length) choice.message.reasoning_content = collected.reasoning.join('\n\n');
        if (request.stream) {
          const send = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
          const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta, finish_reason }] });
          send(chunk({ role: 'assistant' }));
          if (collected.reasoning.length) send(chunk({ reasoning_content: collected.reasoning.join('\n\n') }));
          if (content) send(chunk({ content }));
          if (decision.type === 'tool_call') {
            const toolCall = choice.message.tool_calls[0];
            send(chunk({ tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: toolCall.function.arguments } }] }));
            send(chunk({}, 'tool_calls'));
          } else send(chunk({}, 'stop'));
          if (body.stream_options?.include_usage && collected.usage) send({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage: collected.usage });
          res.end('data: [DONE]\n\n');
        } else json(res, 200, { id, object: 'chat.completion', created, model: request.model, choices: [choice], ...(collected.usage ? { usage: collected.usage } : {}) });
        return;
      }

      const responseContent = bridgeOutputContent(decision.text, collected.files);
      const outputItem = decision.type === 'tool_call'
        ? { id: 'fc_' + randomUUID().replaceAll('-', ''), type: 'function_call', status: 'completed', call_id: 'call_' + randomUUID().replaceAll('-', ''), name: decision.name, arguments: JSON.stringify(decision.arguments) }
        : { id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: responseContent, annotations: [] }] };
      const finalConversation = [...request.conversation, decision.type === 'tool_call'
        ? { type: 'function_call', call_id: outputItem.call_id, name: decision.name, arguments: outputItem.arguments }
        : { role: 'assistant', content: decision.text }];
      saveState(id, { conversation: finalConversation, system: request.system, model: request.model, ownerKey: context.ownerKey });
      const responseObject = (status, output, usage = null) => ({
        id, object: 'response', created_at: created, status, error: null, incomplete_details: null,
        instructions: request.system || null, max_output_tokens: null, metadata: {}, model: request.model,
        output, parallel_tool_calls: false, previous_response_id: body.previous_response_id || null,
        reasoning: { effort: cliOptions.reasoning_effort, summary: cliOptions.reasoning_summary ?? null }, store: true, temperature: null,
        text: { format: { type: 'text' }, verbosity: cliOptions.verbosity ?? null }, tool_choice: body.tool_choice || 'auto', tools: body.tools || [], top_p: null,
        truncation: 'auto', usage
      });
      const responseReasoning=request.stream ? [...activityLines,...collected.reasoning] : collected.reasoning;
      const reasoningItem = responseReasoning.length ? {
        id: liveReasoningId, type: 'reasoning',
        summary: responseReasoning.map(text => ({ type: 'summary_text', text })),
      } : null;
      const outputIndex = reasoningItem ? 1 : 0;
      const finalResponse = responseObject('completed', [...(reasoningItem ? [reasoningItem] : []), outputItem], responsesUsage(collected.usage));
      if (request.stream) {
        const sendEvent=sendResponseEvent;
        if(!responsesProgressStarted) {
          sendEvent('response.created', { response: responseObject('in_progress', []) });
          sendEvent('response.in_progress', { response: responseObject('in_progress', []) });
        }
        if (reasoningItem) {
          if(!responsesProgressStarted) sendEvent('response.output_item.added', { output_index: 0, item: { ...reasoningItem, summary: [] } });
          reasoningItem.summary.forEach((part, summary_index) => {
            if(summary_index<liveParts)return;
            const location = { item_id: reasoningItem.id, output_index: 0, summary_index };
            sendEvent('response.reasoning_summary_part.added', { ...location, part: { type: 'summary_text', text: '' } });
            sendEvent('response.reasoning_summary_text.delta', { ...location, delta: part.text });
            sendEvent('response.reasoning_summary_text.done', { ...location, text: part.text });
            sendEvent('response.reasoning_summary_part.done', { ...location, part });
          });
          sendEvent('response.output_item.done', { output_index: 0, item: reasoningItem });
        }
        if (decision.type === 'tool_call') {
          const pending = { ...outputItem, status: 'in_progress', arguments: '' };
          sendEvent('response.output_item.added', { output_index: outputIndex, item: pending });
          const args = outputItem.arguments;
          sendEvent('response.function_call_arguments.delta', { item_id: outputItem.id, output_index: outputIndex, delta: args });
          sendEvent('response.function_call_arguments.done', { item_id: outputItem.id, output_index: outputIndex, arguments: args });
          sendEvent('response.output_item.done', { output_index: outputIndex, item: outputItem });
        } else {
          sendEvent('response.output_item.added', { output_index: outputIndex, item: { ...outputItem, status: 'in_progress', content: [] } });
          sendEvent('response.content_part.added', { item_id: outputItem.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          sendEvent('response.output_text.delta', { item_id: outputItem.id, output_index: outputIndex, content_index: 0, delta: responseContent });
          sendEvent('response.output_text.done', { item_id: outputItem.id, output_index: outputIndex, content_index: 0, text: responseContent });
          sendEvent('response.content_part.done', { item_id: outputItem.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: responseContent, annotations: [] } });
          sendEvent('response.output_item.done', { output_index: outputIndex, item: outputItem });
        }
        sendEvent('response.completed', { response: finalResponse });
        res.end('data: [DONE]\n\n');
      } else json(res, 200, finalResponse);
    } catch (error) {
      if (res.destroyed) return;
      const message = error instanceof BridgeError ? error.message : controller?.signal.aborted ? 'Request cancelled or timed out.' : 'Provider failed. Check local login and model configuration. ' + (error.message || '').slice(0, 300);
      const payload = { error: { message, type: 'bridge_error', code: error.code || 'provider_error' } };
      if (res.headersSent) res.end('data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n');
      else json(res, error.status || 502, payload);
    } finally {
      clearTimeout(timer); clearInterval(heartbeat);
      if (controller) controllers.delete(controller);
      if (acquired) active--;
    }
  });
  server.abortProviders = () => { for (const controller of controllers) controller.abort(Object.assign(new Error('Server stopping.'),{code:'shutdown'})); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
  const maxConcurrent = Number(process.env.MAX_CONCURRENT_REQUESTS || 2);
  const port = Number(process.env.BRIDGE_PORT || 4000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge limits/port in .env.');
  const server = createBridge({ key: process.env.BRIDGE_API_KEY, timeoutMs, maxConcurrent });
  const host = process.env.BRIDGE_HOST || '127.0.0.1';
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Bridge v${BRIDGE_VERSION} on ${host}:${port}. Chat Completions + Responses API; image/document attachments, Codex/Claude sandbox file editing, web search and LibreChat function-call relay enabled.`));
  const stop = () => { server.abortProviders(); server.close(() => { void shutdownTracing(); }); server.closeIdleConnections(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
