import { createProcessIo } from "./io";
import { readTextIfPresent } from "./load-config";
import { runCli } from "./run";

runCli(
  process.argv.slice(2),
  { env: process.env, now: () => new Date(), readText: readTextIfPresent },
  createProcessIo(),
).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ipfs-sync: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
