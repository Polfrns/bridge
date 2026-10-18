import { BridgeError } from './protocol.mjs';
import { MODEL_PRESETS } from './presets.mjs';

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const USER_OPTIONS = ['model', 'reasoning_effort', 'verbosity', 'reasoning_summary', 'web_search'];
/** @typedef {{provider: 'codex'|'claude', model?: string, reasoning_effort: string, verbosity?: string, reasoning_summary?: string, web_search?: boolean}} CliOptions */

function validatedOptions(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new BridgeError(400, 'CLI options must be an object.');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!USER_OPTIONS.includes(key)) throw new BridgeError(400, `CLI option ${key} is not user-configurable.`, 'invalid_cli_option');
    // LibreChat's Auto/unset slider values should retain the selected preset.
    if (item == null || item === '' || item === 'unset' || item === 'none' && key === 'verbosity') continue;
    result[key] = item;
  }
  return result;
}

/** Defaults < preset < effective UI/header values < OpenAI body overrides.
 * Permissions are constructed in the provider adapter and never accepted here.
 */
export function resolveCliOptions(model, body, contextOptions = {}, env = process.env) {
  const preset = MODEL_PRESETS[model];
  if (!preset) throw new BridgeError(400, 'Unknown bridge model.');
  const defaultModel = env[preset.provider === 'codex' ? 'CODEX_MODEL' : 'CLAUDE_MODEL'];
  const prefix = preset.provider === 'codex' ? 'CODEX' : 'CLAUDE';
  const variantModel = model.endsWith('-fast') ? env[`${prefix}_FAST_MODEL`] : model.endsWith('-deep') ? env[`${prefix}_DEEP_MODEL`] : undefined;
  const wire = {
    ...(body.web_search != null ? { web_search: body.web_search } : {}),
    ...(body.reasoning_effort != null ? { reasoning_effort: body.reasoning_effort } : {}),
    ...(body.reasoning?.effort != null ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(body.verbosity != null ? { verbosity: body.verbosity } : {}),
    ...(body.text?.verbosity != null ? { verbosity: body.text.verbosity } : {}),
    ...(body.reasoning_summary != null ? { reasoning_summary: body.reasoning_summary } : {}),
    ...(body.reasoning?.summary != null ? { reasoning_summary: body.reasoning.summary } : {}),
    ...validatedOptions(body.cli_options),
  };
  const result = {
    ...(defaultModel ? { model: defaultModel } : {}),
    ...preset,
    ...(variantModel ? { model: variantModel } : {}),
    ...validatedOptions(contextOptions),
    ...validatedOptions(wire),
  };
  const efforts = result.provider === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  if (!efforts.includes(result.reasoning_effort)) throw new BridgeError(400, `Unsupported ${result.provider} reasoning_effort: ${result.reasoning_effort}.`, 'invalid_cli_option');
  if (result.verbosity != null && !['low', 'medium', 'high'].includes(result.verbosity)) throw new BridgeError(400, 'Unsupported verbosity.', 'invalid_cli_option');
  if (result.reasoning_summary != null && !['auto', 'concise', 'detailed', 'none'].includes(result.reasoning_summary)) throw new BridgeError(400, 'Unsupported reasoning_summary.', 'invalid_cli_option');
  if (result.provider === 'claude' && (result.verbosity != null || result.reasoning_summary != null)) throw new BridgeError(400, 'Claude Code does not expose verbosity/reasoning_summary controls. Use reasoning_effort.', 'invalid_cli_option');
  if (result.web_search != null && typeof result.web_search !== 'boolean') throw new BridgeError(400, 'web_search must be boolean.', 'invalid_cli_option');
  if (result.provider === 'claude' && result.web_search === true) throw new BridgeError(422, 'Native web search is only enabled on Codex. Use a LibreChat web-search function with Claude.', 'native_tool_runtime_required');
  // Permit inert legacy SDK defaults, but never pretend a non-default control works.
  const inert = { temperature: 1, top_p: 1, frequency_penalty: 0, presence_penalty: 0, n: 1 };
  for (const name of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'stop', 'seed', 'logit_bias', 'logprobs', 'top_logprobs', 'n']) {
    const value = body[name];
    if (value == null || value === inert[name] || Array.isArray(value) && value.length === 0) continue;
    throw new BridgeError(422, `The subscription CLI does not expose ${name}. Remove this parameter; use an API endpoint if you need it.`, 'unsupported_parameter');
  }
  const allowedModels = new Set([defaultModel, env[`${prefix}_FAST_MODEL`], env[`${prefix}_DEEP_MODEL`], ...Object.values(MODEL_PRESETS).filter(p => p.provider === result.provider).map(p => p.model), ...(env[`${prefix}_ALLOWED_MODELS`] || '').split(',').map(item => item.trim())].filter(Boolean));
  if (result.model != null && !allowedModels.has(result.model)) throw new BridgeError(400, 'Backend model is not allowed by this bridge.', 'invalid_cli_option');
  return Object.freeze(result);
}

/** Apply the explicit UI search switch in either wire protocol, including false. */
export function applyCliRequestOptions(request, cliOptions) {
  request.cliOptions = cliOptions;
  request.webSearch = cliOptions.web_search ?? request.webSearch;
  if (request.webSearch) request.system += '\n\nLive web search is available. Search for current facts such as weather and include source URLs.';
}

export function codexThreadOptions(request, cwd) {
  const options = request.cliOptions;
  return {
    workingDirectory: cwd, skipGitRepoCheck: true,
    sandboxMode: 'workspace-write', approvalPolicy: 'never',
    networkAccessEnabled: request.webSearch, webSearchMode: request.webSearch ? 'live' : 'disabled',
    ...(options.model ? { model: options.model } : {}),
    modelReasoningEffort: options.reasoning_effort,
  };
}

export function codexResponseConfig(options) {
  return {
    ...(options.verbosity ? { model_verbosity: options.verbosity } : {}),
    ...(options.reasoning_summary ? { model_reasoning_summary: options.reasoning_summary } : {}),
  };
}

/** Host-only runtime choices, never sourced from signed user/model options. */
export function codexHostConfig(env = process.env, platform = process.platform) {
  const config = { sandbox_mode: 'workspace-write', approval_policy: 'never', features: { shell_tool: true } };
  if (platform === 'win32') {
    const mode = env.CODEX_WINDOWS_SANDBOX || 'unelevated';
    if (!['unelevated', 'elevated'].includes(mode)) throw new Error('CODEX_WINDOWS_SANDBOX must be unelevated or elevated.');
    config.windows = { sandbox: mode };
    config.features.unified_exec = false;
  }
  return config;
}

export function claudeModelOptions(options) {
  return { ...(options.model ? { model: options.model } : {}), effort: options.reasoning_effort, persistSession: false };
}
