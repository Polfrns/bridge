import { z } from 'zod';
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

/** In-process SDK transport only: no listener, separate MCP service, or global config. */
export function claudeWorkspaceServer(sdk, executor, signal, diagnostics) {
  return sdk.createSdkMcpServer({ name: 'workspace', version: '1.0.0', tools: [sdk.tool(
    'execute', 'Execute shell commands in the isolated request workspace. Use provisioned Python, LibreOffice, FFmpeg and Tesseract to edit real files. POSIX sh on Linux; PowerShell on native Windows. No network, package installs, or background processes. Save deliverables in outputs/ and helpers in work/.',
    { command: z.string().min(1).max(16000), timeout_ms: z.number().int().min(1000).max(120000).optional() },
    async ({ command, timeout_ms }) => {
      try {
        const result = await executor.execute(command, { signal, timeout: timeout_ms ?? 60000 });
        if (result.exitCode !== 0) diagnostics.push({ type: 'workspace_execution', exitCode: result.exitCode, category: (result.stderr || result.stdout || 'command failed').slice(-1200) });
        if (diagnostics.length > 8) diagnostics.shift();
        const output = { ...result, stdout: result.stdout.slice(0, 48000), stderr: result.stderr.slice(-16000), truncated: result.stdout.length > 48000 || result.stderr.length > 16000 };
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
      const options = {
        cwd, env: claudeIsolatedEnv(env), abortController,
        tools: ['Read', 'Write', 'Edit'], allowedTools: ['Read', 'Write', 'Edit', EXEC_TOOL],
        mcpServers: { workspace: claudeWorkspaceServer(sdk, executor, abortController.signal, diagnostics) }, strictMcpConfig: true,
        settingSources: [], includePartialMessages: false, maxTurns: 40,
        // PreToolUse also guards tools pre-approved by allowedTools or SDK defaults.
        hooks: { PreToolUse: [{ matcher: '^(Read|Write|Edit)$', hooks: [async input => {
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
      try {
        for await (const message of stream) {
          if (message.session_id) session = message.session_id;
          // The SDK exposes tool starts/results as distinct messages. Only safe tool
          // names and states are emitted: no arguments, command text or file paths.
          if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
            for (const block of message.message.content) {
              if (block.type !== 'tool_use' || !block.id) continue;
              activeTools.set(block.id, block.name);
              request.onBridgeActivity?.({provider: 'claude', type: block.name, id: block.id, state: 'started'});
            }
          }
          if (message.type === 'user' && Array.isArray(message.message?.content)) {
            for (const block of message.message.content) {
              if (block.type !== 'tool_result' || !activeTools.has(block.tool_use_id)) continue;
              const type = activeTools.get(block.tool_use_id);
              activeTools.delete(block.tool_use_id);
              request.onBridgeActivity?.({provider: 'claude', type, id: block.tool_use_id,
                state: block.is_error ? 'failed' : 'completed'});
            }
          }
          if (message.type !== 'result') continue;
          if (message.is_error || message.subtype !== 'success') throw new Error('Claude failed: ' + (message.errors?.join('; ') || message.subtype));
          result = [{ text: message.structured_output !== undefined ? JSON.stringify(message.structured_output) : message.result || '' }, { usage: openAIUsage(message.usage) }];
        }
      } finally { stream.close(); }
      if (!result) throw new Error('Claude ended without a successful result.');
      return result;
    }, cwd, before, { validateFiles, getDiagnostics: () => diagnostics, prepareResult: events => prepareArtifactResult(events, request) });
    for (const event of completed) yield event;
  } finally {
    abortController.abort();
    // Finish any aborted shell before runProvider removes the workspace.
    await executor.queue;
    signal.removeEventListener('abort', abort);
  }
}
