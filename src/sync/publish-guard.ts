import { ConfigError } from "../core/config/errors";
import type { HostFs } from "../core/host-bridge";
import { FIXTURE_MARKER, FIXTURE_MARKER_VALUE, PULLED_MARKER_VALUE } from "./fixture-constants";

// The publish side of the fixture policy, in one place (mvp-07b task 3.2). Marker classification, the publish
// gate, the legacy-marker texts and the user-facing copy that states the policy all live here and in `pull-guard.ts`.
// The guard removal (task 6.2) replaces the bodies of these two modules and keeps every export name.
export { FIXTURE_MARKER, FIXTURE_MARKER_VALUE, PULLED_MARKER_VALUE };

/** What the fixture marker file at the vault root says. `absent` also covers a marker that is not a regular file. */
export type MarkerState = "fixture" | "pulled-fixture" | "empty" | "unrecognised" | "absent";

const TRAILING_NEWLINE = /\r?\n$/;

/** Classify the marker file text. One trailing line ending is allowed; everything else must match exactly. */
export function classifyMarkerText(text: string): Exclude<MarkerState, "absent"> {
  const value = text.replace(TRAILING_NEWLINE, "");
  if (value === FIXTURE_MARKER_VALUE) return "fixture";
  if (value === PULLED_MARKER_VALUE) return "pulled-fixture";
  return value === "" ? "empty" : "unrecognised";
}

/** Why a marker state does not enable the operation, as fixed text (the marker content itself is never echoed). */
export function markerProblem(state: MarkerState): string {
  switch (state) {
    case "absent":
      return `this vault has no ${FIXTURE_MARKER} marker`;
    case "pulled-fixture":
      return `the ${FIXTURE_MARKER} marker says "${PULLED_MARKER_VALUE}" (written by pull), which does not enable publishing`;
    case "empty":
      return `the ${FIXTURE_MARKER} marker is empty (an empty marker from an earlier release no longer enables publishing)`;
    case "unrecognised":
      return `the ${FIXTURE_MARKER} marker does not hold the text "${FIXTURE_MARKER_VALUE}"`;
    case "fixture":
      return "the marker is accepted";
  }
}

/** The hint every publish refusal carries: how a fixture vault is marked deliberately. */
export const MARK_FIXTURE_HINT = `To mark a fixture vault deliberately, create ${FIXTURE_MARKER} at the vault root containing the text "${FIXTURE_MARKER_VALUE}".`;

/**
 * Until the encrypted pull change removes it (after independent review, an in-Obsidian run and a phone timing),
 * only a vault whose marker holds `fixture` may be published, in every host and before the passphrase is looked
 * at. `pulled-fixture`, an empty marker, any other text and no marker are refused. The marker is an accident guard,
 * not a control; anyone who can create the file can override the refusal.
 */
export function assertFixtureVault(marker: MarkerState): void {
  if (marker === FIXTURE_MARKER_VALUE) return;
  throw new ConfigError(
    "fixture-marker-required",
    `publish refused: ${markerProblem(marker)}. Encryption is implemented but not yet independently reviewed or verified in Obsidian, ` +
      `so only fixture vaults can be published for now; real vaults are allowed after that review. ${MARK_FIXTURE_HINT} Nothing was sent to the node.`,
  );
}

/** A marker holds one short word. Anything larger is not read and counts as unrecognised. */
export const MARKER_MAX_BYTES = 64;

export type MarkerFs = Pick<HostFs, "stat" | "read">;

/** What release 0.2.0's pull wrote into the marker (one trailing line ending is allowed, as for the current words). */
export const LEGACY_PULLED_MARKER_TEXT = "fixture copy created by ipfs-sync pull";
const LEGACY_WORD_MARKER_TEXT = "marker";

/** The marker contents release 0.2.0 wrote or accepted, which this version no longer accepts. */
export type LegacyMarker = "pulled" | "empty" | "word";

interface MarkerRead {
  readonly state: MarkerState;
  readonly legacy: LegacyMarker | undefined;
}

function legacyOf(text: string): LegacyMarker | undefined {
  const value = text.replace(TRAILING_NEWLINE, "");
  if (value === LEGACY_PULLED_MARKER_TEXT) return "pulled";
  if (value === "") return "empty";
  return value === LEGACY_WORD_MARKER_TEXT ? "word" : undefined;
}

async function readMarker(fs: MarkerFs): Promise<MarkerRead> {
  const info = await fs.stat(FIXTURE_MARKER);
  if (info?.kind !== "file") return { state: "absent", legacy: undefined };
  if (info.size > MARKER_MAX_BYTES) return { state: "unrecognised", legacy: undefined };
  const text = new TextDecoder().decode(await fs.read(FIXTURE_MARKER));
  const state = classifyMarkerText(text);
  return { state, legacy: state === "fixture" || state === "pulled-fixture" ? undefined : legacyOf(text) };
}

/**
 * Read the fixture marker at the vault root. A missing marker, or one that is not a regular file, is `absent`.
 * The two accepted words are `fixture` (user or generator) and `pulled-fixture` (written by pull); an empty
 * marker from an earlier release and any other text are reported as such and enable nothing.
 */
export async function readMarkerState(fs: MarkerFs): Promise<MarkerState> {
  return (await readMarker(fs)).state;
}

/** The marker's release-0.2.0 kind, or undefined when it is missing, current, or something else. */
export async function readLegacyMarker(fs: MarkerFs): Promise<LegacyMarker | undefined> {
  return (await readMarker(fs)).legacy;
}

const LEGACY_DESCRIPTION: Readonly<Record<LegacyMarker, string>> = {
  pulled: "the text a pulled copy got in release 0.2.0",
  empty: "an empty marker",
  word: `the text "${LEGACY_WORD_MARKER_TEXT}"`,
};

/** The reason a release-0.2.0 marker is refused, as fixed text (no marker content beyond these known texts is echoed). */
export function legacyMarkerProblem(kind: LegacyMarker): string {
  return `the ${FIXTURE_MARKER} marker predates this version: it holds ${LEGACY_DESCRIPTION[kind]} from release 0.2.0, which is no longer accepted`;
}

/** How pull's destination is re-marked deliberately. */
export const REMARK_PULL_HINT = `Re-mark this directory deliberately by replacing the content of ${FIXTURE_MARKER} with the text "${FIXTURE_MARKER_VALUE}" or "${PULLED_MARKER_VALUE}".`;

/**
 * The publish gate, shared by the engine and both hosts: refuses, before any request and before any passphrase
 * is looked at, unless the marker holds `fixture`. Throws `ConfigError` with code `fixture-marker-required`.
 * The pulled-copy text of release 0.2.0 is refused with a message that says the marker predates this version;
 * every other refusal is the generic one.
 */
export async function assertPublishMarker(fs: MarkerFs): Promise<void> {
  const { state, legacy } = await readMarker(fs);
  try {
    assertFixtureVault(state);
  } catch (error) {
    if (legacy === "pulled" && error instanceof ConfigError) {
      throw new ConfigError(error.code, error.message.replace(markerProblem(state), legacyMarkerProblem(legacy)));
    }
    throw error;
  }
}

/** Pull accepts a destination marked by either word. */
export function enablesPull(state: MarkerState): boolean {
  return state === FIXTURE_MARKER_VALUE || state === PULLED_MARKER_VALUE;
}

// ---------- User-facing copy that states the policy ----------

/** The plugin's refusal notice for a publish into a vault without the `fixture` marker. */
export const FIXTURE_ONLY_NOTICE =
  "IPFS Sync: publishing is off for this vault. Encryption is implemented but not yet independently reviewed or verified in Obsidian, " +
  `so only fixture vaults (a ${FIXTURE_MARKER} file at the vault root holding the text "${FIXTURE_MARKER_VALUE}") can be published; ` +
  `real vaults are allowed after that review. ${MARK_FIXTURE_HINT} Nothing was sent to the node.`;

/** The plugin settings tab's standing notice. */
export const PUBLISH_SCOPE_SETTINGS_COPY =
  "Encryption is implemented but not yet independently reviewed or verified in Obsidian. Until that review, this build only publishes " +
  `fixture vaults: vaults with a ${FIXTURE_MARKER} file at the root holding the text "${FIXTURE_MARKER_VALUE}". Real vaults are refused, and nothing is sent to the node for them.`;

/** The continuation indent of the CLI help text's command descriptions. */
export const HELP_CONTINUATION_INDENT = " ".repeat(26);

const I = HELP_CONTINUATION_INDENT;

/** The `publish` paragraph of the CLI help: which vaults are accepted (wrapped as the help text wraps it). */
export const PUBLISH_SCOPE_HELP =
  `Only fixture vaults (marker\n${I}file ${FIXTURE_MARKER} containing the text "${FIXTURE_MARKER_VALUE}") are accepted until encryption\n` +
  `${I}has been independently reviewed; a marker written by pull ("${PULLED_MARKER_VALUE}"), an empty\n` +
  `${I}marker or none is refused before any request.`;
