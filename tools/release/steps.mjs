// The ordered outward steps as text. Nothing here is executed; the tool never spawns git or gh.
import { RECEIPT_TOOL } from "./constants.mjs";

export function outwardSteps({ descriptor, facts, outDir = descriptor.outDir, assetNames }) {
  const { tag, repo } = descriptor;
  const branch = facts.git.branch ?? "<BRANCH UNKNOWN>";
  const assets = assetNames.map((name) => `${outDir}/${name}`);
  const releaseWord = descriptor.prerelease ? "pre-release" : "release";
  return [
    {
      id: "commit",
      title: descriptor.commitStepTitle,
      decision: "The operator names the exact paths; the tool does not choose them. Review `git status` and `git diff --stat` first.",
      commands: [
        "git add <PATHS CHOSEN BY THE OPERATOR>",
        `git commit -m "${descriptor.commitMessage}"`,
      ],
    },
    {
      id: "tag",
      title: `Create the annotated tag ${tag} on the commit from the previous step`,
      decision: "Show the commit SHA to the operator before running.",
      commands: [`git tag -a ${tag} -m "${descriptor.tagMessage}" <COMMIT SHA FROM THE COMMIT STEP>`],
    },
    {
      id: "push-branch",
      title: `Push branch ${branch} to origin`,
      decision: "Pushing a branch is separate from pushing the tag; approval for one does not cover the other.",
      commands: [`git push origin ${branch}`],
    },
    {
      id: "push-tag",
      title: `Push tag ${tag} to origin`,
      decision: "A pushed tag is not reversible by this project.",
      commands: [`git push origin ${tag}`],
    },
    {
      id: "github-prerelease",
      title: `Create the GitHub ${releaseWord} ${tag} on ${repo}`,
      decision: `Shown with the repository, tag, target commit, asset list with checksums and the release notes text. ${descriptor.prerelease ? "Marked pre-release and not latest. " : ""}Flags are not checked against the installed gh version.`,
      commands: [
        `gh release create ${tag} --repo ${repo} --verify-tag${descriptor.prerelease ? " --prerelease --latest=false" : ""} --title "${descriptor.releaseTitle}" --notes-file ${outDir}/release-notes.md ${assets.join(" ")}`,
      ],
    },
    {
      id: "publication-receipt",
      title: "Cadence publication receipt (only after the release is public and downloadable)",
      decision: "Needs public HTTPS asset URLs and a first-party page that advertises them and the version. A GitHub release page may list assets as relative links, which this tool would reject; unverified. Skip and report the receipt as not produced if any earlier approval was declined.",
      commands: [`node ${RECEIPT_TOOL} --input <publication-request.json> --out <receipt.json>`],
    },
  ];
}
