import { activityOperation } from './activity.mjs';
import { runClaude } from './claude-workspace.mjs';
import { workspaceInstructions } from './workspace-instructions.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readCodexEvents } from './codex-events.mjs';
import { stageAttachments } from './attachments.mjs';
import { validateFinishedFiles } from './file-toolkit.mjs';
import { snapshotWorkspace } from './output-files.mjs';
import { completeArtifactRun, artifactOutputSchema, prepareArtifactResult } from './artifacts.mjs';
import { acquireCredentialLease, createIsolatedRuntime, retainRefreshedCredential, removeIsolatedRuntime } from './isolated-runtime.mjs';
import { codexThreadOptions, codexResponseConfig, codexHostConfig } from './cli-options.mjs';


export async function* runProvider(request, signal) {
  const release = await acquireCredentialLease(request.cliOptions.provider, signal);
  let runtime;
  try {
    runtime = await createIsolatedRuntime(request);
    const { cwd, env } = runtime;
    request = request.attachments?.length ? await activityOperation(request, 'file.upload', {}, () => stageAttachments(request, cwd, { signal, env })) : await stageAttachments(request,cwd,{signal,env});
    const before = await activityOperation(request, 'workspace.list', {}, () => snapshotWorkspace(cwd));
    if (request.cliOptions.provider === 'claude') {
      yield* runClaude(request, signal, cwd, before, env);
    } else yield* runCodex(request, signal, cwd, before, env);
  } finally {
    try {
      if (runtime) {
        try { await retainRefreshedCredential(runtime); }
        finally { await removeIsolatedRuntime(runtime); }
      }
    } finally { release(); }
  }
}

export async function* runCodex(request, signal, cwd, before, env, dependencies = {}) {
  const { Codex } = dependencies.sdk ?? await import('@openai/codex-sdk');
  await mkdir(resolve(cwd, 'outputs'), { recursive: true });
  await mkdir(resolve(cwd, 'work'), { recursive: true });
  const developerInstructions = workspaceInstructions(request, cwd);
  const codex = new Codex({
    env,
    config: {
      // Codex runs in a fresh per-request workspace with workspace-write sandboxing.
      // Enable its shell so it can edit, generate, and validate files in that workspace.
      ...codexHostConfig(), mcp_servers: {}, forced_login_method: 'chatgpt',
      cli_auth_credentials_store: 'file',
      ...codexResponseConfig(request.cliOptions),
      developer_instructions: developerInstructions || 'Answer the latest user message using the supplied chat transcript.'
    },
    ...(process.env.CODEX_EXECUTABLE ? { codexPathOverride: process.env.CODEX_EXECUTABLE } : {})
  });
  const thread = codex.startThread(codexThreadOptions(request, cwd));
  const input = [
    { type: 'text', text: request.prompt },
    ...(request.visionImages ?? []).map(item => ({ type: 'local_image', path: item.path })),
  ];
  const diagnostics = [];
  let commands = 0;
  const onDiagnostic = (diagnostic, item) => {
    diagnostics.push(diagnostic);
    if (diagnostics.length > 8) diagnostics.shift();
    console.error('[bridge codex execution]', JSON.stringify({
      ...diagnostic,
      ...(process.env.BRIDGE_DEBUG_PROVIDER === '1' ? {command: item.command?.slice(0, 1000), output: item.aggregated_output?.slice(-2000)} : {}),
    }));
  };
  const completed = await completeArtifactRun(async repair => {
    const { events } = await thread.runStreamed(repair ?? (request.attachments.length ? input : request.prompt), { signal, outputSchema: artifactOutputSchema(request) });
    const result = [];
    // Only the final answer from a successful, validated turn reaches LibreChat.
    for await (const event of readCodexEvents(events, { signal, toolRelay: true, includeReasoning: request.cliOptions.reasoning_summary !== 'none',
      onProgress: value => request.onProviderProgress?.({...value,attempt:repair ? 2:1}),
      onDiagnostic, onItemCompleted: item => { if (item?.type === 'command_execution') commands++; }, onActivity: value => request.onBridgeActivity?.({...value, attempt:repair ? 2:1}) })) result.push(event);
    return result;
  }, cwd, before, { onActivity:request.onBridgeActivity, signal, validateFiles: dependencies.validateFiles ?? (files => validateFinishedFiles(files, cwd, { signal, env })), getDiagnostics: () => diagnostics, prepareResult: events => {
    const prepared = prepareArtifactResult(events, request);
    if (prepared.manifest.status === 'unsupported') console.error('[bridge codex unsupported]', JSON.stringify({commands, failures: diagnostics.length, sandbox: 'workspace-write', ...(process.platform === 'win32' ? {windowsSandbox: codexHostConfig().windows.sandbox} : {})}));
    return prepared;
  } });
  for (const event of completed) yield event;
}
