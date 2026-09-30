// Build-time import probe (mvp-01 task 3.4).
// Bundles src/kubo + src/core for the Obsidian WebView target using the plugin's own esbuild
// settings, then fails if anything Node-only (built-in modules, node: imports) is imported.
// Usage: node tools/webview-import-probe.mjs
import { gzipSync } from "node:zlib";
import process from "node:process";
import esbuild from "esbuild";
import builtins from "builtin-modules";
import { checkDistBundles, checkHookIsolation, lintTestingImports } from "./hook-isolation.mjs";

const ALLOWED_EXTERNALS = new Set(["obsidian", "electron"]);

// kubo-client-lite: src/kubo together with src/core must stay under 60 KB before minification.
const KUBO_CORE_LIMIT_BYTES = 60 * 1024;

const common = {
  bundle: true,
  external: ["obsidian", "electron", "node:*", ...builtins],
  format: "cjs",
  target: "es2022",
  logLevel: "silent",
  treeShaking: true,
  write: false,
  metafile: true,
};

async function bundle(options) {
  const result = await esbuild.build({ ...common, ...options });
  const [output] = result.outputFiles;
  const externals = Object.values(result.metafile.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path);
  return { bytes: output.contents.length, gzip: gzipSync(output.contents).length, externals: [...new Set(externals)] };
}

const baseline = await bundle({ entryPoints: ["src/main.ts"], outfile: "main.js" });
const probe = await bundle({ entryPoints: ["tools/webview-probe-entry.ts"], outfile: "probe.js" });
const kuboCore = await bundle({ entryPoints: ["tools/webview-probe-kubo-core-entry.ts"], outfile: "kubo-core.js" });
const cryptoProbe = await bundle({ entryPoints: ["tools/webview-probe-crypto-entry.ts"], outfile: "crypto.js" });
const combined = await bundle({
  stdin: {
    contents: 'import "./src/main"; import "./tools/webview-probe-entry"; import "./tools/webview-probe-crypto-entry";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: "combined.js",
});

const offenders = [...probe.externals, ...kuboCore.externals, ...cryptoProbe.externals, ...combined.externals].filter((p) => !ALLOWED_EXTERNALS.has(p));
const report = {
  target: "browser/cjs/es2022 (same as the plugin bundle, unminified)",
  pluginMainBytes: baseline.bytes,
  kuboCoreBytes: kuboCore.bytes,
  kuboCoreGzipBytes: kuboCore.gzip,
  kuboCoreLimitBytes: KUBO_CORE_LIMIT_BYTES,
  cryptoBytes: cryptoProbe.bytes,
  cryptoGzipBytes: cryptoProbe.gzip,
  probeBytes: probe.bytes,
  probeGzipBytes: probe.gzip,
  combinedBytes: combined.bytes,
  deltaBytes: combined.bytes - baseline.bytes,
  deltaGzipBytes: combined.gzip - baseline.gzip,
  externalImports: probe.externals,
  nodeBuiltinImports: offenders,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (offenders.length > 0) {
  process.stderr.write(`FAIL: Node-only imports reached the WebView bundle: ${offenders.join(", ")}\n`);
  process.exit(1);
}
if (kuboCore.bytes >= KUBO_CORE_LIMIT_BYTES) {
  process.stderr.write(`FAIL: src/kubo + src/core is ${kuboCore.bytes} bytes, limit ${KUBO_CORE_LIMIT_BYTES}\n`);
  process.exit(1);
}
process.stdout.write("PASS: no Node built-in imports in the WebView bundle; src/kubo + src/core under the size limit\n");

// Test-only crypto hooks (src/crypto/testing) must be in no shipped bundle (mvp-06 task 2.4).
const isolation = await checkHookIsolation();
const importOffences = await lintTestingImports();
// Emitted artifacts of the last production build (if any): the release script must also run this and require `missing` to be empty.
const dist = await checkDistBundles();
process.stdout.write(`${JSON.stringify({ hookIsolation: { ok: isolation.ok, graphs: isolation.graphs, sentinels: isolation.sentinels.map((s) => s.file), importOffences, dist } }, null, 2)}\n`);
if (!isolation.ok || importOffences.length > 0 || !dist.ok) {
  process.stderr.write(`FAIL: test-only crypto hooks reached shipped code: ${[...isolation.violations, ...importOffences, ...dist.violations].join("; ")}\n`);
  process.exit(1);
}
process.stdout.write("PASS: no test-only crypto hook (sentinel, dependency metadata, imports) in the plugin, CLI or crypto surface\n");
