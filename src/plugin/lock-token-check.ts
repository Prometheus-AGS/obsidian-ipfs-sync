import { decodeLock, type LockFile } from "../sync/publish-lock";

/**
 * A lock file that remembers the token of the record it created, so the holder can ask, at any moment, whether the file
 * on disk still carries it. The engine's `assertHeld` is synchronous and only knows the last heartbeat result; this is
 * the direct look at the file, used once right after the lock is taken and before the publish reaches the node.
 */
export interface TokenCheckedLockFile {
  readonly file: LockFile;
  /** True only when this file created a lock record and the lock file on disk still holds that record's token. */
  verifyHeld(): Promise<boolean>;
}

export function withTokenCheck(inner: LockFile): TokenCheckedLockFile {
  let token: string | undefined;
  const file: LockFile = {
    ...inner,
    createExclusive: async (bytes) => {
      const created = await inner.createExclusive(bytes);
      if (created) token = decodeLock(bytes)?.token;
      return created;
    },
  };
  return {
    file,
    verifyHeld: async () => {
      if (token === undefined) return false;
      const bytes = await inner.read();
      return bytes !== undefined && decodeLock(bytes)?.token === token;
    },
  };
}
