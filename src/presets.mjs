export const MODEL_PRESETS = Object.freeze({
  'gpt-codex': { provider: 'codex', reasoning_effort: 'medium' },
  'gpt-codex-fast': { provider: 'codex', reasoning_effort: 'low' },
  'gpt-codex-deep': { provider: 'codex', reasoning_effort: 'high' },
  'claude-max': { provider: 'claude', reasoning_effort: 'medium' },
  'claude-max-fast': { provider: 'claude', model: 'sonnet', reasoning_effort: 'low' },
  'claude-max-deep': { provider: 'claude', model: 'opus', reasoning_effort: 'high' },
});

export const MODEL_IDS = Object.freeze(Object.keys(MODEL_PRESETS));
