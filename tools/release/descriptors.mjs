// Per-release descriptors. Everything that differs between releases is a field here; the tool modules read the
// descriptor they are given and hard-code no version, tag, tarball name, output directory or fixture-only text.
//
//   version, tag            the tag is ONE field. It is not derived from the version (Release 1: "v0.2.0"; the
//                           alternative "0.2.0" form follows Obsidian's tag = manifest version rule). The output
//                           directory and the outward steps read it.
//   cliTarball, outDir      derived from version and tag unless given.
//   featureOpFile           the feature-operation result the plan reads.
//   commitMessage, tagMessage, releaseTitle
//                           the texts of the outward steps (Release 1's say "fixture-only").
//   commitScope, commitStepTitle
//                           the working-tree note of the plan and the title of the commit step.
//   prerelease            the GitHub release is created with --prerelease --latest=false.
//   requiresFixtureStatement
//                           README.md and CHANGELOG.md must carry the fixture-only statement.
//   record.bumpVersions     `record` edits manifest.json and package.json to the version (Release 1).
//   record.build            `record` runs `pnpm build` (Release 1). A release with both false edits no hashed file
//                           and reads the existing dist/ as it stands.
//   buildNotes, unverifiedClaims, claims
//                           the release's own text builders.
import { CLI_TARBALL_FILES, MIN_APP_VERSION, PLUGIN_ARTIFACTS, RELEASE_DIR, REPO } from "./constants.mjs";
import { buildRelease1Notes } from "./notes.mjs";
import { release1Claims, release1UnverifiedClaims } from "./release1.mjs";
import { RELEASE_2_LIMITATIONS, buildRelease2Notes, release2Claims, release2UnverifiedClaims } from "./release2.mjs";

const REQUIRED_TEXT = ["version", "tag", "featureOpFile", "commitMessage", "tagMessage", "releaseTitle"];
const REQUIRED_FUNCTIONS = ["buildNotes", "unverifiedClaims", "claims"];

function fail(field, why) {
  throw new Error(`release descriptor: ${field} ${why}`);
}

export function makeDescriptor(spec) {
  for (const field of REQUIRED_TEXT) if (typeof spec[field] !== "string" || spec[field] === "") fail(field, "must be a non-empty string");
  for (const field of REQUIRED_FUNCTIONS) if (typeof spec[field] !== "function") fail(field, "must be a function");
  for (const field of ["prerelease", "requiresFixtureStatement"]) if (typeof spec[field] !== "boolean") fail(field, "must be a boolean");
  if (typeof spec.record?.bumpVersions !== "boolean" || typeof spec.record?.build !== "boolean") fail("record", "must be { bumpVersions: boolean, build: boolean }");
  if (!/^\d+\.\d+\.\d+$/.test(spec.version)) fail("version", `must be MAJOR.MINOR.PATCH, got ${spec.version}`);
  if (!/^[A-Za-z0-9._-]+$/.test(spec.tag) || !spec.tag.includes(spec.version)) fail("tag", `must be one path-safe token that contains the version ${spec.version}, got ${spec.tag}`);
  const outDir = spec.outDir ?? `${RELEASE_DIR}/${spec.tag}`;
  if (!outDir.startsWith(`${RELEASE_DIR}/`) || outDir.split("/").includes("..")) fail("outDir", `must be a directory under ${RELEASE_DIR}/, got ${outDir}`);
  return Object.freeze({
    repo: REPO,
    minAppVersion: MIN_APP_VERSION,
    cliTarballFiles: CLI_TARBALL_FILES,
    pluginArtifacts: PLUGIN_ARTIFACTS,
    limitations: [],
    encryptionPlanPath: null,
    commitScope: "every change that belongs in the tag",
    commitStepTitle: "Commit every change that belongs in the tag",
    ...spec,
    cliTarball: spec.cliTarball ?? `ipfs-sync-cli-${spec.version}.tgz`,
    outDir,
    record: Object.freeze({ bumpVersions: spec.record.bumpVersions, build: spec.record.build }),
  });
}

export const RELEASE_1 = makeDescriptor({
  version: "0.2.0",
  tag: "v0.2.0",
  featureOpFile: "feature-op-mvp-05.json",
  commitMessage: "release: v0.2.0 (fixture-only pre-release)",
  tagMessage: "IPFS Sync 0.2.0 (fixture-only pre-release)",
  releaseTitle: "IPFS Sync 0.2.0 (fixture-only)",
  prerelease: true,
  requiresFixtureStatement: true,
  record: { bumpVersions: true, build: true },
  commitScope: "the version bump and every change of mvp-01 to mvp-05",
  commitStepTitle: "Commit the version bump and every change that belongs in the tag",
  encryptionPlanPath: "openspec/changes/mvp-06-encrypted-vault-publish",
  limitations: [
    "Symbolic links are not detected by the plugin.",
    "A per-file read cap applies (default 64 MB, configurable 8 to 1024 MB).",
    "Remote deletions are not applied on pull.",
    "Mobile is not verified.",
  ],
  buildNotes: buildRelease1Notes,
  unverifiedClaims: release1UnverifiedClaims,
  claims: release1Claims,
});

// Release 2 (v0.3.0, mvp-07b). The record neither bumps versions nor builds: manifest.json and package.json read 0.3.0 in
// the reviewed commit, and the files come from the checker's build. The notes, the unverified list and the claims read the
// checker result (`guard`, from `summarizeGuard`), so a descriptor is made per run; `guard` is null when the checker has
// not passed, and the texts then say so. The tag is the single field (lead default `v0.3.0`; the operator may override).
export function makeRelease2(guard) {
  return makeDescriptor({
    version: "0.3.0",
    tag: "v0.3.0",
    featureOpFile: "feature-op-mvp-07.json",
    commitMessage: "release: v0.3.0",
    tagMessage: "IPFS Sync 0.3.0",
    releaseTitle: "IPFS Sync 0.3.0",
    prerelease: true,
    requiresFixtureStatement: false,
    record: { bumpVersions: false, build: false },
    commitScope: "the reviewed 07b branch (the tree the checker hashed)",
    commitStepTitle: "Commit the release (the reviewed tree; the operator names the exact paths)",
    limitations: RELEASE_2_LIMITATIONS,
    buildNotes: (input) => buildRelease2Notes({ ...input, guard }),
    unverifiedClaims: (facts, options) => release2UnverifiedClaims(guard, facts, options),
    claims: (input) => release2Claims({ ...input, guard }),
  });
}

export const RELEASE_2 = makeRelease2(null);
