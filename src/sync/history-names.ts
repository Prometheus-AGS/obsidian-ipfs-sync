/**
 * The names of history files under `manifests/` (spec: history-naming). The publisher writes
 * `manifests/<sequence>-<cid>.enc`, the sequence zero-padded to 16 decimal digits, so that sorting the names gives
 * the publish order without decrypting anything. Names written by an mvp-06 development build, `<cid>.enc`, stay
 * readable: they sort before every prefixed name and have no order among themselves.
 *
 * A name is only a claim. A reader that decrypts a prefixed file compares the manifest's sequence with the prefix
 * (`prefixMatchesSequence`); a mismatch means the file was planted or mislabelled.
 */

const SEQUENCE_DIGITS = 16;
const HISTORY_NAME = /^(?:([0-9]{16})-)?([A-Za-z0-9]{10,128})\.enc$/;
/** A CID as it appears in a history name and in paths: letters and digits only, bounded. */
const CID_SHAPE = /^[A-Za-z0-9]{10,128}$/;

export interface HistoryName {
  readonly name: string;
  readonly cid: string;
  /** The sequence in the prefix; undefined for a legacy name. */
  readonly sequence: number | undefined;
}

/** A sequence a manifest can carry: a positive safe integer (the largest one has exactly 16 digits). */
export function isValidSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 1;
}

/** `<16-digit sequence>-<cid>.enc`. Throws on an invalid sequence or a CID that is not a plain path segment. */
export function historyFileName(sequence: number, cid: string): string {
  if (!isValidSequence(sequence)) throw new RangeError("a history sequence must be a positive safe integer");
  if (!CID_SHAPE.test(cid)) throw new RangeError("a history CID must be 10 to 128 letters and digits");
  return `${String(sequence).padStart(SEQUENCE_DIGITS, "0")}-${cid}.enc`;
}

/** The parts of a history name, or undefined when the name is not one (junk). A prefix that is not a valid sequence is junk. */
export function parseHistoryName(name: string): HistoryName | undefined {
  const match = HISTORY_NAME.exec(name);
  if (match === null) return undefined;
  const cid = match[2] as string;
  if (match[1] === undefined) return { name, cid, sequence: undefined };
  const sequence = Number(match[1]);
  return isValidSequence(sequence) ? { name, cid, sequence } : undefined;
}

export function isHistoryName(name: string): boolean {
  return parseHistoryName(name) !== undefined;
}

export function isLegacyHistoryName(name: string): boolean {
  return parseHistoryName(name)?.sequence === undefined && isHistoryName(name);
}

/** Does the prefix of this name agree with the sequence of the manifest it holds? A legacy name carries no claim. */
export function prefixMatchesSequence(parsed: HistoryName, manifestSequence: number): boolean {
  return parsed.sequence === undefined || parsed.sequence === manifestSequence;
}

/**
 * Oldest first: legacy names before every prefixed name (and by name among themselves, only so that the order is
 * deterministic; it carries no meaning), then prefixed names by sequence and CID.
 */
export function compareHistoryNames(a: HistoryName, b: HistoryName): number {
  if (a.sequence === undefined || b.sequence === undefined) {
    if (a.sequence === b.sequence) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    return a.sequence === undefined ? -1 : 1;
  }
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
}

/**
 * The history names whose prefix is exactly `sequence`, in CID order (the fork ancestor lookup). A legacy name carries no
 * prefix and so is never found here. More than one result is possible after an earlier fork; the caller decides among them
 * by authenticating the files, not by the names.
 */
export function entriesAtSequence(names: readonly string[], sequence: number): readonly HistoryName[] {
  return sortHistoryNames(names).filter((entry) => entry.sequence === sequence);
}

/** The well-formed history names of `names`, oldest first. Names that are not history names are left out. */
export function sortHistoryNames(names: readonly string[]): readonly HistoryName[] {
  const parsed: HistoryName[] = [];
  for (const name of names) {
    const entry = parseHistoryName(name);
    if (entry !== undefined) parsed.push(entry);
  }
  return parsed.sort(compareHistoryNames);
}
