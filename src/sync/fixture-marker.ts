import { ConfigError, FIXTURE_MARKER, FIXTURE_MARKER_VALUE, PULLED_MARKER_VALUE, assertFixtureVault, classifyMarkerText, markerProblem, type MarkerState } from "../core/config";
import type { HostFs } from "../core/host-bridge";

/** A marker holds one short word. Anything larger is not read and counts as unrecognised. */
export const MARKER_MAX_BYTES = 64;

export type MarkerFs = Pick<HostFs, "stat" | "read">;

/** What release 0.2.0's pull wrote into the marker (one trailing line ending is allowed, as for the current words). */
export const LEGACY_PULLED_MARKER_TEXT = "fixture copy created by ipfs-sync pull";
const LEGACY_WORD_MARKER_TEXT = "marker";
const TRAILING_NEWLINE = /\r?\n$/;

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
  return state === "fixture" || state === "pulled-fixture";
}
