import fsBundleBytes from "embedded-pglite:pglite.data";
import initdbWasmBytes from "embedded-pglite:initdb.wasm";
import pgliteWasmBytes from "embedded-pglite:pglite.wasm";
import type { PGliteOptions } from "@electric-sql/pglite";

/**
 * The PGlite runtime assets embedded in the single-file CLI bundle: the fsBundle tarball (the postgres data
 * directory template), the main wasm module, and the initdb wasm module, which PGlite still runs when it opens
 * an empty data directory. Reachable only from the esbuild CLI build — the `embedded-pglite:` specifiers exist
 * solely as the virtual modules of embeddedPglitePlugin in esbuild.options.mjs, and the bundle's entry point
 * (cli/main.ts) is the only importer; never import this module from code that vitest or tsx executes.
 */
export async function embeddedPgliteOptions(): Promise<PGliteOptions> {
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(pgliteWasmBytes),
    WebAssembly.compile(initdbWasmBytes),
  ]);
  return { fsBundle: new Blob([fsBundleBytes]), pgliteWasmModule, initdbWasmModule };
}
