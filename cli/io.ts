/** Output seam for the CLI. Production writes to the process streams; tests capture. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export function createProcessIo(): CliIo {
  return {
    out: (text) => {
      process.stdout.write(`${text}\n`);
    },
    err: (text) => {
      process.stderr.write(`${text}\n`);
    },
  };
}

export const EXIT_OK = 0;
/** A check failed (unreachable, credentials rejected, probe mismatch). */
export const EXIT_CHECK_FAILED = 1;
/** Bad usage or unsafe/invalid configuration; raised before any request. */
export const EXIT_USAGE = 2;
