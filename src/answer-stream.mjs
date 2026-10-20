// Decode only the response text of an explicitly text-only envelope. This is
// transport framing, not a review of the assistant's prose. Files and functions
// retain their existing atomic, validated delivery protocol.
const MAX_PREFIX = 64 * 1024;
const MAX_MESSAGE = 20 * 1024 * 1024;
const textOnly = value => value?.task === 'answer' && value.status === 'text' &&
  Array.isArray(value.files) && value.files.length === 0 &&
  Object.keys(value).length === 3;
const forcedTool = choice => choice === 'required' || choice?.mode === 'required' || choice?.type === 'function';

class EnvelopeText {
  constructor(request, send) {
    this.request = request;
    this.send = send;
    this.raw = '';
    this.cursor = 0;
    this.ready = false;
    this.disabled = false;
    this.ended = false;
    this.pendingHigh = '';
  }
  append(delta) {
    if (this.disabled) return;
    if (this.raw.length + delta.length > MAX_MESSAGE) throw new Error('Assistant response exceeds the streaming limit.');
    this.raw += delta;
    if (!this.ready && !this.prefix()) return;
    let decoded = '';
    while (this.cursor < this.raw.length && !this.ended) {
      const char = this.raw[this.cursor];
      if (char === '"') { this.ended = true; this.cursor++; break; }
      if (char < ' ') throw new Error('Invalid control character in streamed response.');
      if (char !== '\\') { decoded += char; this.cursor++; continue; }
      if (this.cursor + 1 >= this.raw.length) break;
      const escape = this.raw[this.cursor + 1];
      if (escape === 'u') {
        if (this.cursor + 6 > this.raw.length) break;
        const hex = this.raw.slice(this.cursor + 2, this.cursor + 6);
        if (!/^[a-f\d]{4}$/i.test(hex)) throw new Error('Invalid Unicode escape in streamed response.');
        decoded += String.fromCharCode(parseInt(hex, 16)); this.cursor += 6;
      } else {
        const escapes = {'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
        if (!Object.hasOwn(escapes, escape)) throw new Error('Invalid escape in streamed response.');
        decoded += escapes[escape]; this.cursor += 2;
      }
    }
    decoded = this.pendingHigh + decoded; this.pendingHigh = '';
    if (!this.ended && /[\uD800-\uDBFF]$/.test(decoded)) {
      this.pendingHigh = decoded.at(-1); decoded = decoded.slice(0, -1);
    }
    // A plain answer must never masquerade as Roko's generated-file envelope.
    decoded = decoded.replaceAll('\u001e', '\\u001e');
    if (decoded) this.send(decoded);
  }
  prefix() {
    // The schema and instructions put small control metadata before prose.
    // Other property orders remain valid but use the buffered fallback.
    const start = /^\s*\{\s*"artifact"\s*:\s*/.exec(this.raw);
    if (!start) {
      if (this.raw.length > MAX_PREFIX) this.disabled = true;
      return false;
    }
    if (start[0].length > MAX_PREFIX) { this.disabled = true; return false; }
    let depth = 0, string = false, escape = false, end = -1;
    for (let i = start[0].length; i < Math.min(this.raw.length, MAX_PREFIX); i++) {
      const c = this.raw[i];
      if (string) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') string = false; continue; }
      if (c === '"') string = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) { if (this.raw.length > MAX_PREFIX) this.disabled = true; return false; }
    let artifact;
    try { artifact = JSON.parse(this.raw.slice(start[0].length, end)); }
    catch { this.disabled = true; return false; }
    if (!textOnly(artifact)) { this.disabled = true; return false; }
    const response = this.request.toolRelay
      ? /^\s*,\s*"response"\s*:\s*\{\s*"action"\s*:\s*"message"\s*,\s*"text"\s*:\s*"/
      : /^\s*,\s*"response"\s*:\s*\{\s*"text"\s*:\s*"/;
    const match = response.exec(this.raw.slice(end));
    if (!match) { if (this.raw.length > MAX_PREFIX) this.disabled = true; return false; }
    if (end + match[0].length > MAX_PREFIX) { this.disabled = true; return false; }
    this.cursor = end + match[0].length;
    this.ready = true;
    return true;
  }
}

export function createAnswerStream(request, signal) {
  const candidates = new Map();
  let selected, emitted = '';
  const enabled = request.stream === true && typeof request.onAnswerText === 'function' && !forcedTool(request.toolChoice);
  function candidate(id) {
    if (!enabled || signal?.aborted) return;
    if (candidates.has(id)) return candidates.get(id);
    if (candidates.size >= 32) return;
    const decoder = new EnvelopeText(request, delta => {
      signal?.throwIfAborted();
      if (selected !== undefined && selected !== id) throw new Error('Provider replaced an answer after streaming began.');
      selected = id; emitted += delta;
      request.onAnswerText(delta);
    });
    candidates.set(id, decoder);
    return decoder;
  }
  return {
    get emitted() { return emitted; },
    delta(id, text) { if (typeof text === 'string') candidate(id)?.append(text); },
    snapshot(id, text) {
      if (typeof text !== 'string') return;
      const decoder = candidate(id); if (!decoder) return;
      if (!text.startsWith(decoder.raw)) {
        if (selected === id) throw new Error('Provider replaced a streamed answer snapshot.');
        decoder.disabled = true; return;
      }
      decoder.append(text.slice(decoder.raw.length));
    },
    check(envelope) {
      if (!emitted) return;
      const response = envelope?.response;
      if (!textOnly(envelope?.artifact) || request.toolRelay && response?.action !== 'message' ||
          typeof response?.text !== 'string' || response.text.replaceAll('\u001e', '\\u001e') !== emitted) {
        throw new Error('Final response differs from the answer already streamed.');
      }
    },
  };
}
