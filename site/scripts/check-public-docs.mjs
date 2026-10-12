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
// docs/ and src/ are scanned by extension (source formats); static/ is
// scanned wholesale — every file regardless of extension, read utf8-lossy,
// so ASCII secret material embedded in an otherwise-binary asset is still
// caught. Forbidden patterns come from ./forbidden-patterns.mjs, shared
// with check-built-output.mjs so the input and output scans never drift.
//
// Generated-output scanning is the build's own gate: check-built-output.mjs
// runs as `postbuild` and scans site/build/ with the same patterns.
//
// Self-test: `node check-public-docs.mjs --self-test` plants one file per
// forbidden form in a temporary site tree and asserts the scanner names
// each one, then asserts a clean tree produces no findings. Wired into
// `npm run sanitize`, which the prebuild hook runs.

import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {forbidden} from './forbidden-patterns.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(scriptDir, '..');

// Source directories scanned recursively (extension-filtered), relative to
// the site root.
const scanDirs = ['docs', 'src'];

// static/ is published verbatim, so every file in it is scanned regardless
// of extension (utf8-lossy read).
const scanAllDirs = ['static'];

// Individual files scanned in full: Docusaurus serializes configuration
// into the client bundle, so these are publication inputs too.
const scanFiles = ['docusaurus.config.js', 'sidebars.js', 'package.json'];

const scannable = /\.(md|mdx|js|jsx|ts|tsx|css|json|html?|svg|txt|xml|ya?ml)$/;

async function collectFiles(base) {
  const files = [];
  for (const dir of scanDirs) {
    const root = path.join(base, dir);
    if (await isDirectory(root)) files.push(...(await scannableFiles(root)));
  }
  for (const dir of scanAllDirs) {
    const root = path.join(base, dir);
    if (await isDirectory(root)) files.push(...(await allFiles(root)));
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
    // Buffer.toString('utf8') decodes lossy (invalid sequences become
    // U+FFFD), which keeps ASCII secret material in binary assets visible
    // to the patterns.
    const content = (await readFile(file)).toString('utf8');
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
      // [relative path, content (string or Buffer), expected label]
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
        // Short Basic credential in header form (encodes "u:p"): below the
        // 32+ floor, caught by the no-floor header rule.
        'docs/basic-header-short.md',
        'Send `Authorization: Basic dTpw` with each request.',
        'basic authorization header',
      ],
      [
        // Short Basic credential in JSON form (8-character value): caught
        // by the authorization-field rule.
        'docs/basic-json-short.md',
        '{"authorization": "Basic dXNlcjpw"}',
        'basic credential in authorization field',
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
        // Bearer token inside a static HTML asset.
        'static/planted.html',
        `<html><script>const h = "Bearer ${longToken}";</script></html>`,
        'literal bearer/basic credential',
      ],
      [
        // Unlisted extension with a leading non-UTF8 byte: the lossy read
        // must still expose the ASCII home path.
        'static/planted.dat',
        Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('/Users/fixture-operator/secrets')]),
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

async function allFiles(root) {
  const entries = await readdir(root, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await allFiles(candidate)));
    else if (entry.isFile()) files.push(candidate);
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
