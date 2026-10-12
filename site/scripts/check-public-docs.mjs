#!/usr/bin/env node

// Public-content sanitizer for the documentation site build.
// Adapted from the prometheus-skill-pack donor's check-public-docs.mjs
// forbidden-pattern approach, extended with this repo's rules.
//
// Scope: scan everything that enters the site build — site/docs, site/src,
// site/static (published verbatim), and the configuration Docusaurus
// serializes into the client bundle (docusaurus.config.js, sidebars.js,
// package.json). No docs plugin instance points outside site/, so repo
// docs/ is not part of the build and is not scanned. If a plugin ever
// serves ../docs content, add that root here in the same commit.
//
// Built-output scanning (grepping the generated build/ for home paths and
// private keys) is covered by the skill's verify.mjs —
// ~/.kimi-code/skills/build-branded-docusaurus/scripts/verify.mjs — which
// runs as a separate gate. Referenced here, not reimplemented.
//
// Self-test: `node check-public-docs.mjs --self-test` plants one file per
// forbidden form in a temporary site tree and asserts the scanner names
// each one, then asserts a clean tree produces no findings. Wired into
// `npm run sanitize`, which the prebuild hook runs.

import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(scriptDir, '..');

// Directories scanned recursively, relative to the site root.
const scanDirs = ['docs', 'src', 'static'];

// Individual files scanned in full: Docusaurus serializes configuration
// into the client bundle, so these are publication inputs too.
const scanFiles = ['docusaurus.config.js', 'sidebars.js', 'package.json'];

const scannable = /\.(md|mdx|js|jsx|ts|tsx|css|json|html?|svg|txt|xml|ya?ml)$/;

const forbidden = [
  {
    label: 'machine-local home path',
    pattern: new RegExp(
      `${escapeRegExp(`${os.homedir()}${path.sep}`)}|/Users/[^/\\s]+/|/home/[^/\\s]+/`,
      'g',
    ),
  },
  {
    // Bearer or basic credentials in any representation: an HTTP header
    // (`Authorization: Bearer …`) or a JSON field (`"authorization":
    // "Bearer …"`) — the scheme word followed by a long token catches both,
    // case-insensitive on the scheme.
    label: 'literal bearer/basic credential',
    pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9_\-.+/=]{32,}/gi,
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

async function collectFiles(base) {
  const files = [];
  for (const dir of scanDirs) {
    const root = path.join(base, dir);
    if (await isDirectory(root)) files.push(...(await scannableFiles(root)));
  }
  for (const name of scanFiles) {
    const file = path.join(base, name);
    if (await isFile(file)) files.push(file);
  }
  return files;
}

async function scan(base) {
  const findings = [];
  for (const file of await collectFiles(base)) {
    const content = await readFile(file, 'utf8');
    const relative = path.relative(base, file);
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0;
      for (const match of content.matchAll(rule.pattern)) {
        const line = content.slice(0, match.index).split('\n').length;
        findings.push(`${relative}:${line}: ${rule.label}`);
      }
    }
  }
  return findings;
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  const findings = await scan(siteDir);
  if (findings.length > 0) {
    console.error('Public documentation sanitizer rejected the following content:');
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log('Public documentation sanitizer passed.');
}

async function selfTest() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'check-public-docs-'));
  try {
    const longToken = 'abcdef0123456789abcdef0123456789abcdef0123456789';
    const longKey = '0123456789abcdef0123456789abcdef0123456789abcdef01';
    const plants = [
      // [relative path, content, expected label]
      [
        'docs/bearer-json.md',
        `Config sample: {"authorization": "Bearer ${longToken}"}`,
        'literal bearer/basic credential',
      ],
      [
        'docs/bearer-header.md',
        `authorization: basic ${longToken}`,
        'literal bearer/basic credential',
      ],
      [
        'static/private-key.json',
        `{"private_key": "${longKey}"}`,
        'literal 32-byte private key field',
      ],
      [
        'static/private-key-camel.json',
        `{"privateKey": "${longKey}"}`,
        'literal 32-byte private key field',
      ],
      [
        'static/pem.txt',
        `-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIExample\n-----END EC PRIVATE KEY-----`,
        'PEM private key block',
      ],
      [
        'docs/home-path.md',
        'The vault lived at /Users/fixture-operator/notes on that machine.',
        'machine-local home path',
      ],
      [
        'docs/keyslots.md',
        'Do not publish keyslots.f6720bcd22c0ded6.json.',
        'device keyslot file reference',
      ],
      [
        'docs/clean.md',
        'A clean page. Bearer tokens are discussed by name only, with no value.',
        null,
      ],
    ];
    for (const [relative, content] of plants) {
      const target = path.join(fixtureRoot, relative);
      await mkdir(path.dirname(target), {recursive: true});
      await writeFile(target, content);
    }

    const findings = await scan(fixtureRoot);
    const failures = [];
    for (const [relative, , label] of plants) {
      const hits = findings.filter((f) => f.startsWith(`${relative}:`));
      if (label === null) {
        if (hits.length > 0) failures.push(`${relative}: expected clean, got ${hits.join('; ')}`);
      } else if (!hits.some((f) => f.endsWith(`: ${label}`))) {
        failures.push(`${relative}: expected "${label}", got ${hits.length > 0 ? hits.join('; ') : 'no finding'}`);
      }
    }
    if (failures.length > 0) {
      console.error('Sanitizer self-test FAILED:');
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }

    // A tree holding only clean content must produce zero findings.
    const cleanRoot = await mkdtemp(path.join(os.tmpdir(), 'check-public-docs-clean-'));
    try {
      await mkdir(path.join(cleanRoot, 'docs'), {recursive: true});
      await writeFile(path.join(cleanRoot, 'docs/clean.md'), 'Nothing forbidden here.\n');
      await writeFile(path.join(cleanRoot, 'package.json'), '{"name": "clean"}\n');
      const cleanFindings = await scan(cleanRoot);
      if (cleanFindings.length > 0) {
        console.error('Sanitizer self-test FAILED: clean tree produced findings:');
        for (const finding of cleanFindings) console.error(`- ${finding}`);
        process.exit(1);
      }
    } finally {
      await rm(cleanRoot, {recursive: true, force: true});
    }

    console.log(`Sanitizer self-test passed (${plants.filter(([, , l]) => l !== null).length} planted forbidden forms named; clean tree clean).`);
  } finally {
    await rm(fixtureRoot, {recursive: true, force: true});
  }
}

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

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
