// Release 2 (v0.3.0) texts and the reading of the guard checker's `--json` result: the notes builder, the unverified
// list, the evidence claims, the plan section that prints the checker verdict. Pure functions; nothing here runs a process
// or touches a file. The release tool (tools/release-mvp-07.mjs) runs the checker and passes the result in.
//
// What the checker's document is trusted for: nothing but its verdict and its facts. This file re-reads the shape of every
// field it prints or writes into the notes, and refuses a document that is not a complete pass.

import { plain } from "../check-guard-preconditions.mjs";

export const ITEMS =["A", "B", "C", "D", "E"];
export const ATTESTATION =
  "The review record, the operator-run result and the phone-timing record are attestations, not proofs: the checker makes forging them more work and leaves a trail, " +
  "and a person with repository write access and a terminal can still produce all three.";
export const PERMISSIONS_LINE =
  "Every vault write now creates directories with mode 0700 and files with 0600, and a crash can leave `.<name>.<pid>.<uuid>.tmp` files in the vault directory.";

export const RELEASE_2_LIMITATIONS = [
  "Silent per-file corruption of unchanged files by someone who can write to the node is not detected by the publisher.",
  "Concurrent publishes are narrowed, not prevented.",
  "The sequence floor does not stop a node from showing an old copy to a device that has no recorded state.",
  "Rewrap does not revoke the old passphrase or any old copy of the key slot.",
];

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/=]+$/;
const REQUIRED_BUILD_FILES = ["dist/plugin/main.js", "dist/plugin/manifest.json", "dist/cli/ipfs-sync.mjs"];

// Text that came from a record or from the checker is passed through the checker's `plain` (control characters, line
// separators and bidi overrides replaced) before it reaches a terminal or a published note; re-exported for the release tool.
export { plain };

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value !== "";
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** The checker's JSON document, re-validated, reduced to what the tool prints and records. Throws on anything off. */
export function summarizeGuard(doc) {
  const bad = (why) => {
    throw new Error(`checker output is malformed: ${why}`);
  };
  if (!isObject(doc) || doc.schema !== 1 || doc.pass !== true || doc.complete !== true) bad("not a complete pass document of schema 1");
  const { tree, build, items } = doc;
  if (!isObject(tree) || !HEX64.test(tree.sha256) || typeof tree.t8 !== "string" || tree.t8 !== tree.sha256.slice(0, 8) || !COMMIT.test(tree.commit)) bad("tree");
  if (!isObject(build) || !HEX64.test(build.sha256) || !COMMIT.test(build.commit) || !isText(build.node) || !isText(build.pnpm) || !isObject(build.files)) bad("build");
  for (const [path, sum] of Object.entries(build.files)) if (!HEX64.test(sum) || !/^dist\/(?:plugin|cli)\/[^/]+$/.test(path)) bad(`build file ${plain(path)}`);
  for (const path of REQUIRED_BUILD_FILES) if (!Object.hasOwn(build.files, path)) bad(`build file ${path} is missing`);
  if (!isObject(items) || !ITEMS.every((name) => isObject(items[name]) && items[name].status === "pass" && isObject(items[name].evidence))) bad("items A to E");

  const a = items.A;
  const aEvidence = a.evidence;
  if (!isText(aEvidence.recordPath) || !Array.isArray(a.unread) || !Array.isArray(a.accepted)) bad("item A");
  let itemA;
  if (a.form === "git-history") {
    if (!COMMIT.test(aEvidence.commit) || !Number.isSafeInteger(aEvidence.commitCount) || aEvidence.commitCount < 1) bad("item A commit or commit count");
    itemA = { form: "git-history", commit: aEvidence.commit, commitCount: aEvidence.commitCount };
  } else if (a.form === "signature") {
    if (!FINGERPRINT.test(aEvidence.signerFingerprint)) bad("item A signer fingerprint");
    itemA = { form: "signature", signerFingerprint: aEvidence.signerFingerprint };
  } else bad("item A form");
  itemA = {
    ...itemA,
    recordPath: aEvidence.recordPath,
    unread: a.unread.map((path) => plain(path)),
    unreadCount: a.unread.length,
    accepted: a.accepted.filter(isObject).map((finding) => ({ id: plain(finding.id), severity: plain(finding.severity) })),
  };

  if (!isText(items.B.evidence.recordPath)) bad("item B record path");
  const c = items.C;
  const cEvidence = c.evidence;
  if (!isText(c.form) || typeof cEvidence.timingMeasured !== "boolean" || !isText(cEvidence.recordPath)) bad("item C");
  const itemC = { form: plain(c.form), timingMeasured: cEvidence.timingMeasured, recordPath: cEvidence.recordPath };
  if (cEvidence.timingMeasured) {
    if (!isText(cEvidence.device) || !isText(cEvidence.os) || !Number.isFinite(cEvidence.seconds) || !Number.isFinite(cEvidence.longestGapMs)) bad("item C measurement");
    Object.assign(itemC, { device: plain(cEvidence.device), os: plain(cEvidence.os), seconds: cEvidence.seconds, longestGapMs: cEvidence.longestGapMs });
  }
  if (c.form === "signed" && FINGERPRINT.test(cEvidence.signerFingerprint ?? "")) itemC.signerFingerprint = cEvidence.signerFingerprint;
  if (isText(cEvidence.finishedAt)) itemC.finishedAt = plain(cEvidence.finishedAt);

  const documents = items.E.evidence.documents;
  if (!isObject(documents) || !Object.values(documents).every((sum) => HEX64.test(sum))) bad("item E documents");

  return {
    t8: tree.t8,
    treeSha256: tree.sha256,
    treeFileCount: tree.fileCount,
    commit: tree.commit,
    buildSha256: build.sha256,
    buildCommit: build.commit,
    buildFiles: { ...build.files },
    nodeVersion: plain(build.node),
    pnpmVersion: plain(build.pnpm),
    itemA,
    itemB: { recordPath: items.B.evidence.recordPath, finishedAt: isText(items.B.evidence.finishedAt) ? plain(items.B.evidence.finishedAt) : null },
    itemC,
    documents: Object.fromEntries(Object.entries(documents).map(([path, sum]) => [plain(path), sum])),
  };
}

const failureLines = (label, failures) =>
  Array.isArray(failures) && failures.length > 0
    ? failures.map((item) => `${label}: ${plain(item?.code ?? "unspecified")}: ${plain(item?.detail ?? "no detail")}`)
    : [`${label}: failed without a stated reason`];

/**
 * Judges one run of `node tools/check-guard-preconditions.mjs --json`: `{ status, stdout, stderr }`. Returns
 * `{ ok, problems, doc, guard }`; `ok` is true only for exit 0, a complete document of schema 1 whose `pass` is true and
 * whose five items all passed, and whose fields survive `summarizeGuard`. Anything else is a refusal with its reasons.
 */
export function readChecker({ status, stdout, stderr }) {
  const problems = [];
  let doc = null;
  try {
    doc = JSON.parse(stdout);
  } catch {
    doc = null;
  }
  if (status !== 0) problems.push(`the checker exited ${status}`);
  if (!isObject(doc)) {
    problems.push("the checker printed no JSON document");
    const text = String(stderr ?? "").trim();
    if (text !== "") problems.push(`checker said: ${plain(text.slice(-1200))}`);
    return { ok: false, problems, doc: null, guard: null };
  }
  if (doc.schema !== 1) problems.push(`the checker document has schema ${plain(doc.schema)}, expected 1`);
  if (doc.complete !== true) problems.push(...failureLines("checker", doc.failures));
  else {
    for (const name of ITEMS) {
      const item = doc.items?.[name];
      if (!isObject(item) || typeof item.status !== "string") problems.push(`item ${name}: absent from the checker document`);
      else if (item.status !== "pass") problems.push(...failureLines(`item ${name}`, item.failures));
    }
  }
  if (doc.pass !== true && problems.length === 0) problems.push("the checker document says pass is not true");
  let guard = null;
  if (problems.length === 0) {
    try {
      guard = summarizeGuard(doc);
    } catch (error) {
      problems.push(plain(error.message));
    }
  }
  return { ok: problems.length === 0, problems, doc, guard };
}

const itemSummary = (item) => {
  if (!isObject(item) || typeof item.status !== "string") return "absent";
  return item.status === "pass" ? "pass" : "FAIL";
};

/** The plan section that prints the checker result (plan mode, whatever the verdict). */
export function renderGuardSection(checked, status) {
  const lines = ["", "== Guard checker (node tools/check-guard-preconditions.mjs --json, run now) =="];
  lines.push(checked.ok ? "guard checker: pass" : `guard checker: FAIL (exit ${status})`);
  const doc = checked.doc;
  if (isObject(doc?.tree)) lines.push(`tree ${plain(doc.tree.t8)} ${plain(doc.tree.sha256)} (${plain(doc.tree.fileCount)} files) at commit ${plain(doc.tree.commit)}`);
  if (isObject(doc?.build)) lines.push(`build ${plain(doc.build.sha256)}  node ${plain(doc.build.node)}  pnpm ${plain(doc.build.pnpm)}`);
  if (doc?.complete === true && isObject(doc.items)) {
    for (const name of ITEMS) {
      const item = doc.items[name];
      const parts = [`item ${name}: ${itemSummary(item)}`];
      if (isObject(item) && typeof item.form === "string") parts.push(plain(item.form));
      const evidence = isObject(item?.evidence) ? item.evidence : {};
      if (name === "A" && item?.status === "pass") {
        if (typeof evidence.commit === "string") parts.push(`commit ${plain(evidence.commit)}, ${plural(evidence.commitCount, "commit", "commits")} touched the record`);
        if (typeof evidence.signerFingerprint === "string") parts.push(`signer ${plain(evidence.signerFingerprint)}`);
        parts.push(`${plural(Array.isArray(item.unread) ? item.unread.length : 0, "file", "files")} unread`);
      }
      if (name === "C" && item?.status === "pass") parts.push(evidence.timingMeasured === true ? "timing measured" : "timing unverified");
      lines.push(parts.join("  "));
    }
  }
  for (const problem of checked.problems) lines.push(`  - ${problem}`);
  if (!checked.ok) lines.push("`record` would refuse: it produces a release record only when this checker passes in the same run.");
  return lines.join("\n");
}

const CAN_CANNOT = (guard) => {
  let mobile = "not verified";
  if (guard !== null && guard.itemC.timingMeasured) mobile = `not verified; the phone key-derivation timing was measured on ${guard.itemC.device}, which is one input and not a verification`;
  else if (guard !== null) mobile = "not verified, and the phone key-derivation timing was accepted unmeasured";
  return (
    "Release 2 can: publish and pull encrypted vaults, including real notes, between Obsidian desktop and the CLI; keep a local edit as a dated copy on conflict; " +
    "refuse tampered or older states on a device that has a recorded state; change the passphrase and raise the cost; prune history. " +
    "It cannot: hide file count, exact sizes, publish timing or access patterns; stop a node from showing a device with no recorded state an old copy; " +
    "take back an old passphrase or old key-slot copy after a change; recover a lost passphrase; detect silent corruption of unchanged files by someone who can write to the node; " +
    "prevent overlapping publishes (they are detected at a later pull, and an edit can sit on the node under no name until then); remove deleted notes from old pinned roots; " +
    "sync Obsidian configuration or plugins; keep `.ipfs-sync/`, including temporary files, encrypted at rest; " +
    `claim mobile support (${mobile}); claim Android support (untested; Android is not a gate for Release 2 and stays an open follow-up).`
  );
};

function evidenceLines(guard) {
  if (guard === null) return ["- The guard checker has not passed for this tree, so no evidence is stated."];
  const a = guard.itemA;
  const c = guard.itemC;
  const review =
    a.form === "git-history"
      ? `- Review record (item A): the review record is unsigned. It is bound to the tree by git history only: the last commit that touched it is ${a.commit}, and ${plural(a.commitCount, "commit", "commits")} touched it. The operator typed an acknowledgement for tree ${guard.t8} before this record was written.`
      : `- Review record (item A): signed. Signer key fingerprint ${a.signerFingerprint}. Compare it by eye with the key you hold elsewhere; the trust files on the build machine are owner and mode checked only.`;
  const timing = c.timingMeasured
    ? `- Phone key-derivation timing (item C): measured on ${c.device} (${c.os}): ${c.seconds} s, longest event-loop gap ${c.longestGapMs} ms, at the default cost m=65536 KiB t=3 p=1.`
    : `- Phone key-derivation timing (item C): accepted unmeasured (${c.form === "signed" ? "signed statement" : "typed acceptance"}); no measurement of this build exists.`;
  return [
    `- Guard checker: items A to E passed for tree ${guard.t8} (${guard.treeSha256}) and build ${guard.buildSha256}.`,
    review,
    `- ${plural(guard.itemA.unreadCount, "file", "files")} the review record declares unread.`,
    ...(guard.itemA.accepted.length > 0 ? [`- Accepted findings in the review record: ${guard.itemA.accepted.map((finding) => `${finding.id} (${finding.severity})`).join(", ")}.`] : []),
    `- Operator run (item B): a manual run on desktop${guard.itemB.finishedAt === null ? "" : `, finished ${guard.itemB.finishedAt}`}.`,
    timing,
    `- Built by the checker with Node ${guard.nodeVersion} and pnpm ${guard.pnpmVersion}.`,
    `- ${ATTESTATION}`,
  ];
}

export function buildRelease2Notes({ descriptor, sums, unverified, guard = null }) {
  const lines = [
    CAN_CANNOT(guard),
    "",
    `## IPFS Sync ${descriptor.version}`,
    "",
    "Encrypts the vault before it reaches your kubo node: Argon2id-derived keys, a passphrase-wrapped key slot, a signed manifest and a sequence number per device. Pull checks the manifest before it writes anything, keeps your local bytes when both sides changed, and refuses older or tampered states on a device that has a recorded state.",
    "",
    PERMISSIONS_LINE,
    "",
    "## What was checked",
    "",
    ...evidenceLines(guard),
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

export function release2UnverifiedClaims(guard, _facts, _options) {
  if (guard === null) return ["The guard checker has not passed for this tree: nothing about it is verified."];
  const items = [];
  if (!guard.itemC.timingMeasured) items.push(`Phone key-derivation timing: accepted unmeasured (${guard.itemC.form === "signed" ? "signed statement" : "typed acceptance"}); no measurement of this build exists.`);
  items.push("Mobile support (iOS) has not been verified, and the timing record is one input to that decision, not a verification. Android is untested and is not a gate for this release.");
  if (guard.itemA.unreadCount > 0) items.push(`${plural(guard.itemA.unreadCount, "file", "files")} the review record declares unread were not reviewed.`);
  items.push("Operating systems and Obsidian versions other than those the operator run used.");
  return items;
}

export function release2Claims({ descriptor, facts, guard, files }) {
  const passed = guard !== null;
  return [
    { claim: `Guard checker passed (items A to E)${passed ? ` for tree ${guard.t8}` : ""}`, evidence: ["evidence.json: checker"], status: passed ? "evidenced" : "unverified" },
    { claim: "Shipped bytes equal the checker's build hashes", evidence: ["SHA256SUMS"], status: passed ? "evidenced" : "unverified" },
    { claim: `Version fields read ${descriptor.version} and minAppVersion ${descriptor.minAppVersion}`, evidence: ["manifest.json", "package.json"], status: facts.versions.manifest === descriptor.version ? "evidenced" : "unverified" },
    { claim: passed && guard.itemA.form === "git-history" ? "Review record authenticated by git history (unsigned attestation)" : "Review record authenticated by signature", evidence: ["evidence.json: reviewRecord"], status: passed ? "evidenced" : "unverified" },
    { claim: "Operator run completed in manual mode on the reviewed build (attestation)", evidence: ["evidence.json: operatorRecord"], status: passed ? "evidenced" : "unverified" },
    { claim: "Phone key-derivation timing measured", evidence: ["evidence.json: timingRecord"], status: passed && guard.itemC.timingMeasured ? "evidenced" : "unverified" },
    { claim: "Mobile works", evidence: [], status: "unverified" },
    { claim: "Android works", evidence: [], status: "unverified" },
    { claim: `Release is published (${files.length} assets)`, evidence: [], status: "unverified" },
  ];
}
