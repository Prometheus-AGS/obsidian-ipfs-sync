import { escapeForDisplay } from "./path-policy";
import { PublishRefusedError, lockHeld, lockLost, lockUnreadable } from "./publish-refusals";

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
   * read, then `write`. `isStopped` turns true once the holder has released: a file that honors it skips the replacement
   * (and removes its temporary file) instead of writing a lock the holder no longer owns, and returns false.
   */
  writeIfToken?(expectedToken: string, bytes: Uint8Array<ArrayBuffer>, isStopped?: () => boolean): Promise<boolean>;
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

/** The most a lock file may hold: a real record is a few hundred bytes. A larger file is not read as a lock record. */
export const LOCK_MAX_BYTES = 65_536;
/** The most of a host the record keeps (a DNS name is at most 255 characters); the rest is dropped, and the token still reads. */
export const LOCK_HOST_MAX = 255;

/** The record in a lock file, or undefined when the bytes are not a lock record (including a file over the size cap). */
export function decodeLock(bytes: Uint8Array): LockRecord | undefined {
  if (bytes.length > LOCK_MAX_BYTES) return undefined;
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { token, pid, host, time } = raw as Record<string, unknown>;
    if (typeof token !== "string" || token === "" || typeof host !== "string" || host === "") return undefined;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0 || typeof time !== "number" || !Number.isFinite(time)) return undefined;
    return { token, pid, host: host.slice(0, LOCK_HOST_MAX), time };
  } catch {
    return undefined;
  }
}

/** The longest host name `describeLock` shows, in characters (code points). The host is free text any writer of the lock file chose. */
export const LOCK_HOST_DISPLAY_MAX = 64;

/**
 * The host cut to `LOCK_HOST_DISPLAY_MAX` characters (marked when cut), then its backslashes and double quotes escaped, then the rest escaped with
 * the shared display table, and the whole in double quotes: the host cannot end its own quotes, so it cannot write the words that follow it. The
 * cut happens on a bounded prefix first (a character is at most two UTF-16 units), so a huge host is never split into characters whole.
 */
function displayHost(host: string): string {
  const prefix = host.slice(0, LOCK_HOST_DISPLAY_MAX * 2);
  const characters = Array.from(prefix);
  const cut = characters.length > LOCK_HOST_DISPLAY_MAX || prefix.length < host.length;
  const kept = characters.slice(0, LOCK_HOST_DISPLAY_MAX).join("");
  return `"${escapeForDisplay(kept.replace(/[\\"]/g, "\\$&"))}${cut ? "..." : ""}"`;
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
    // A file system that cannot create it again (no hard links) leaves the live lock where it is moved to: the same loud refusal, never a pass-through.
    const putBack = await file.createExclusive(moved.bytes).catch((error: unknown) => {
      if (error instanceof PublishRefusedError && error.code === "lock-unsupported") return false;
      throw error;
    });
    if (!putBack) throw lockHeld("a live lock was moved aside during a takeover and could not be put back; try again");
    await moved.discard();
    return false;
  }
  await moved.discard();
  if (!(await file.createExclusive(mine))) return false;
  return decodeLock(mine)?.token === (await readRecord(file)).record?.token;
}

interface Heartbeat {
  readonly held: () => boolean;
  /** Stop the timer and tell any beat in flight that it is stopped (it writes nothing more). */
  readonly stop: () => void;
  /** Resolves when every beat that was in flight has finished, so a release never races a rename. */
  readonly settled: () => Promise<void>;
}

function startHeartbeat(file: LockFile, ctx: LockContext, token: string): Heartbeat {
  let held = true;
  let stopped = false;
  let failure: unknown;
  let lastBeat = ctx.now();
  const inFlight = new Set<Promise<void>>();
  const beat = async (): Promise<void> => {
    try {
      const time = ctx.now();
      const bytes = encodeLock({ token, pid: ctx.pid, host: ctx.host, time });
      if (file.writeIfToken !== undefined) {
        if (!(await file.writeIfToken(token, bytes, () => stopped))) {
          if (!stopped) held = false;
          return;
        }
      } else {
        if ((await readRecord(file)).record?.token !== token) {
          if (!stopped) held = false;
          return;
        }
        if (stopped) return;
        await file.write(bytes);
      }
      if (stopped) return;
      // The read above and the replacing write are two steps: a taker may have replaced the file between them. Read once more.
      if ((await readRecord(file)).record?.token !== token) {
        if (!stopped) held = false;
        return;
      }
      lastBeat = time;
    } catch (error) {
      failure = error;
    }
  };
  const cancelTimer = ctx.every(LOCK_HEARTBEAT_MS, () => {
    const running = beat().finally(() => inFlight.delete(running));
    inFlight.add(running);
  });
  const lapsed = (): boolean => ctx.now() - lastBeat > 2 * LOCK_HEARTBEAT_MS;
  return {
    held: () => held && failure === undefined && !lapsed(),
    stop: () => {
      stopped = true;
      cancelTimer();
    },
    settled: async () => void (await Promise.all([...inFlight])),
  };
}

/**
 * Take the lock. Refuses (`lock-held`) while a live holder has a fresh heartbeat, and (`lock-unreadable`) when the
 * file exists but is not a lock record; a stale lock is replaced.
 */
export function acquirePublishLock(file: LockFile, ctx: LockContext): Promise<PublishLock> {
  return acquire(file, ctx, false);
}

/** `unreadableOnReadError`: a read of the existing file that throws (a directory, no permission) is `lock-unreadable`, not the raw error. Only abandon asks for it. */
async function acquire(file: LockFile, ctx: LockContext, unreadableOnReadError: boolean): Promise<PublishLock> {
  const token = ctx.newToken();
  const mine = encodeLock({ token, pid: ctx.pid, host: ctx.host, time: ctx.now() });
  if (!(await file.createExclusive(mine))) {
    const existing = await readRecord(file).catch((error: unknown) => {
      if (unreadableOnReadError) throw lockUnreadable();
      throw error;
    });
    if (existing.present && existing.record === undefined) throw lockUnreadable();
    if (existing.record === undefined || !isStaleLock(existing.record, ctx) || !(await takeOver(file, existing.record, mine))) {
      throw lockHeld(existing.record === undefined ? "the lock was just released; try again" : describeLock(existing.record, ctx.now()));
    }
  }
  const beat = startHeartbeat(file, ctx, token);
  let released = false;
  let heartbeatStopped = false;
  return {
    assertHeld: () => {
      if (!beat.held()) throw lockLost();
    },
    release: async () => {
      if (released) return;
      if (!heartbeatStopped) {
        heartbeatStopped = true;
        beat.stop();
      }
      // A beat that was mid-write finishes (or skips its rename) before the file is read, so it cannot write after the remove.
      await beat.settled();
      // Only a release that finished counts: one whose read or remove threw is tried again by the next call.
      const current = await readRecord(file);
      if (current.record?.token === token) await file.remove();
      released = true;
    },
  };
}

export interface AbandonLock {
  /** Undefined when the lock file could not be used and abandon runs without it. */
  readonly lock: PublishLock | undefined;
  readonly ranWithoutLock: boolean;
}

/** The description of the lock file's holder when it now holds a record that is not stale, else undefined (absent, junk, stale, or a read that throws). */
async function liveHolder(file: LockFile, ctx: LockContext): Promise<string | undefined> {
  try {
    const bytes = await file.read();
    const record = bytes === undefined ? undefined : decodeLock(bytes);
    return record !== undefined && !isStaleLock(record, ctx) ? describeLock(record, ctx.now()) : undefined;
  } catch {
    // A file that cannot be read cannot be shown to be a live holder's: it is the unreadable case, which abandon goes past.
    return undefined;
  }
}

/**
 * The lock for `abandon`, the escape hatch. A live lock held by another process is always refused (`lock-held`), however the
 * acquisition failed: a lock file that is unreadable (junk, over the size cap, a directory, no permission) or unsupported (no hard
 * links) must not trap the user, but the file is read once more first, and a record that decodes and is not stale is a live holder.
 * Only a lock that is still unreadable, absent or stale lets abandon go on without a lock, and it says so.
 * Anything else the acquisition throws is passed on unchanged.
 */
export async function acquireAbandonLock(file: LockFile, ctx: LockContext): Promise<AbandonLock> {
  try {
    return { lock: await acquire(file, ctx, true), ranWithoutLock: false };
  } catch (error) {
    if (error instanceof PublishRefusedError && (error.code === "lock-unreadable" || error.code === "lock-unsupported")) {
      const holder = await liveHolder(file, ctx);
      if (holder !== undefined) throw lockHeld(holder);
      return { lock: undefined, ranWithoutLock: true };
    }
    throw error;
  }
}

/** Release for a path whose outcome is already decided: a failure to release must never replace it, so it is swallowed (the error text is not read). */
export async function releaseQuietly(lock: PublishLock | undefined): Promise<void> {
  try {
    await lock?.release();
  } catch {
    // The abandon outcome stands; a stale lock file ages out or is cleared by --break-lock.
  }
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
