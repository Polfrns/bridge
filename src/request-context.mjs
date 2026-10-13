import { createHmac, timingSafeEqual } from 'node:crypto';
import { BridgeError } from './protocol.mjs';
import { MODEL_PRESETS } from './presets.mjs';

const MAX_IDENTITY_AGE_MS = 10 * 60 * 1000;
const MAX_CONTEXT_HEADER_LENGTH = 4096;
const MAX_ID_LENGTH = 256;

/** @typedef {{userId: string, tenantId: string, conversationId: string, model: string, options: object, timestamp: number}} SignedIdentity */
/** @typedef {{userKey: string, conversationKey: string, ownerKey: string, options: object}} RequestContext */

/** Authenticate backend identity before touching any conversation state. */
export function verifyContext(headers, model, key, now = Date.now()) {
  const encoded = headers['x-roko-context'];
  const signature = headers['x-roko-signature'];
  if (typeof encoded !== 'string' || encoded.length > MAX_CONTEXT_HEADER_LENGTH ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new BridgeError(401, 'Missing signed Roko user/conversation context.', 'invalid_identity');
  }
  const expected = createHmac('sha256', key).update(encoded).digest();
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
    throw new BridgeError(401, 'Invalid Roko identity signature.', 'invalid_identity');
  }
  let identity;
  try { identity = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new BridgeError(401, 'Invalid Roko identity context.', 'invalid_identity'); }
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
  if (!validId(identity.userId) || !validId(identity.conversationId) ||
      typeof identity.tenantId !== 'string' || identity.tenantId.length > MAX_ID_LENGTH ||
      identity.model !== model || !Number.isSafeInteger(identity.timestamp) ||
      Math.abs(now - identity.timestamp) > MAX_IDENTITY_AGE_MS ||
      !identity.options || typeof identity.options !== 'object' || Array.isArray(identity.options)) {
    throw new BridgeError(401, 'Invalid or expired Roko identity context.', 'invalid_identity');
  }
  const hash = parts => createHmac('sha256', key).update(JSON.stringify(parts)).digest('hex');
  const userKey = hash(['user', identity.tenantId, identity.userId]);
  const conversationKey = hash(['conversation', userKey, identity.conversationId]);
  return { userKey, conversationKey, ownerKey: hash(['owner', conversationKey, MODEL_PRESETS[model]?.provider]), options: identity.options };
}
