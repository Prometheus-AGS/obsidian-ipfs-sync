// Check, note and skip recording plus the console writer.
import process from "node:process";
import { Refusal } from "./constants.mjs";
import { firstLine } from "./policy.mjs";

// ======================================================================================================================
// Output and results
// ======================================================================================================================

export const checks = [];
export const skips = [];
export const out = (line = "") => process.stdout.write(`${line}\n`);

export function check(label, ok, detail = "") {
  checks.push({ label, passed: ok, detail });
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  -- ${detail}`}`);
  return ok;
}

export function note(line) {
  out(`NOTE  ${line}`);
}

export function skip(label, reason) {
  skips.push({ label, reason });
  out(`SKIP  ${label}  -- ${reason}`);
}

export async function guarded(label, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Refusal) throw error;
    check(`${label} ran to completion`, false, firstLine(error instanceof Error ? error.message : String(error)));
    return undefined;
  }
}
