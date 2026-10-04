// Release notes text. A descriptor carries its own builder (`buildNotes`); this file holds Release 1's.
// Release 1's first paragraph is the fixture-only statement; the spec requires it to come first.

export const FIXTURE_ONLY_STATEMENT =
  "Release 1 (fixture-only). This release must not be used on real notes. It syncs synthetic fixture vaults only, " +
  "refuses any other vault, and has no encryption: everything it publishes to your kubo node is readable by anyone who obtains the CID.";

export function buildRelease1Notes({ descriptor, sums, unverified }) {
  const lines = [
    FIXTURE_ONLY_STATEMENT,
    "",
    `## IPFS Sync ${descriptor.version}`,
    "",
    "Adds pull with conflict handling in the Obsidian plugin: it fetches the published vault from your own kubo node by delta and keeps your local bytes when both sides changed, saving the remote version as a conflict copy.",
    "",
    "## Known limitations",
    "",
    ...descriptor.limitations.map((item) => `- ${item}`),
    "- No encryption. Do not point this at a vault that holds real notes.",
    "",
    "## Requirements",
    "",
    `- Obsidian ${descriptor.minAppVersion} or later (the plugin appends large files in chunks).`,
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
    `This is a pre-release and is not the latest stable release for real-note use. The plan for the encryption release is in https://github.com/${descriptor.repo}/tree/main/${descriptor.encryptionPlanPath}.`,
    "",
    `Tag: ${descriptor.tag}`,
    "",
  ];
  return lines.join("\n");
}
