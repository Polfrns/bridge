import { activityOperation } from './activity.mjs';
import { generatedOperation } from './operations.mjs';
import { readFile, lstat } from 'node:fs/promises';
import { relative, resolve, sep, extname, isAbsolute } from 'node:path';
import { collectGeneratedFiles } from './output-files.mjs';

export const ARTIFACT_INSTRUCTIONS = `Return your final answer in the structured envelope required by the output schema:
{"response":{"text":"user-facing answer"},"artifact":{"task":"edit|create|answer|code","status":"files|text|unsupported","files":["outputs/name.ext"]}}.
For LibreChat function relay, response must contain the requested action, text, name and arguments_json fields instead. The outer response/artifact envelope takes precedence over earlier instructions showing only the function decision object.
For edits to documents, images or media use task edit and status files. For explicitly requested source code edits or creation (.py, .js, .ts, scripts, etc.) use task code and status files. Create and execute helper scripts in work/, but save only finished deliverables in outputs/. Never list helper scripts as edited images, PDFs or Office documents. A script that has not been executed is not an edited document.
Use the requested format (preserve the input format unless conversion is requested). Open/validate the finished files with the relevant library before declaring success. For images, save actual image bytes; for PDF, save and reopen an actual PDF. Mention the final filenames. If the operation cannot be done with available tools, use unsupported and explain the limitation; never claim success.
For questions/summaries without a requested file use answer/text and files []. For explicitly requested source code or edits to source code files use code/files; source code is a valid deliverable in that case.
For ordinary answers and LibreChat function calls use answer/text and files []. Do not execute a shell command merely for bookkeeping. The bridge reads artifact metadata from this structured response; you do not need to write bridge-result.json. Metadata is internal bookkeeping, never a user deliverable.`;

export function artifactOutputSchema(request) {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      response: request.toolRelay ? request.outputSchema : {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string' } }, required: ['text'],
      },
      artifact: {
        type: 'object', additionalProperties: false,
        properties: {
          task: { type: 'string', enum: ['edit', 'create', 'answer', 'code'] },
          status: { type: 'string', enum: ['files', 'text', 'unsupported'] },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['task', 'status', 'files'],
      },
    },
    required: ['response', 'artifact'],
  };
}

export function prepareArtifactResult(events, request) {
  let envelope;
  try { envelope = JSON.parse(events.filter(event => typeof event.text === 'string').map(event => event.text).join('')); }
  catch { throw new Error('The provider did not return the structured response/artifact envelope.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      !envelope.response || typeof envelope.response !== 'object' || Array.isArray(envelope.response) ||
      typeof envelope.response.text !== 'string' || !envelope.artifact ||
      (request.toolRelay && !['message', 'tool_call'].includes(envelope.response.action))) {
    throw new Error('Invalid structured response/artifact envelope.');
  }
  return {
    events: [
      ...events.filter(event => typeof event.text !== 'string'),
      { text: request.toolRelay ? JSON.stringify(envelope.response) : envelope.response.text },
    ],
    manifest: envelope.artifact,
  };
}

export async function completeArtifactRun(runTurn, cwd, before, { getDiagnostics = () => [], validateFiles = async () => {}, prepareResult = events => ({ events }), onActivity, signal } = {}) {
  const usage = {};
  let repair;
  let deliveryTask;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const events = await runTurn(repair);
    signal?.throwIfAborted();
    for (const event of events) {
      for (const [key, value] of Object.entries(event.usage ?? {})) {
        if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
      }
    }
    try {
      const prepared = await prepareResult(events);
      if (prepared.manifest) {
        if (deliveryTask && (prepared.manifest.task !== deliveryTask || !['files', 'unsupported'].includes(prepared.manifest.status))) {
          throw new Error('Cannot replace a rejected file delivery with an ordinary text answer. Produce the requested files or explicitly declare the task unsupported.');
        }
        if (prepared.manifest.status === 'files' && ['edit', 'create', 'code'].includes(prepared.manifest.task)) deliveryTask = prepared.manifest.task;
      }
      const activity = {onBridgeActivity:onActivity,signal};
      const collect=()=>collectArtifacts(cwd,before,prepared.manifest);
      const files = prepared.manifest?.status==='files' ? await activityOperation(activity, 'file.download', {attempt:attempt+1}, collect) : await collect();
      if (files.length) await activityOperation(activity, 'workspace.validate', {attempt:attempt+1}, () => validateFiles(files));
      signal?.throwIfAborted();
      for (const file of files) onActivity?.({provider:'bridge',type:generatedOperation(file.filename),id:`artifact:${attempt}:${file.filename}`,state:'completed',
        filename:file.filename,extension:extname(file.filename).toLowerCase(),bytes:file.bytes,attempt:attempt+1});
      return [...prepared.events.filter(event => !event.usage), { usage }, ...(files.length ? [{ files }] : [])];
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 1) {
        const failures = getDiagnostics().slice(-4);
        const hint = failures.length ? ` Workspace execution failures: ${failures.map(item => `${item.type}${item.exitCode != null ? ` (exit ${item.exitCode})` : ''}: ${item.category}`).join('; ')}.` : '';
        throw new Error(`The sandbox did not produce valid deliverables: ${error.message}${hint}`);
      }
      repair = `The bridge rejected your result: ${error.message}\nContinue in the same workspace. If files are requested, execute the necessary editing code and validate the real output. Correct the artifact metadata in your structured response (or the manifest when using the legacy file protocol). Do not repeat an unsupported success claim. If this cannot be done, declare unsupported and explain why. Return the final answer using the same response schema.`;
    }
  }
}

export async function collectArtifacts(cwd, before, manifest) {
  if (manifest === undefined) {
    let manifestStats;
    try { manifestStats = await lstat(resolve(cwd, 'bridge-result.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await lstat(cwd); }
      catch (workspaceError) {
        if (workspaceError.code !== 'ENOENT') throw workspaceError;
        throw new Error('The request workspace disappeared before output validation.');
      }
      throw new Error('Missing bridge-result.json: Codex did not create its output manifest. Check shell/sandbox execution.');
    }
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > 64 * 1024) throw new Error('Invalid artifact manifest file.');
    manifest = JSON.parse(await readFile(resolve(cwd, 'bridge-result.json'), 'utf8'));
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !['edit', 'create', 'answer', 'code'].includes(manifest.task) ||
      !['files', 'text', 'unsupported'].includes(manifest.status) || !Array.isArray(manifest.files)) {
    throw new Error('Missing or invalid artifact manifest.');
  }
  if (manifest.status !== 'files') {
    if (manifest.files.length || (manifest.task === 'edit' && manifest.status === 'text')) {
      throw new Error('An edit requires actual files or an explicit unsupported result.');
    }
    return [];
  }
  if (!manifest.files.length || manifest.files.length > 10 || new Set(manifest.files).size !== manifest.files.length) {
    throw new Error('The artifact manifest requires 1–10 distinct finished files.');
  }
  const paths = manifest.files.map(path => {
    if (typeof path !== 'string' || isAbsolute(path)) throw new Error('Invalid artifact path.');
    const local = relative(cwd, resolve(cwd, path));
    if (!local.startsWith(`outputs${sep}`)) throw new Error('Artifacts must be inside outputs/.');
    if (manifest.task === 'edit' && ['.py', '.js', '.mjs', '.sh', '.ps1'].includes(extname(local).toLowerCase())) {
      throw new Error('A helper script cannot substitute for an edited file. Use task code for an explicitly requested code file.');
    }
    return local;
  });
  const files = await collectGeneratedFiles(cwd, before, paths);
  if (files.length !== paths.length || files.some(file => file.bytes === 0)) {
    throw new Error('A declared artifact is missing, empty, a symlink, or unchanged. Execute the editing script and save the actual output.');
  }
  for (const file of files) {
    const bytes = Buffer.from(file.data, 'base64');
    if (file.mimeType === 'application/pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The declared PDF is not a PDF.');
    if (file.mimeType === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('The declared PNG is not a PNG.');
    if (file.mimeType === 'image/jpeg' && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw new Error('The declared JPEG is not a JPEG.');
  }
  return files;
}
