import { createHmac } from 'node:crypto';
export function signedHeaders(key, model = 'gpt-codex', identity = {}) {
  const context = Buffer.from(JSON.stringify({ userId: 'user-a', tenantId: '', conversationId: 'conversation-a', model, options: {}, timestamp: Date.now(), ...identity })).toString('base64url');
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key,
    'X-Roko-Context': context, 'X-Roko-Signature': createHmac('sha256', key).update(context).digest('hex') };
}
