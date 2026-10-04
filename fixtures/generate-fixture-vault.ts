import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { FIXTURE_MARKER, FIXTURE_MARKER_VALUE } from "../src/sync/fixture-constants.ts";

/**
 * Synthetic vault generator (spec fixture-vault). Everything written here is
 * generated text or bytes from a seeded PRNG; nothing is read from the machine.
 * Run: `pnpm fixture:generate <dir> [--seed <n>]`.
 */

export interface FixtureFile {
  /** Vault-relative path with `/` separators. */
  readonly path: string;
  readonly data: Uint8Array;
}

export const DEFAULT_SEED = 20260930;

const WORDS = ["harbor", "lantern", "meadow", "quartz", "ember", "willow", "signal", "orbit", "cobalt", "thistle", "ripple", "anvil"];

/** mulberry32: small, fast, deterministic. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(random: () => number): string {
  const words = Array.from({ length: 8 }, () => WORDS[Math.floor(random() * WORDS.length)] ?? "word");
  return `${words.join(" ")}.`;
}

function note(random: () => number, title: string, paragraphs: number): Uint8Array {
  const body = Array.from({ length: paragraphs }, () => sentence(random)).join("\n\n");
  return new TextEncoder().encode(`# ${title}\n\n${body}\n`);
}

function bytes(random: () => number, length: number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

/** The exact file set for a seed: at least 10 published files in 3 folders, a binary, excluded paths and the marker. */
export function fixtureFiles(seed: number = DEFAULT_SEED): readonly FixtureFile[] {
  const random = createRandom(seed);
  const text = (path: string, title: string, paragraphs = 3): FixtureFile => ({ path, data: note(random, title, paragraphs) });
  return [
    text("notes/welcome.md", "Welcome"),
    text("notes/daily/2026-01-01.md", "Daily 2026-01-01"),
    text("notes/daily/2026-01-02.md", "Daily 2026-01-02"),
    text("notes/daily/2026-01-03.md", "Daily 2026-01-03"),
    text("projects/alpha/plan.md", "Alpha plan", 5),
    text("projects/alpha/tasks.md", "Alpha tasks"),
    text("projects/beta/readme.md", "Beta"),
    text("reference/glossary.md", "Glossary", 6),
    text("reference/links.md", "Links", 2),
    text("inbox.md", "Inbox", 1),
    { path: "attachments/diagram.bin", data: bytes(random, 4096) },
    { path: ".obsidian/app.json", data: new TextEncoder().encode('{"promptDelete":false}\n') },
    { path: ".obsidian/workspace.json", data: new TextEncoder().encode('{"main":{"id":"fixture"}}\n') },
    text(".trash/old-note.md", "Deleted note", 1),
    { path: FIXTURE_MARKER, data: new TextEncoder().encode(`${FIXTURE_MARKER_VALUE}\n`) },
  ];
}

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hasMarker(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, FIXTURE_MARKER))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class FixtureTargetError extends Error {
  constructor(dir: string) {
    super(`refusing to write into "${dir}": it is not empty and has no ${FIXTURE_MARKER} marker`);
    this.name = "FixtureTargetError";
  }
}

/** Write the fixture vault. Refuses a non-empty directory unless it already carries the marker. */
export async function writeFixtureVault(dir: string, seed: number = DEFAULT_SEED): Promise<readonly FixtureFile[]> {
  if ((await hasEntries(dir)) && !(await hasMarker(dir))) throw new FixtureTargetError(dir);
  const files = fixtureFiles(seed);
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }
  return files;
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], options: { seed: { type: "string" } }, allowPositionals: true });
  const [dir, ...extra] = positionals;
  if (dir === undefined || extra.length > 0) {
    process.stderr.write("usage: pnpm fixture:generate <dir> [--seed <n>]\n");
    return 2;
  }
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  if (!Number.isInteger(seed)) {
    process.stderr.write(`--seed must be an integer, got "${values.seed}"\n`);
    return 2;
  }
  try {
    const files = await writeFixtureVault(dir, seed);
    process.stdout.write(`wrote ${files.length} fixture files to ${dir} (seed ${seed})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
