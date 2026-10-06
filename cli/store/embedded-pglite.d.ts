// Ambient declarations for the `embedded-pglite:` virtual modules that esbuild provides in the CLI bundle
// (embeddedPglitePlugin in esbuild.options.mjs, binary loader). Only the bundle resolves them; vitest and tsx
// run from source and never reach the importing module (cli/store/pglite-embedded-assets.ts, wired by cli/main.ts).
declare module "embedded-pglite:*" {
  // esbuild's binary loader decodes base64 into a fresh ArrayBuffer-backed Uint8Array.
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
