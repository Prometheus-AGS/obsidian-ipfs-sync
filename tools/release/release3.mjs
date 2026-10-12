// Release 3 (v0.4.0) texts: the notes builder, the limitations list, the unverified list and the evidence claims.
// Pure functions; nothing here runs a process or touches a file. The release tool (tools/release-mvp-10.mjs) reads
// the demo record and passes what the texts need as `demo`: { recordPath, mobileOutcome }, or null when no demo
// record was supplied (the plan before the demo has happened). Every text then states no demo result.
//
// The AI-layer gate is unconditional text, not a parameter (spec release-3, "AI-layer gate on release-notes
// claims"): no airplane-mode or on-device-AI claim without the iPhone run that loads PGlite and the ONNX model
// together with peak memory recorded. That run has not happened, so the notes must say so. The words "airplane"
// and "on-device" appear only inside AI_GATE_SENTENCE; the record step greps for exactly that.

import { RELEASE_2_LIMITATIONS, plain } from "./release2.mjs";

export const AI_GATE_SENTENCE =
  "No airplane-mode or on-device-AI capability is claimed: phone embeddings are opt-in, and the iPhone run that loads PGlite and the ONNX model together, with peak memory recorded, has not happened.";

// Release 2's limitations still hold (nothing in mvp-10 changes them); the CLI's missing read cap and exclusion
// option are added (design.md context: the demo runs from Obsidian, which has both; the CLI stays without).
export const RELEASE_3_LIMITATIONS = [
  ...RELEASE_2_LIMITATIONS,
  "The CLI has no per-file read cap and no exclusion option; both exist only in the Obsidian plugin.",
];

const mobileClause = (demo) =>
  demo?.mobileOutcome
    ? `the optional mobile attempt was recorded as: ${plain(demo.mobileOutcome)} — one recorded attempt, not a verification`
    : "the optional mobile attempt was not run — mobile stays unverified (T3)";

// The first paragraph of the notes. Spec release-3 ("Notes open with what the release can and cannot do") pins its
// content: the can statement with the demo result, the cannot list, and the AI-layer gate sentence.
const CAN_CANNOT = (demo) => {
  const demonstrated =
    demo !== null
      ? ", demonstrated on the operator's own ~1.0 GB vault with 0 sha256 mismatches across the published set"
      : "; the real-vault demonstration is pending: no demo record was supplied, so this notes build states no demo result";
  return (
    `Release 3 can: publish and pull a real encrypted vault between Obsidian desktop and the CLI${demonstrated}. ` +
    "It cannot: hide file count, exact sizes, publish timing or access patterns; " +
    `claim mobile support (${mobileClause(demo)}); ` +
    "claim Android support (untested); " +
    "cap or exclude files in the CLI (the CLI has no read cap and no exclusion option; both exist only in the Obsidian plugin); " +
    "recover a lost passphrase; take back an old passphrase or old key-slot copy after a change; remove deleted notes from old pinned roots. " +
    AI_GATE_SENTENCE
  );
};

function evidenceLines(demo) {
  const noGate = "- Release 3 has no independent review gate: the cumulative phase-boundary review follows the release (mvp-10 design, decision 6).";
  if (demo === null) {
    return [
      "- No demo record was supplied to this notes build: the operator-run real-vault round trip is the evidence of this release, and without its record no demo result is stated.",
      noGate,
    ];
  }
  return [
    `- Demo record: ${plain(demo.recordPath)} — the operator-run real-vault round trip (mvp-10 tasks 3.1 to 3.3): publish from Obsidian desktop, fresh-vault pull, the sha256 comparison and the complete skipped-file list.`,
    `${noGate} Any finding routes through the defect loop to a patch release.`,
    "- The encrypted loop is covered by mvp-09's end-to-end suite (cited, not re-run).",
  ];
}

export function buildRelease3Notes({ descriptor, sums, unverified, demo = null }) {
  const lines = [
    CAN_CANNOT(demo),
    "",
    `## IPFS Sync ${descriptor.version}`,
    "",
    "Publish survives files that change or vanish while they are being read: the file is skipped with its reason and the run completes. Everything else is as Release 2: the vault is encrypted before it reaches your kubo node (Argon2id-derived keys, a passphrase-wrapped key slot, a signed manifest and a sequence number per device), and pull checks the manifest before it writes anything.",
    "",
    "## What was checked",
    "",
    ...evidenceLines(demo),
    "",
    "## Known limitations",
    "",
    ...descriptor.limitations.map((item) => `- ${item}`),
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
    "This is a pre-release unless the operator decides otherwise when publishing it.",
    "",
    `Tag: ${descriptor.tag}`,
    "",
  ];
  return lines.join("\n");
}

export function release3UnverifiedClaims(demo, facts, _options) {
  const items = [];
  if (demo === null) items.push("The real-vault round trip: no demo record was supplied, so nothing about the demo is verified.");
  else if (facts.featureOp.verdict !== "passing") items.push(`The demo record at ${plain(demo.recordPath)} carries no pass verdict the release tool accepts.`);
  items.push(
    demo?.mobileOutcome
      ? `Mobile (iOS): one attempt, recorded as "${plain(demo.mobileOutcome)}"; one recorded attempt is not a verification.`
      : "Mobile stays unverified (T3): the optional mobile attempt was not run.",
  );
  items.push("Android is untested.");
  items.push("Hosts, operating systems and Obsidian versions other than the operator's demo setup (macOS desktop).");
  items.push("The iPhone memory run for the AI layer (PGlite and the ONNX model together, peak memory recorded) has not happened; see the opening paragraph.");
  return items;
}

export function release3Claims({ descriptor, facts, evidence, files, demo }) {
  const demoRecorded = demo !== null && facts.featureOp.verdict === "passing";
  return [
    { claim: `Version fields read ${descriptor.version} and minAppVersion ${descriptor.minAppVersion}`, evidence: ["manifest.json", "package.json"], status: facts.versions.manifest === descriptor.version ? "evidenced" : "unverified" },
    { claim: "Shipped bytes are byte-identical to the packaged copies", evidence: ["SHA256SUMS"], status: "evidenced" },
    {
      claim: "Real-vault round trip demonstrated by the operator (publish from Obsidian desktop, fresh-vault pull, 0 sha256 mismatches across the published set)",
      evidence: demo !== null ? [demo.recordPath] : [],
      status: demoRecorded ? "evidenced" : "unverified",
    },
    { claim: "Publish survives files removed or changed during read (skipped with a reason, the run completes)", evidence: ["tests/unit/ (mvp-10 task 1.1)"], status: "evidenced" },
    { claim: "Mobile works", evidence: demo?.mobileOutcome ? [demo.recordPath] : [], status: "unverified" },
    { claim: "Android works", evidence: [], status: "unverified" },
    { claim: `Release is published (${files.length} assets)`, evidence: [], status: "unverified" },
  ];
}
