// Release notes text. The first paragraph is the fixture-only statement; the spec requires it to come first.
import { ENCRYPTION_PLAN_PATH, LIMITATIONS, MIN_APP_VERSION, REPO, TAG, VERSION } from "./constants.mjs";

export const FIXTURE_ONLY_STATEMENT =
  "Release 1 (fixture-only). This release must not be used on real notes. It syncs synthetic fixture vaults only, " +
  "refuses any other vault, and has no encryption: everything it publishes to your kubo node is readable by anyone who obtains the CID.";

export function buildReleaseNotes({ sums, unverified }) {
  const lines = [
    FIXTURE_ONLY_STATEMENT,
    "",
    `## IPFS Sync ${VERSION}`,
    "",
    "Adds pull with conflict handling in the Obsidian plugin: it fetches the published vault from your own kubo node by delta and keeps your local bytes when both sides changed, saving the remote version as a conflict copy.",
    "",
    "## Known limitations",
    "",
    ...LIMITATIONS.map((item) => `- ${item}`),
    "- No encryption. Do not point this at a vault that holds real notes.",
    "",
    "## Requirements",
    "",
    `- Obsidian ${MIN_APP_VERSION} or later (the plugin appends large files in chunks).`,
    "- Your own kubo node. Do not expose its RPC port to the internet.",
    "",
    "## Assets and SHA-256",
    "",
    "```",
    ...sums.map(({ name, sha256 }) => `${sha256}  ${name}`),
    "```",
    "",
    "## Not verified",
    "",
    ...unverified.map((item) => `- ${item}`),
    "",
    "## Release status",
    "",
    `This is a pre-release and is not the latest stable release for real-note use. The plan for the encryption release is in https://github.com/${REPO}/tree/main/${ENCRYPTION_PLAN_PATH}.`,
    "",
    `Tag: ${TAG}`,
    "",
  ];
  return lines.join("\n");
}
