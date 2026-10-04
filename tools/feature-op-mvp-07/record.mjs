// The transcript and the result record: the shape item B reads, and the files in the per-user feature-ops directory.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { FEATURE_OPS_DIRECTORY, RECORD_SCHEMA, Refusal, perUserStateDir } from "./constants.mjs";

const sha256Text = (text) => createHash("sha256").update(text).digest("hex");

/** A transcript that writes through (stdout by default) and keeps every line, so the file beside the record is what the operator saw. */
export function createTranscript(write = (text) => process.stdout.write(text)) {
  const lines = [];
  return {
    out(line = "") {
      lines.push(line);
      write(`${line}\n`);
    },
    text: () => lines.map((line) => `${line}\n`).join(""),
  };
}

/** `<per-user state dir>/feature-ops`, by the same function the checker uses. */
export const featureOpsDirectory = (env, platform = process.platform) => join(perUserStateDir(env, platform), FEATURE_OPS_DIRECTORY);

/**
 * The record item B reads (checker: mode, passed, finishedAt, treeSha256, transcriptSha256, installed.vaults[].files, installed.cli,
 * assertions[{id,kind,passed,detail}]) plus what the run adds. `input.transcript` is hashed and dropped. Nothing is derived from the
 * mode here: the caller sets mode, phases and verifyOnly, and item B refuses anything that is not a manual run.
 */
export function buildRecord(input) {
  const { transcript, ...rest } = input;
  return { schema: RECORD_SCHEMA, ...rest, transcriptSha256: sha256Text(typeof transcript === "string" ? transcript : "") };
}

function assertPrivateDirectory(dir) {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Refusal(`${dir} is a symbolic link; the result is not written through it`);
  if (!stats.isDirectory()) throw new Refusal(`${dir} is not a directory`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Refusal(`${dir} is not owned by the current user`);
  if ((stats.mode & 0o077) !== 0) throw new Refusal(`${dir} has mode ${(stats.mode & 0o777).toString(8)}; it must be 0700 (item B refuses anything looser)`);
  return true;
}

/** Fails early, before a long run: the output directory exists privately or can be created so. */
export function prepareOutputDirectory(dir) {
  if (!assertPrivateDirectory(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

function writePrivateFile(path, data) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Refusal(`${path} is a symbolic link; the result is not written through it`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Writes the transcript, then the record whose transcriptSha256 is the hash of exactly that transcript (0600 files in a 0700 directory). */
export function writeOperatorFiles({ dir, names, record, transcript }) {
  prepareOutputDirectory(dir);
  const transcriptPath = join(dir, names.transcript);
  const recordPath = join(dir, names.record);
  writePrivateFile(transcriptPath, transcript);
  writePrivateFile(recordPath, `${JSON.stringify({ ...record, transcriptSha256: sha256Text(transcript) }, null, 2)}\n`);
  return { recordPath, transcriptPath };
}
