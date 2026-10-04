import type { HostFs } from "../core/host-bridge";
import { FIXTURE_MARKER, FIXTURE_MARKER_VALUE, PULLED_MARKER_VALUE } from "./fixture-constants";

// The publish side of the former fixture policy (mvp-07b tasks 3.2 and 6.2). The guard is removed: every vault may be
// published (encryption stays mandatory) and the marker file has no meaning to publish. Every export name and
// signature of the earlier module is kept so that callers and the checker's scope do not change; the gates return
// without checking and the notice and copy constants carry neutral text. The marker parsing below is kept as it was.
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

/** Once the hint of a publish refusal; no publish is refused for its marker any more, so it carries no text. */
export const MARK_FIXTURE_HINT = "";

/** Permissive since the guard removal: every vault may be published, whatever its marker says. Never throws. */
export function assertFixtureVault(_marker: MarkerState): void {
  // Intentionally empty: the signature is kept for the callers and the WebView probe entries.
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

/** Once the hint for re-marking pull's destination; no pull is refused for its marker any more, so it carries no text. */
export const REMARK_PULL_HINT = "";

/** The publish gate, shared by the engine and both hosts. Permissive since the guard removal: it returns without reading the marker. */
export async function assertPublishMarker(_fs: MarkerFs): Promise<void> {
  // Intentionally empty: every vault may be published (encryption stays mandatory); the signature is kept for the callers.
}

/** Permissive since the guard removal: a pull is allowed whatever the marker says. */
export function enablesPull(_state: MarkerState): boolean {
  return true;
}

// ---------- User-facing copy ----------

/** The plugin's notice for a refused publish. Kept for the callers; the marker refusal it described no longer exists. */
export const FIXTURE_ONLY_NOTICE = "IPFS Sync: publishing was refused. Nothing was sent to the node.";

/** The plugin settings tab's standing notice. */
export const PUBLISH_SCOPE_SETTINGS_COPY =
  "Every publish is encrypted with your vault passphrase before anything leaves this device. Without the passphrase the published data cannot be read.";

/** The continuation indent of the CLI help text's command descriptions. */
export const HELP_CONTINUATION_INDENT = " ".repeat(26);

/** The `publish` paragraph of the CLI help. */
export const PUBLISH_SCOPE_HELP = "Any vault can be published.";
