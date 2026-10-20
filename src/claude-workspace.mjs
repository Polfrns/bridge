import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { createAnswerStream } from './answer-stream.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceExecutor, workspaceFileAllowed } from './workspace-executor.mjs';
import { claudeIsolatedEnv } from './isolated-runtime.mjs';
import { claudeModelOptions } from './cli-options.mjs';
import { artifactOutputSchema, completeArtifactRun, prepareArtifactResult } from './artifacts.mjs';
import { validateFinishedFiles } from './file-toolkit.mjs';
import { openAIUsage } from './protocol.mjs';
import { workspaceInstructions } from './workspace-instructions.mjs';

export const EXEC_TOOL = 'mcp__workspace__execute';

function workspaceResultMetadata(type, block) {
  if(type !== EXEC_TOOL) return {};
  try {
    const text=typeof block.content==='string' ? block.content : (block.content ?? []).filter(x=>x.type==='text').map(x=>x.text).join('');
    const result=JSON.parse(text);
    return {...(Number.isInteger(result.exitCode)?{exitCode:result.exitCode}:{}),...(Number.isFinite(result.durationMs)&&result.durationMs>=0?{durationMs:result.durationMs,timingSource:'execution'}:{})};
  } catch {return {};}
}

/** In-process SDK transport only: no listener, separate MCP service, or global config. */
export function claudeWorkspaceServer(sdk, executor, signal, diagnostics) {
  return sdk.createSdkMcpServer({ name: 'workspace', version: '1.0.0', tools: [sdk.tool(
    'execute', 'Execute shell commands in the isolated request workspace. Use provisioned Python, LibreOffice, FFmpeg and Tesseract to edit real files. POSIX sh on Linux; PowerShell on native Windows. No network, package installs, or background processes. Save deliverables in outputs/ and helpers in work/.',
    { description: z.string().max(240).optional().describe('Brief public explanation of what this particular operation is for; no command lines or internal paths.'), command: z.string().min(1).max(16000), timeout_ms: z.number().int().min(1000).max(120000).optional() },
    async ({ command, timeout_ms }) => {
      try {
        const started = performance.now();
        const result = await executor.execute(command, { signal, timeout: timeout_ms ?? 60000 });
        const durationMs = Math.max(0, performance.now() - started);
        if (result.exitCode !== 0) diagnostics.push({ type: 'workspace_execution', exitCode: result.exitCode, category: (result.stderr || result.stdout || 'command failed').slice(-1200) });
        if (diagnostics.length > 8) diagnostics.shift();
        const output = { ...result, durationMs, stdout: result.stdout.slice(0, 48000), stderr: result.stderr.slice(-16000), truncated: result.stdout.length > 48000 || result.stderr.length > 16000 };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], isError: result.exitCode !== 0 };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        diagnostics.push({ type: 'workspace_execution', category: error.message.slice(-1200) });
        if (diagnostics.length > 8) diagnostics.shift();
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    },
  )] });
}

/** A private, disposable Claude session is reused for the single artifact repair. */
export async function* runClaude(request, signal, cwd, before, env, dependencies = {}) {
  const sdk = dependencies.sdk ?? await import('@anthropic-ai/claude-agent-sdk');
  const executor = dependencies.executor ?? new WorkspaceExecutor(cwd, env);
  const validateFiles = dependencies.validateFiles ?? (files => validateFinishedFiles(files, cwd, { signal, env }));
  const abortController = new AbortController();
  const abort = () => abortController.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (const path of ['outputs', 'work']) await mkdir(resolve(cwd, path), { recursive: true });
    const diagnostics = [];
    const answer = createAnswerStream(request, signal);
    let session;
    const imageBlocks = await Promise.all((request.visionImages ?? []).map(async item => ({
      type: 'image', source: { type: 'base64', media_type: item.mimeType, data: (await readFile(item.path)).toString('base64') },
    })));
    const pdfBlocks = request.attachments.filter(item => item.mimeType === 'application/pdf').map(item => ({
      type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: item.data }, title: item.filename,
    }));
    const completed = await completeArtifactRun(async repair => {
      signal.throwIfAborted();
      const content = [{ type: 'text', text: repair ?? request.prompt }, ...(repair ? [] : [...imageBlocks, ...pdfBlocks])];
      const toolDurations = new Map();
      const recordDuration = async input => {
        if (Number.isFinite(input.duration_ms) && input.duration_ms>=0 && toolDurations.size<1000) toolDurations.set(input.tool_use_id,input.duration_ms);
        return {};
      };
      const options = {
        cwd, env: claudeIsolatedEnv(env), abortController,
        tools: ['Read', 'Write', 'Edit'], allowedTools: ['Read', 'Write', 'Edit', EXEC_TOOL],
        mcpServers: { workspace: claudeWorkspaceServer(sdk, executor, abortController.signal, diagnostics) }, strictMcpConfig: true,
        settingSources: [], includePartialMessages: request.stream === true, maxTurns: 40,
        // PreToolUse also guards tools pre-approved by allowedTools or SDK defaults.
        hooks: { PostToolUse:[{hooks:[recordDuration]}], PostToolUseFailure:[{hooks:[recordDuration]}], PreToolUse: [{ matcher: '^(Read|Write|Edit)$', hooks: [async input => {
          if (await workspaceFileAllowed(cwd, input.tool_input?.file_path)) return {};
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'File access is restricted to this request workspace; outside paths and symlinks are denied.' } };
        }] }] },
        systemPrompt: workspaceInstructions(request, cwd) + '\n\nUse mcp__workspace__execute for shell/code execution. Bash and PowerShell built-in tools are intentionally absent; this workspace tool supplies the native shell through the bridge OS sandbox.',
        canUseTool: async (name, input) => name === EXEC_TOOL || (['Read', 'Write', 'Edit'].includes(name) && await workspaceFileAllowed(cwd, input?.file_path))
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Use the isolated workspace file tools or mcp__workspace__execute. Outside paths and symlinks are denied.' },
        outputFormat: { type: 'json_schema', schema: artifactOutputSchema(request) },
        ...claudeModelOptions(request.cliOptions),
        // Only this request's HOME; removed in runProvider's finally, never a shared history.
        persistSession: true,
        ...(repair && session ? { resume: session } : {}),
        ...(process.env.CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE } : {}),
      };
      const prompt = (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }; })();
      const stream = sdk.query({ prompt, options });
      let result;
      const activeTools = new Map();
      let pendingPurpose;
      const partialBlocks = new Map();
      const partialMessages = new Set();
      let partialMessageId;
      try {
        for await (const message of stream) {
          signal.throwIfAborted();
          if (message.session_id) session = message.session_id;
          if (!repair && message.type === 'stream_event' && !message.parent_tool_use_id) {
            const event = message.event;
            if (event?.type === 'message_start') {
              partialMessageId = event.message?.id ?? message.uuid;
              partialMessages.add(partialMessageId);
              partialBlocks.clear();
            }
            if (event?.type === 'content_block_start') {
              const block = event.content_block;
              if (block?.type === 'text' || block?.type === 'tool_use' && block.name === 'StructuredOutput') {
                const id = `${partialMessageId}:${event.index}`;
                partialBlocks.set(event.index,{id,type:block.type});
                if (block.type === 'text' && block.text) answer.delta(id,block.text);
              }
            }
            if (event?.type === 'content_block_delta') {
              const block = partialBlocks.get(event.index);
              if (block?.type === 'text' && event.delta?.type === 'text_delta') answer.delta(block.id,event.delta.text);
              if (block?.type === 'tool_use' && event.delta?.type === 'input_json_delta') answer.delta(block.id,event.delta.partial_json);
            }
          }
          if (message.type === 'tool_use_summary' && request.cliOptions.reasoning_summary !== 'none') {
            request.onProviderProgress?.({provider:'claude',id:message.uuid,text:message.summary,attempt:repair ? 2:1});
          }
          // The SDK exposes tool starts/results separately. Chat and telemetry
          // project this event independently; export privacy never alters the chat.
          if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
            for (const [index, block] of message.message.content.entries()) {
              if (!repair && !message.error && !message.parent_tool_use_id && block.type === 'text' && (message.message.id || message.uuid) && !partialMessages.has(message.message.id)) {
                answer.snapshot(`${message.message.id ?? message.uuid}:${index}`,block.text);
              }
              if (block.type === 'text' && !message.error && !message.parent_tool_use_id && request.cliOptions.reasoning_summary !== 'none') {
                request.onProviderProgress?.({provider:'claude',id:message.uuid ?? message.message.id,text:block.text,attempt:repair ? 2:1});
              }
              if(block.type==='text' && !message.error && !message.parent_tool_use_id) pendingPurpose=block.text && block.text.length<=240 && !/[\r\n]/.test(block.text) && !/^\s*[\[{]/.test(block.text) ? block.text : undefined;
              if (block.type !== 'tool_use' || !block.id) continue;
              const description=pendingPurpose;
              pendingPurpose=undefined;
              activeTools.set(block.id, {name:block.name,input:block.input,description});
              request.onBridgeActivity?.({provider: 'claude', type: block.name, input:block.input, description, id: block.id, attempt: repair ? 2 : 1, state: 'started'});
            }
          }
          if (message.type === 'user' && Array.isArray(message.message?.content)) {
            for (const block of message.message.content) {
              if (block.type !== 'tool_result' || !activeTools.has(block.tool_use_id)) continue;
              const type = activeTools.get(block.tool_use_id);
              activeTools.delete(block.tool_use_id);
              request.onBridgeActivity?.({provider: 'claude', type:type.name, input:type.input, description:type.description, id: block.tool_use_id, attempt: repair ? 2 : 1,
                state: block.is_error ? 'failed' : 'completed', result:block.content,
                ...(toolDurations.has(block.tool_use_id)?{durationMs:toolDurations.get(block.tool_use_id),timingSource:'provider'}:{}),
                ...(block.is_error ? {errorCategory:'tool_failed'}:{}),
                ...workspaceResultMetadata(type.name,block)});
            }
          }
          if (message.type !== 'result') continue;
          if (message.is_error || message.subtype !== 'success') throw new Error('Claude failed: ' + (message.errors?.join('; ') || message.subtype));
          result = [{ text: message.structured_output !== undefined ? JSON.stringify(message.structured_output) : message.result || '' }, { usage: openAIUsage(message.usage) }];
        }
      } finally {
        for (const [id, tool] of activeTools) request.onBridgeActivity?.({provider:'claude',type:tool.name,input:tool.input,description:tool.description,id,
          state:signal.aborted ? 'cancelled':'failed',errorCategory:signal.aborted ? 'cancelled':'missing_tool_result',attempt:repair ? 2:1});
        stream.close();
      }
      if (!result) throw new Error('Claude ended without a successful result.');
      return result;
    }, cwd, before, { onActivity:request.onBridgeActivity, signal, canRepair:()=>!answer.emitted, validateFiles, getDiagnostics: () => diagnostics, prepareResult: events => {
      if (answer.emitted) answer.check(JSON.parse(events.filter(e=>typeof e.text==='string').map(e=>e.text).join('')));
      return prepareArtifactResult(events, request);
    } });
    for (const event of completed) yield event;
  } finally {
    abortController.abort();
    // Finish any aborted shell before runProvider removes the workspace.
    await executor.queue;
    signal.removeEventListener('abort', abort);
  }
}
