#!/usr/bin/env node

// Public-content sanitizer for the documentation site build.
// Adapted from the prometheus-skill-pack donor's check-public-docs.mjs
// forbidden-pattern approach, extended with this repo's rules.
//
// Scope: scan exactly what enters the site build — site/docs and site/src.
// No docs plugin instance points outside site/, so repo docs/ is not part of
// the build and is not scanned. If a plugin ever serves ../docs content, add
// that root here in the same commit.

import {readdir, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(scriptDir, '..');

const roots = [path.join(siteDir, 'docs'), path.join(siteDir, 'src')];

const scannable = /\.(md|mdx|js|jsx|ts|tsx|css)$/;

const forbidden = [
  {
    label: 'machine-local home path',
    pattern: new RegExp(
      `${escapeRegExp(`${os.homedir()}${path.sep}`)}|/Users/[^/\\s]+/|/home/[^/\\s]+/`,
      'g',
    ),
  },
  {
    label: 'literal bearer credential',
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9_-]{32,}/g,
  },
  {
    label: 'literal 32-byte private key field',
    pattern: /private[_-]?key\s*[:=]\s*["'][A-Za-z0-9+/_=-]{40,}["']/gi,
  },
  {
    label: 'PEM private key block',
    pattern: /BEGIN [A-Z ]*PRIVATE KEY/g,
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

const findings = [];
for (const root of roots) {
  for (const file of await scannableFiles(root)) {
    const content = await readFile(file, 'utf8');
    const relative = path.relative(siteDir, file);
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0;
      for (const match of content.matchAll(rule.pattern)) {
        const line = content.slice(0, match.index).split('\n').length;
        findings.push(`${relative}:${line}: ${rule.label}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Public documentation sanitizer rejected the following content:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Public documentation sanitizer passed.');

async function scannableFiles(root) {
  const entries = await readdir(root, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await scannableFiles(candidate)));
    else if (entry.isFile() && scannable.test(entry.name)) files.push(candidate);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
