import { assertMfsMutationPath } from "../core/config";
import type { HostFs } from "../core/host-bridge";
import { isMissingPathError, type KuboClient } from "../kubo";
import { writeFileToMfs } from "./chunked-write";
import type { PendingWrite } from "./diff";
import type { ManifestFile } from "./manifest";
import { runPool } from "./pool";
import { TransferFailedError, UnsafeTargetError } from "./publish-errors";

export interface TransferContext {
  readonly client: Pick<KuboClient, "filesWrite" | "filesStat" | "filesRm">;
  readonly fs: Pick<HostFs, "read" | "readRange">;
  /** `<mfsRoot>/current`: every write and removal must resolve inside it. */
  readonly currentPath: string;
  readonly concurrency?: number;
}

interface Target {
  readonly path: string;
  readonly target: string;
}

/**
 * Map a vault-relative path to its MFS path, or throw before any request is sent.
 * Rejects empty, absolute, `.`/`..` and backslash paths, anything the mvp-01 mutation guard
 * refuses (for example a `%` in the name), and anything that leaves `current/`.
 */
export function confinedTarget(currentPath: string, relative: string): string {
  const segments = relative.split("/");
  if (relative.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) throw new UnsafeTargetError(relative);
  const target = assertMfsMutationPath(`${currentPath}/${relative}`);
  if (!target.startsWith(`${currentPath}/`)) throw new UnsafeTargetError(relative);
  return target;
}

function targetsFor(currentPath: string, paths: readonly string[]): readonly Target[] {
  return paths.map((path) => ({ path, target: confinedTarget(currentPath, path) }));
}

function failWith(failures: readonly { readonly item: { readonly path: string }; readonly error: unknown }[]): never {
  throw new TransferFailedError(failures.map((f) => ({ path: f.item.path, error: f.error })));
}

/** Write every pending file (bounded pool, verified with files/stat) and return the manifest entry of each. */
export async function transferWrites(
  ctx: TransferContext,
  writes: readonly PendingWrite[],
): Promise<Readonly<Record<string, ManifestFile>>> {
  // Every target is validated before the first request, so an unsafe name fails the publish untouched.
  const jobs = writes.map((write) => ({ path: write.path, target: confinedTarget(ctx.currentPath, write.path), write }));
  const outcome = await runPool(
    jobs,
    async (job) => {
      const written = await writeFileToMfs(ctx.client, ctx.fs, job.path, job.target, job.write.size);
      return { sha256: job.write.sha256, size: written.size, cid: written.cid } satisfies ManifestFile;
    },
    ctx.concurrency,
  );
  if (outcome.failures.length > 0) failWith(outcome.failures);
  return Object.fromEntries(outcome.completed.map(({ item, value }) => [item.path, value] as const));
}

/** Remove files from `current/`. A file that is already gone counts as removed, so a rerun after a partial run converges. */
export async function transferRemovals(ctx: TransferContext, removed: readonly string[]): Promise<void> {
  const targets = targetsFor(ctx.currentPath, removed);
  const outcome = await runPool(
    targets,
    async ({ target }) => {
      try {
        await ctx.client.filesRm(target);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    },
    ctx.concurrency,
  );
  if (outcome.failures.length > 0) failWith(outcome.failures);
}
