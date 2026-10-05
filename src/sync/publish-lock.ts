import { escapeForDisplay } from "./path-policy";
import { lockHeld, lockLost, lockUnreadable } from "./publish-refusals";

/**
 * Cross-process publish lock: one lock file in the vault's `.ipfs-sync/` folder, created exclusively, holding a
 * random token, the process id, the host and the time of the last heartbeat. The holder refreshes the heartbeat
 * every 60 seconds. A lock is stale when its recorded process is not alive on this same host (a crashed publisher
 * is replaced at once), or when it has had no heartbeat for 15 minutes on any host (a lock from another host
 * cannot be probed, so time is the only signal there). A lock whose process is alive here, or from another host
 * with a fresh heartbeat, is never taken over. A documented `--break-lock` removes it after a confirmation.
 *
 * "Same host and the process is dead" trusts the host name. Two machines or containers that share a synchronised
 * `.ipfs-sync/` folder and report the same host name (`localhost`, `ubuntu`) can misjudge each other's live lock as
 * stale, and a reused process id can make a dead holder look alive. The lock adds no per-installation identifier
 * (out of scope for this change): synchronising `.ipfs-sync/` with a third-party tool is documented as unsupported.
 *
 * Before every write the holder calls `assertHeld`, which fails when the file changed hands or the last successful
 * heartbeat is older than twice the heartbeat interval (a laptop that slept past the stale window must not resume writing).
 *
 * This is a best-effort guard, not an atomic lock across machines: two devices that sync the `.ipfs-sync/`
 * folder through a third party, or a network file system without exclusive create, can both believe they hold
 * it. The plugin keeps its in-process lock as well. The file names no vault path and no secret.
 */

export const LOCK_HEARTBEAT_MS = 60_000;
export const LOCK_STALE_MS = 15 * 60_000;

/** The single lock file, however the host stores it. `createExclusive` must fail (false) if the file exists and must never expose a partly written file. */
export interface LockFile {
  createExclusive(bytes: Uint8Array<ArrayBuffer>): Promise<boolean>;
  read(): Promise<Uint8Array<ArrayBuffer> | undefined>;
  /** Replace the contents of the existing file. */
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /**
   * Replace the contents only if the file currently holds a lock with `expectedToken`; false (file untouched) otherwise.
   * The check runs immediately before the replacement, so the read-then-replace window is a few system calls, not a whole
   * heartbeat. Where the file system offers no atomic compare-and-replace (POSIX rename does not) the window is narrowed,
   * not closed; the token re-read after the write still detects a lost race. Optional: a host without it falls back to
   * read, then `write`.
   */
  writeIfToken?(expectedToken: string, bytes: Uint8Array<ArrayBuffer>): Promise<boolean>;
  remove(): Promise<void>;
  /**
   * Move the lock file to a unique name that only the caller knows and return its bytes, or undefined when there was
   * no lock file. Of several callers that saw the same file, only one gets it. `discard` deletes the moved file.
   */
  moveAside(): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; discard(): Promise<void> } | undefined>;
}

export interface LockContext {
  now(): number;
  readonly pid: number;
  readonly host: string;
  newToken(): string;
  /** Is `pid` a live process on this host? Only asked about locks recorded on the same host. */
  isProcessAlive(pid: number): boolean;
  /** Run `task` every `ms` until the returned function is called. */
  every(ms: number, task: () => void): () => void;
}

export interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  /** Milliseconds since the epoch of the last heartbeat. */
  readonly time: number;
}

export function encodeLock(record: LockRecord): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify({ host: record.host, pid: record.pid, time: record.time, token: record.token })}\n`);
}

/** The record in a lock file, or undefined when the bytes are not a lock record. */
export function decodeLock(bytes: Uint8Array): LockRecord | undefined {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { token, pid, host, time } = raw as Record<string, unknown>;
    if (typeof token !== "string" || token === "" || typeof host !== "string" || host === "") return undefined;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0 || typeof time !== "number" || !Number.isFinite(time)) return undefined;
    return { token, pid, host, time };
  } catch {
    return undefined;
  }
}

/** The longest host name `describeLock` shows, in characters (code points). The host is free text any writer of the lock file chose. */
export const LOCK_HOST_DISPLAY_MAX = 64;

/** The host cut to `LOCK_HOST_DISPLAY_MAX` characters (marked when cut), then escaped with the shared display table. */
function displayHost(host: string): string {
  const characters = Array.from(host);
  const cut = characters.length > LOCK_HOST_DISPLAY_MAX;
  return `${escapeForDisplay(cut ? characters.slice(0, LOCK_HOST_DISPLAY_MAX).join("") : host)}${cut ? "..." : ""}`;
}

/** Fixed-format facts for a message: process id, host name (cut and escaped) and age. The token is never shown. */
export function describeLock(record: LockRecord, now: number): string {
  const seconds = Math.max(0, Math.round((now - record.time) / 1000));
  return `process ${record.pid} on ${displayHost(record.host)}, last heartbeat ${seconds} s ago`;
}

export function isStaleLock(record: LockRecord, ctx: Pick<LockContext, "now" | "host" | "isProcessAlive">): boolean {
  if (record.host === ctx.host && !ctx.isProcessAlive(record.pid)) return true;
  return ctx.now() - record.time >= LOCK_STALE_MS;
}

export interface PublishLock {
  /** Throws `lock-lost` if the file was taken over or removed, or a heartbeat could not be written. Call before each write to the node. */
  assertHeld(): void;
  /** Stop the heartbeat and remove the file if it is still ours. Safe to call twice. */
  release(): Promise<void>;
}

async function readRecord(file: LockFile): Promise<{ readonly present: boolean; readonly record: LockRecord | undefined }> {
  const bytes = await file.read();
  return bytes === undefined ? { present: false, record: undefined } : { present: true, record: decodeLock(bytes) };
}

/**
 * Replace a stale lock. The file is renamed aside first, so of two takers that saw the same stale token only one moves
 * it; the other finds nothing, or finds a fresh lock, which it puts back. The moved file's token is checked, ours is created
 * exclusively, and the token read back is checked once more.
 */
async function takeOver(file: LockFile, stale: LockRecord, mine: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const moved = await file.moveAside();
  if (moved === undefined) return false;
  if (decodeLock(moved.bytes)?.token !== stale.token) {
    // We moved a lock that is not the stale one (its holder just replaced it): put it back. If a third party created a lock
    // in the gap, the moved file is the only copy of a live holder's lock: keep it aside (no discard) and refuse loudly.
    if (!(await file.createExclusive(moved.bytes))) throw lockHeld("a live lock was moved aside during a takeover and could not be put back; try again");
    await moved.discard();
    return false;
  }
  await moved.discard();
  if (!(await file.createExclusive(mine))) return false;
  return decodeLock(mine)?.token === (await readRecord(file)).record?.token;
}

function startHeartbeat(file: LockFile, ctx: LockContext, token: string): { readonly held: () => boolean; readonly stop: () => void } {
  let held = true;
  let failure: unknown;
  let lastBeat = ctx.now();
  const beat = async (): Promise<void> => {
    try {
      const time = ctx.now();
      const bytes = encodeLock({ token, pid: ctx.pid, host: ctx.host, time });
      if (file.writeIfToken !== undefined) {
        if (!(await file.writeIfToken(token, bytes))) {
          held = false;
          return;
        }
      } else {
        if ((await readRecord(file)).record?.token !== token) {
          held = false;
          return;
        }
        await file.write(bytes);
      }
      // The read above and the replacing write are two steps: a taker may have replaced the file between them. Read once more.
      if ((await readRecord(file)).record?.token !== token) {
        held = false;
        return;
      }
      lastBeat = time;
    } catch (error) {
      failure = error;
    }
  };
  const stop = ctx.every(LOCK_HEARTBEAT_MS, () => void beat());
  const lapsed = (): boolean => ctx.now() - lastBeat > 2 * LOCK_HEARTBEAT_MS;
  return { held: () => held && failure === undefined && !lapsed(), stop };
}

/**
 * Take the lock. Refuses (`lock-held`) while a live holder has a fresh heartbeat, and (`lock-unreadable`) when the
 * file exists but is not a lock record; a stale lock is replaced.
 */
export async function acquirePublishLock(file: LockFile, ctx: LockContext): Promise<PublishLock> {
  const token = ctx.newToken();
  const mine = encodeLock({ token, pid: ctx.pid, host: ctx.host, time: ctx.now() });
  if (!(await file.createExclusive(mine))) {
    const existing = await readRecord(file);
    if (existing.present && existing.record === undefined) throw lockUnreadable();
    if (existing.record === undefined || !isStaleLock(existing.record, ctx) || !(await takeOver(file, existing.record, mine))) {
      throw lockHeld(existing.record === undefined ? "the lock was just released; try again" : describeLock(existing.record, ctx.now()));
    }
  }
  const beat = startHeartbeat(file, ctx, token);
  let released = false;
  return {
    assertHeld: () => {
      if (!beat.held()) throw lockLost();
    },
    release: async () => {
      if (released) return;
      released = true;
      beat.stop();
      const current = await readRecord(file);
      if (current.record?.token === token) await file.remove();
    },
  };
}

export type BreakLockOutcome = "no-lock" | "removed" | "declined";

/**
 * `--break-lock`: describe the lock that is there and remove it only after `confirm` says yes. A run that
 * cannot ask must pass a `confirm` that returns false.
 */
export async function breakPublishLock(file: LockFile, now: () => number, confirm: (description: string) => Promise<boolean>): Promise<BreakLockOutcome> {
  const existing = await readRecord(file);
  if (!existing.present) return "no-lock";
  const description = existing.record === undefined ? "a lock file that cannot be read" : describeLock(existing.record, now());
  if (!(await confirm(description))) return "declined";
  await file.remove();
  return "removed";
}
