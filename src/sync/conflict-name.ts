/** Upper bound on same-day copies of one file; beyond it something is wrong and the file fails. */
export const MAX_CONFLICT_COPIES = 1000;

export class ConflictNameError extends Error {
  constructor(path: string) {
    super(`cannot find a free conflict copy name for "${path}" after ${MAX_CONFLICT_COPIES} tries`);
    this.name = "ConflictNameError";
  }
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DD` in the machine's local calendar (the date the person sees, not UTC). */
export function localDateStamp(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * `<stem> (ipfs conflict DATE).<ext>` next to the original. The extension is the part of the file
 * name after its last dot, kept so the copy opens in the same application. A name with no dot, or a
 * dotfile whose only dot is the leading one, gets the suffix at the end. `attempt` 1 is the plain
 * name; from 2 the counter goes inside the parentheses: `(ipfs conflict DATE 2)`.
 */
export function conflictCandidate(path: string, date: string, attempt: number): string {
  const slash = path.lastIndexOf("/");
  const directory = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const label = attempt <= 1 ? `ipfs conflict ${date}` : `ipfs conflict ${date} ${attempt}`;
  return `${directory}${stem} (${label})${extension}`;
}

/** The first candidate for which `exists` is false. Existing copies are never reused or overwritten. */
export async function chooseConflictName(
  path: string,
  date: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_CONFLICT_COPIES; attempt += 1) {
    const candidate = conflictCandidate(path, date, attempt);
    if (!(await exists(candidate))) return candidate;
  }
  throw new ConflictNameError(path);
}
