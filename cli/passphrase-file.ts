import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PASSPHRASE_INPUT_MAX_BYTES, wipe, type Bytes } from "../src/crypto";
import { PassphraseInputError } from "./passphrase-errors";

/** What the file checks need to know about the machine. Defaults come from the process; tests inject their own. */
export interface FileHost {
  readonly platform: NodeJS.Platform;
  /** The numeric user ID of this process; undefined where the platform has none. */
  readonly userId: number | undefined;
}

const OWNER_ONLY_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const GROUP_AND_OTHER_WRITE_BITS = 0o022;
const STICKY_BIT = 0o1000;
/** The passphrase plus a terminating CR LF. */
const FILE_CAP_BYTES = PASSPHRASE_INPUT_MAX_BYTES + 2;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export const NO_POSIX_MODES_WARNING =
  "this system has no POSIX file modes: the passphrase file's permissions cannot be verified; keep it where only you can read it";

/** POSIX mode and ownership checks apply on every platform except Windows. */
export function hasPosixModes(host: FileHost): boolean {
  return host.platform !== "win32";
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function unsafe(path: string, problem: string): PassphraseInputError {
  return new PassphraseInputError("file-unsafe", `the passphrase file "${path}" is refused: ${problem}`);
}

function unreadable(path: string, problem: string): PassphraseInputError {
  return new PassphraseInputError("file-unreadable", `the passphrase file "${path}" cannot be used: ${problem}`);
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/**
 * Open for reading without following a final symbolic link (POSIX). O_NONBLOCK makes opening a named pipe return at once,
 * so the regular-file check on the descriptor can refuse it instead of the open waiting for a writer. On Windows a link
 * is refused by `lstat` first.
 */
async function openForRead(path: string, host: FileHost) {
  if (!hasPosixModes(host)) {
    const link = await lstat(path).catch(() => undefined);
    if (link?.isSymbolicLink() === true) throw unsafe(path, "it is a symbolic link");
  }
  try {
    const posixFlags = hasPosixModes(host) ? (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) : 0;
    return await open(path, constants.O_RDONLY | posixFlags);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP") throw unsafe(path, "it is a symbolic link");
    if (code === "ENOENT") throw unreadable(path, "it does not exist");
    if (code === "EACCES" || code === "EPERM") throw unreadable(path, "access was denied");
    throw unreadable(path, "it could not be opened");
  }
}

/** Only a terminating line feed or carriage-return-line-feed is removed. */
export function stripTerminator(content: Uint8Array): Bytes {
  let end = content.length;
  if (end > 0 && content[end - 1] === LINE_FEED) {
    end -= 1;
    if (end > 0 && content[end - 1] === CARRIAGE_RETURN) end -= 1;
  }
  return content.slice(0, end);
}

/**
 * Read a passphrase file. The checks run on the opened descriptor, so nothing can change between the check and the
 * read. On POSIX systems the file must be a regular file (not reached through a symbolic link), owned by this user and
 * without any group or other permission bit; on Windows a symbolic link is refused and `warnings` says that
 * permissions cannot be verified. The caller wipes the result.
 */
export async function readPassphraseFile(path: string, host: FileHost): Promise<{ readonly bytes: Bytes; readonly warnings: readonly string[] }> {
  const handle = await openForRead(path, host);
  const buffer = new Uint8Array(FILE_CAP_BYTES + 1);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unsafe(path, "it is not a regular file");
    const warnings: string[] = [];
    if (hasPosixModes(host)) {
      if (host.userId !== undefined && info.uid !== host.userId) throw unsafe(path, "it is owned by another user");
      if ((info.mode & GROUP_AND_OTHER_BITS) !== 0) {
        throw unsafe(path, `its permissions (${formatMode(info.mode)}) allow group or other access; it must be 0600 or stricter (chmod 600)`);
      }
    } else {
      warnings.push(NO_POSIX_MODES_WARNING);
    }
    if (info.size > FILE_CAP_BYTES) throw unreadable(path, `it is longer than ${PASSPHRASE_INPUT_MAX_BYTES} bytes`);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FILE_CAP_BYTES) throw unreadable(path, `it is longer than ${PASSPHRASE_INPUT_MAX_BYTES} bytes`);
    return { bytes: stripTerminator(buffer.subarray(0, bytesRead)), warnings };
  } finally {
    wipe(buffer);
    await handle.close();
  }
}

/* ---------- creation, for `ipfs-sync init --passphrase-file` ---------- */

function targetRefused(path: string, problem: string): PassphraseInputError {
  return new PassphraseInputError("file-target", `will not write the passphrase file "${path}": ${problem}; nothing was written and nothing was sent to the node`);
}

const INTERRUPTED_INIT_HINT =
  "the path already exists. If it is left over from an init that was interrupted before the vault was created, delete it and run init again; if that init did create the vault, it holds the vault's passphrase, so keep it";

/**
 * The path must not exist at all (a symbolic link, even a dangling one, counts as existing). Its directory must be a real
 * directory (the last component is not a symbolic link; earlier ones may be, and are resolved with realpath), owned by this
 * user and, on POSIX systems, not writable by group or others unless it has the sticky bit. Nothing is created here.
 * Returns the resolved directory (symbolic links anywhere in its path are followed here and nowhere later), which the file is then created under.
 */
async function checkTarget(path: string, host: FileHost): Promise<string> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw targetRefused(path, "its state cannot be read");
  });
  if (existing !== undefined) throw targetRefused(path, existing.isSymbolicLink() ? "the path is a symbolic link" : INTERRUPTED_INIT_HINT);
  const directory = dirname(path);
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined) throw targetRefused(path, `its directory "${directory}" does not exist`);
  if (info.isSymbolicLink()) throw targetRefused(path, `its directory "${directory}" is a symbolic link`);
  if (!info.isDirectory()) throw targetRefused(path, `"${directory}" is not a directory`);
  const real = await realpath(directory).catch(() => undefined);
  if (real === undefined) throw targetRefused(path, `its directory "${directory}" cannot be resolved`);
  const resolved = real === directory ? info : await lstat(real).catch(() => undefined);
  if (resolved === undefined || !resolved.isDirectory()) throw targetRefused(path, `its directory "${directory}" cannot be resolved`);
  if (!hasPosixModes(host)) return real;
  if (host.userId !== undefined && resolved.uid !== host.userId) throw targetRefused(path, `its directory "${directory}" is owned by another user`);
  if ((resolved.mode & GROUP_AND_OTHER_WRITE_BITS) !== 0 && (resolved.mode & STICKY_BIT) === 0) {
    throw targetRefused(path, `its directory "${directory}" (${formatMode(resolved.mode)}) can be changed by group or others and has no sticky bit; chmod go-w it or choose another folder`);
  }
  return real;
}

/** The real path of `path`, or of its nearest existing ancestor with the missing tail appended: where a file that does not exist yet would land. */
async function landing(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const code = errorCode(error);
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) return join(current, ...missing);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Does the passphrase file (existing or about to be created) lie inside the vault folder? Compared on real paths, so a link into the vault
 * counts. A passphrase file in the vault is published with it by the next publish, or sits beside the notes it protects (review round 3, C-L4).
 */
export async function passphraseFileInsideVault(vaultRoot: string, filePath: string): Promise<boolean> {
  const root = await landing(vaultRoot);
  const file = await landing(filePath);
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuse a target that cannot be used, without creating anything. */
export async function assertPassphraseFileCreatable(path: string, host: FileHost): Promise<void> {
  await checkTarget(path, host);
}

/** Remove the file this run created. When its identity is known and the path now holds something else, that is not ours and stays. */
async function removeCreated(location: string, ours: { readonly dev: number; readonly ino: number } | undefined): Promise<void> {
  if (ours !== undefined) {
    const now = await lstat(location).catch(() => undefined);
    if (now === undefined || now.dev !== ours.dev || now.ino !== ours.ino) return;
  }
  await rm(location, { force: true }).catch(() => undefined);
}

/**
 * Create the file exclusively (it must not exist) with mode 0600 and write `content`. The file is created under the
 * directory as resolved once by `checkTarget`, and before any secret is written its mode is verified on the open descriptor
 * and its identity (device and inode) is compared with what `lstat` finds at the path; a mismatch means the folder was
 * swapped while the file was being created, and nothing is written. A file that ends up wider than 0600, or whose write
 * fails, is removed again. The absolute path as given is returned.
 *
 * Residual risk: Node has no `openat`, so the directory cannot be held open and the file is still opened by path. A
 * writer who can replace the folder between `realpath` and `open` can misplace the file (the mismatch check narrows this
 * and does not close it); the folder checks above refuse a folder that others can rewrite, which is what makes that
 * writer unlikely. Ancestors above the folder are resolved but not permission-checked.
 */
export async function createPassphraseFile(path: string, content: Uint8Array, host: FileHost): Promise<string> {
  const absolute = resolve(path);
  const location = join(await checkTarget(absolute, host), basename(absolute));
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(location, flags, OWNER_ONLY_MODE).catch((error: unknown) => {
    if (errorCode(error) === "EEXIST") throw targetRefused(absolute, "the path already exists");
    throw targetRefused(absolute, "it could not be created");
  });
  let ours: { readonly dev: number; readonly ino: number } | undefined;
  try {
    if (hasPosixModes(host)) {
      const created = await handle.stat();
      ours = { dev: created.dev, ino: created.ino };
      if ((created.mode & GROUP_AND_OTHER_BITS) !== 0) throw targetRefused(absolute, "the file system gave it permissions wider than 0600");
      const atPath = await lstat(location).catch(() => undefined);
      if (atPath === undefined || atPath.dev !== created.dev || atPath.ino !== created.ino) {
        throw targetRefused(absolute, "its folder changed while the file was being created");
      }
    }
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeCreated(location, ours);
    throw error;
  }
  await handle.close();
  return absolute;
}
