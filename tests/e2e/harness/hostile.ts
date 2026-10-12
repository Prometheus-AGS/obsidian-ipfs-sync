// Typed loader for the hostile-op runner of tools/feature-op-mvp-07/ (task 2.4, design decision 3): the suite invokes
// the existing `prepare-tamper` op through the feature operation's own `runHostile` entry — imported, never copied.
// The op runs as a child process of a bundle that buildHostileTools compiles from src/ (the test-only unwrap hook
// included) into the per-run temp dir; the suite process itself imports no src/. The child's rpc/gateway are the
// suite's loopback proxy, so every write the preparer makes is confined and audited by the proxy policy.
// tools/feature-op-mvp-07/*.mjs are outside the typecheck program, so the import is dynamic by file URL and cast to
// these interfaces — the same pattern as ./tools-07a.ts.
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SuiteRefusal } from "./run-context";

/** The answer of the `prepare-tamper` op (tools/feature-op-mvp-07/hostile-tools.mjs prepareTamper). */
export interface TamperPrepared {
  /** CID of the tampered root (the tamper directory). */
  readonly root: string;
  /** The vault-relative path whose blob carries the flipped bit. */
  readonly target: string;
  /** The tampered manifest's sequence (the genuine sequence plus the bump). */
  readonly sequence: number;
  /** The genuine manifest's sequence. */
  readonly sourceSequence: number;
  /** "complete-tree" (every blob copied, one flipped) or the default "single-blob" (only the flipped blob written). */
  readonly mode: string;
  /** How many blobs the preparer wrote into the tamper tree. */
  readonly blobsWritten: number;
}

/** The input of the `prepare-tamper` op; the op's writes all land at or below tamperDir. */
export interface PrepareTamperInput {
  readonly rpc: string;
  readonly gateway: string;
  readonly mfsRoot: string;
  readonly sourceRoot: string;
  readonly tamperDir: string;
  readonly passphraseFile: string;
  readonly bump: number;
  /** The complete-tree mode of the mvp-09 spec delta (2026-10-06): a full copy of the genuine tree with one blob flipped. */
  readonly completeTree?: boolean;
}

interface HostileToolsModule {
  readonly TAMPER_SEQUENCE_BUMP: number;
  buildHostileTools(work: string): Promise<{ hostile: string; cliYes: string }>;
  runHostile(options: {
    tools: { hostile: string };
    op: string;
    input: PrepareTamperInput;
    env: Record<string, string | undefined>;
    localStub?: boolean;
  }): Promise<unknown>;
}

export interface Hostile07 {
  /** The sequence bump the op applies (TAMPER_SEQUENCE_BUMP of the feature operation). */
  readonly sequenceBump: number;
  /**
   * Runs `prepare-tamper` as a child process with the scrubbed environment (the 07a childEnv allowlist, auth
   * variables kept). The bundle is built into `work` on first use; `work` must be the per-run temp dir or below.
   */
  prepareTamper(work: string, input: PrepareTamperInput, env: Record<string, string | undefined>): Promise<TamperPrepared>;
}

const isTamperPrepared = (value: unknown): value is TamperPrepared =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as TamperPrepared).root === "string" &&
  (value as TamperPrepared).root !== "" &&
  typeof (value as TamperPrepared).target === "string" &&
  (value as TamperPrepared).target !== "" &&
  typeof (value as TamperPrepared).sequence === "number" &&
  typeof (value as TamperPrepared).sourceSequence === "number" &&
  typeof (value as TamperPrepared).mode === "string" &&
  typeof (value as TamperPrepared).blobsWritten === "number";

const moduleFile = pathToFileURL(join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "feature-op-mvp-07"), "hostile-tools.mjs")).href;

let cached: Promise<Hostile07> | undefined;

export function loadHostile07(): Promise<Hostile07> {
  cached ??= (async (): Promise<Hostile07> => {
    const module = (await import(/* @vite-ignore */ moduleFile)) as HostileToolsModule;
    let tools: { hostile: string; cliYes: string } | undefined;
    return {
      sequenceBump: module.TAMPER_SEQUENCE_BUMP,
      async prepareTamper(work, input, env) {
        await mkdir(work, { recursive: true });
        tools ??= await module.buildHostileTools(work);
        const answer: unknown = await module.runHostile({ tools, op: "prepare-tamper", input, env, localStub: false });
        if (!isTamperPrepared(answer)) throw new SuiteRefusal("the prepare-tamper op answered in a shape the suite does not recognise");
        return answer;
      },
    };
  })();
  return cached;
}
