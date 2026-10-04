import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A synthetic project root for the release tool (tools/release/*): fixed file contents, a fixed git commit and a fixed
 * feature-operation result, so the plan text, the notes, the steps and the record are the same bytes on every run.
 * Nothing here reads the real repository, spawns a process or contacts a network.
 *
 * Erasable TypeScript only: the golden capture script loads this file with Node's type stripping.
 */
export const FIXTURE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const ROOT_PLACEHOLDER = "<ROOT>";
const CREATED_AT_PLACEHOLDER = "<CREATED_AT>";

const MANIFEST_BEFORE = `{
  "id": "ipfs-sync",
  "name": "IPFS Sync",
  "version": "0.1.0",
  "minAppVersion": "1.10.0",
  "description": "fixture",
  "isDesktopOnly": false
}
`;
const MANIFEST_BUMPED = MANIFEST_BEFORE.replace('"version": "0.1.0"', '"version": "0.2.0"').replace('"minAppVersion": "1.10.0"', '"minAppVersion": "1.12.3"');
const PACKAGE_BEFORE = `{
  "name": "ipfs-sync",
  "version": "0.1.0",
  "license": "MIT",
  "scripts": {
    "build": "node esbuild.config.mjs production"
  }
}
`;

export interface FixtureOptions {
  /** dist/plugin/manifest.json already carries the Release 1 version fields (needed by `record --no-build`). */
  readonly distBumped?: boolean;
  readonly styles?: boolean;
  readonly featureOp?: "passing" | "failing";
}

const put = (root: string, rel: string, content: string | Uint8Array): void => {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

/** Writes the fixture tree under an existing, empty directory. */
export function buildFixture(root: string, options: FixtureOptions = {}): void {
  put(root, "manifest.json", MANIFEST_BEFORE);
  put(root, "package.json", PACKAGE_BEFORE);
  put(root, "dist/plugin/main.js", 'console.log("plugin bundle fixture");\n');
  put(root, "dist/plugin/manifest.json", options.distBumped ? MANIFEST_BUMPED : MANIFEST_BEFORE);
  if (options.styles) put(root, "dist/plugin/styles.css", ".ipfs-sync { color: red; }\n");
  put(root, "dist/cli/ipfs-sync.mjs", '#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nimport { z } from "zod";\nconsole.log(typeof readFileSync, typeof z);\n');
  put(root, "feature-op-mvp-05.json", `${JSON.stringify(options.featureOp === "failing" ? { passed: false } : { passed: true, assertions: [{ name: "pull", passed: true }] })}\n`);
  put(root, "README.md", "# IPFS Sync\n\nThis release is fixture-only.\n");
  put(root, "CHANGELOG.md", "# Changelog\n\n## 0.2.0\n\nfixture-only pre-release.\n");
  put(root, "evidence/demo.txt", "pull with conflict demonstrated\n");
  put(root, ".git/HEAD", "ref: refs/heads/main\n");
  put(root, `.git/refs/heads/main`, `${FIXTURE_COMMIT}\n`);
  put(root, ".git/config", '[remote "origin"]\n\turl = git@github.com:Prometheus-AGS/obsidian-ipfs-sync.git\n');
}

export const normalizeText = (text: string, root: string): string => text.split(root).join(ROOT_PLACEHOLDER);

/** Every file under `dir`, keyed by relative path; text files are normalized, binary files are returned as bytes. */
export function snapshotDirectory(dir: string, root: string): Record<string, string | Uint8Array> {
  const result: Record<string, string | Uint8Array> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.name.endsWith(".tgz")) result[rel] = readFileSync(join(current, entry.name));
      else {
        const text = normalizeText(readFileSync(join(current, entry.name), "utf8"), root);
        result[rel] = entry.name === "evidence.json" ? text.replace(/"createdAt": "[^"]*"/, `"createdAt": "${CREATED_AT_PLACEHOLDER}"`) : text;
      }
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return result;
}

export const GOLDEN_DIR = new URL("../golden/release-1/", import.meta.url).pathname;
