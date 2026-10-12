#!/usr/bin/env node

// Built-output guard for the documentation site.
//
// Local gates are the evidence; this script is the build's own output
// guard. It runs as `postbuild`, so every `npm run build` — local and the
// CI deploy build in .github/workflows/docs-pages.yml — scans the generated
// site/build/ tree and fails on findings, before any artifact upload. The
// workflow stays deployment-only: this check is part of the build, not a
// separate test step.
//
// Every file under build/ is scanned regardless of extension, read
// utf8-lossy so ASCII secret material in otherwise-binary assets is still
// caught. The forbidden patterns come from ./forbidden-patterns.mjs, shared
// with check-public-docs.mjs so the input and output scans never drift.

import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {forbidden} from './forbidden-patterns.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(scriptDir, '..', 'build');

if (!(await isDirectory(buildDir))) {
  console.error(`Built-output guard: ${buildDir} does not exist; run the build first.`);
  process.exit(1);
}

const findings = [];
for (const file of await allFiles(buildDir)) {
  const content = (await readFile(file)).toString('utf8');
  const relative = path.relative(buildDir, file);
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      const line = content.slice(0, match.index).split('\n').length;
      findings.push(`${relative}:${line}: ${rule.label}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Built-output guard rejected the following generated content:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Built-output guard passed.');

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
