// Shared forbidden-pattern list for the documentation site's public-content
// gates. Imported by check-public-docs.mjs (publication inputs) and
// check-built-output.mjs (generated output) so the two scans can never
// drift apart.

import os from 'node:os';
import path from 'node:path';

export const forbidden = [
  {
    label: 'machine-local home path',
    pattern: new RegExp(
      `${escapeRegExp(`${os.homedir()}${path.sep}`)}|/Users/[^/\\s]+/|/home/[^/\\s]+/`,
      'g',
    ),
  },
  {
    // Bearer or basic credentials with a long token, in any representation
    // (HTTP header, JSON field, YAML): the scheme word followed by a 32+
    // character token. The floor keeps prose such as "Use Bearer or Basic
    // on a phone" from matching; short Basic credentials are caught by the
    // scheme-specific rules below, which require the authorization
    // header/field context.
    label: 'literal bearer/basic credential',
    pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9_\-.+/=]{32,}/gi,
  },
  {
    // Basic credentials are often short (`Basic dXNlcjpwYXNz` encodes
    // "user:pass"), so the 32+ floor above misses them. This rule requires
    // the authorization header or JSON field context (`Authorization:
    // Basic …`, `"authorization": "Basic …"`) and accepts any plausible
    // base64 value of 8+ characters, case-insensitive.
    label: 'basic credential in authorization field',
    pattern: /["']?authorization["']?\s*[:=]\s*["']?\s*basic\s+[A-Za-z0-9+/=]{8,}["']?/gi,
  },
  {
    // Header form with no length floor: `Authorization: Basic <value>`.
    label: 'basic authorization header',
    pattern: /\bauthorization\s*:\s*basic\s+[A-Za-z0-9+/=]+/gi,
  },
  {
    // Private-key fields in JSON or config form: the key name may itself be
    // quoted (`"private_key": "…"`, `"privateKey": "…"`), and the value must
    // be a quoted string of 40+ characters.
    label: 'literal 32-byte private key field',
    pattern: /["']?private[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{40,}["']/gi,
  },
  {
    label: 'PEM private key block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    label: 'raw private wiki path',
    pattern: /\.prometheus\/knowledge\/wiki\/[^\s)`]+/g,
  },
  {
    label: 'device keyslot file reference',
    pattern: /\bkeyslots\.[A-Za-z0-9_-]+\.json/g,
  },
  {
    label: 'device state file reference',
    pattern: /\bstate\.[a-f0-9]{8,}\.json/gi,
  },
  {
    label: 'node-access command (kubectl)',
    pattern: /\bkubectl\b/g,
  },
  {
    label: 'node-access context (know-me)',
    pattern: /know-me/g,
  },
  {
    label: 'node-access namespace (ipfs-0)',
    pattern: /ipfs-0/g,
  },
];

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
