// Release 1 (v0.2.0, fixture-only) texts that are not part of the notes: the unverified list and the evidence claims.
// A later release supplies its own functions through its descriptor.
export function release1UnverifiedClaims(facts, { evidenceSupplied }) {
  const items = [
    "Mobile (iOS and Android) has not been run.",
    "An authenticated kubo endpoint has not been exercised.",
    "Symlink and rename behaviour on Windows and Linux.",
    "The crash window of remove-then-rename.",
    "Large-file behaviour above the tested sizes; the 64 MB default cap is unproven.",
  ];
  if (!evidenceSupplied) items.unshift("The pull-with-conflict demonstration inside Obsidian desktop: no screenshot, recording or notes file was supplied.");
  if (facts.featureOp.verdict !== "passing") items.unshift("The feature operation has not passed.");
  return items;
}

export function release1Claims({ descriptor, facts, evidence, files }) {
  const demo = evidence.length > 0;
  return [
    { claim: `Version fields read ${descriptor.version} and minAppVersion ${descriptor.minAppVersion}`, evidence: ["manifest.json", "package.json"], status: "evidenced" },
    { claim: "Artifacts are byte-identical to dist/plugin/", evidence: ["SHA256SUMS"], status: "evidenced" },
    { claim: "Feature operation passed", evidence: [facts.featureOp.path], status: facts.featureOp.verdict === "passing" ? "evidenced" : "unverified" },
    { claim: "Pull-with-conflict demonstrated in Obsidian desktop on macOS", evidence: evidence.map((e) => e.path), status: demo ? "evidenced" : "unverified" },
    { claim: "Mobile works", evidence: [], status: "unverified" },
    { claim: `Release is published (${files.length} assets)`, evidence: [], status: "unverified" },
  ];
}
