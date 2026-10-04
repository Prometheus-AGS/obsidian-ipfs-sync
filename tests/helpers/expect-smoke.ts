import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKER_PATH, tempDir } from "./guard-repo.ts";

/**
 * The one smoke test that drives a tool under a real pseudo-terminal (mvp-07b task 4.3c, operator decision 3: no pty
 * package; `script(1)` is unusable with piped stdio on macOS). It uses `expect(1)`, which is not guaranteed on CI, so the
 * caller wraps the test in `skipIf(!hasExpect)`.
 */
export const hasExpect: boolean = (() => {
  const probe = spawnSync("expect", ["-v"], { encoding: "utf8", timeout: 10_000 });
  return probe.error === undefined && probe.status === 0;
})();

/** Waits for the fingerprint and the nonce the enrolment prints, retypes both, and exits with the tool's own status. */
const ENROL_SCRIPT = `set timeout 90
spawn -noecho {*}$argv
expect {
  -re {fingerprint: (SHA256:[A-Za-z0-9+/]+)} { set fp $expect_out(1,string) }
  timeout { exit 98 }
  eof { exit 97 }
}
expect {
  -re {nonce: ([0-9a-f]+)} { set nonce $expect_out(1,string) }
  timeout { exit 98 }
  eof { exit 97 }
}
expect "Retype the fingerprint:"
send -- "$fp\\r"
expect "Retype the nonce:"
send -- "$nonce\\r"
expect eof
catch wait result
exit [lindex $result 3]
`;

export interface PtyRun {
  readonly status: number | null;
  readonly output: string;
}

/** Runs `node tools/check-guard-preconditions.mjs --enrol-signer <keyFile>` under a pty with `HOME` set to `home`. */
export function enrolUnderPty(options: { keyFile: string; home: string }): PtyRun {
  const script = join(tempDir("guard-expect-"), "enrol.exp");
  writeFileSync(script, ENROL_SCRIPT);
  const env = { PATH: process.env.PATH ?? "", HOME: options.home };
  const run = spawnSync("expect", [script, process.execPath, CHECKER_PATH, "--enrol-signer", options.keyFile], { env, encoding: "utf8", timeout: 60_000 });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}
