import { isIP } from 'node:net';

/** Bind on Docker's host interface while retaining the existing bridge key/options. */
export function configureUbuntuHost(source, gateway) {
  if (typeof gateway !== 'string' || isIP(gateway) !== 4 || gateway.startsWith('127.') || gateway === '0.0.0.0') {
    throw new Error('Docker must provide a non-loopback IPv4 gateway for its default bridge.');
  }
  const pattern = /^[ \t]*BRIDGE_HOST[ \t]*=.*$/gm;
  const matches = source.match(pattern) ?? [];
  if (matches.length > 1) throw new Error('Duplicate BRIDGE_HOST entries in .env; keep only one before setup:ubuntu.');
  return matches.length ? source.replace(pattern, `BRIDGE_HOST=${gateway}`)
    : source + (source.endsWith('\n') ? '' : '\n') + `BRIDGE_HOST=${gateway}\n`;
}
