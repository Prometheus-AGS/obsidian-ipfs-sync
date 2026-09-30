import esbuild from "esbuild";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "process";
import { CLI_OUT, cliOptions, pluginOptions, pluginOutDir } from "./esbuild.options.mjs";

const prod = process.argv[2] === "production";

const PLUGIN_OUT_DIR = pluginOutDir(prod);
const pluginBuild = pluginOptions(prod, PLUGIN_OUT_DIR);
const cliBuild = cliOptions(prod);

// Obsidian loads the plugin only when manifest.json sits next to main.js.
await mkdir(PLUGIN_OUT_DIR, { recursive: true });
await copyFile("manifest.json", join(PLUGIN_OUT_DIR, "manifest.json"));

const contexts = await Promise.all([esbuild.context(pluginBuild), esbuild.context(cliBuild)]);

if (prod) {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await chmod(CLI_OUT, 0o755);
  await Promise.all(contexts.map((context) => context.dispose()));
} else {
  await Promise.all(contexts.map((context) => context.watch()));
}
