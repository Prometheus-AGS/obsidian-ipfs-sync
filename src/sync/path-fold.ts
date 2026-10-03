// Fold key for path-segment comparison (mvp-07a design decision 11, spec path-hardening "Fold key").
// Pure. NFKC, case folding from the generated table (never the host's toLowerCase), the U+0131 / U+0130 supplement,
// then removal of Default_Ignorable_Code_Point, repeated until stable (at most three passes). String.prototype.normalize
// is the host's; its Unicode version may differ from the table's (stated residual).
import { CASE_FOLD_ENTRIES, DEFAULT_IGNORABLE_RANGES } from "./path-fold-table";

export const FOLD_MAX_PASSES = 3;

const DOTLESS_I = 0x0131;
const LATIN_SMALL_I = 0x0069;
const COMBINING_DOT_ABOVE = 0x0307;

const foldTable: ReadonlyMap<number, readonly number[]> = new Map(CASE_FOLD_ENTRIES);

function isDefaultIgnorable(codePoint: number): boolean {
  let low = 0;
  let high = DEFAULT_IGNORABLE_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = DEFAULT_IGNORABLE_RANGES[mid]!;
    if (codePoint < range[0]) high = mid - 1;
    else if (codePoint > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

/** Full case folding through the table, then the supplement: U+0131 becomes `i` and a U+0307 directly after `i` is dropped. */
function foldCaseWithSupplement(text: string): number[] {
  const out: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    const replacement = codePoint === DOTLESS_I ? [LATIN_SMALL_I] : (foldTable.get(codePoint) ?? [codePoint]);
    for (const folded of replacement) {
      if (folded === COMBINING_DOT_ABOVE && out[out.length - 1] === LATIN_SMALL_I) continue;
      out.push(folded);
    }
  }
  return out;
}

function foldPass(text: string): string {
  const folded = foldCaseWithSupplement(text.normalize("NFKC"));
  return folded.filter((codePoint) => !isDefaultIgnorable(codePoint)).map((codePoint) => String.fromCodePoint(codePoint)).join("");
}

/** The fold key of a path segment (or any string): equal keys mean the names are the same for protection purposes. */
export function foldKey(text: string): string {
  let current = text;
  for (let pass = 0; pass < FOLD_MAX_PASSES; pass++) {
    const next = foldPass(current);
    if (next === current) return next;
    current = next;
  }
  return current;
}
