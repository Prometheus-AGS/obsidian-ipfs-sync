import { malformed } from "./errors";

/*
 * Strict JSON for remote, attacker-influenced documents (`keyslots.json`) and for authenticated manifests.
 * Differences from `JSON.parse`: duplicate object keys are an error (JSON.parse keeps the last one silently),
 * nesting is bounded, and every object is created without a prototype, so a member named `__proto__` is plain data.
 * Errors are `malformed-input` with a fixed message; the text of the document is never echoed.
 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** At most this many nested containers (arrays and objects); the 33rd level is refused. Every document this project writes is at most 4 deep. */
export const JSON_MAX_DEPTH = 32;

const NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function invalid(): never {
  throw malformed("not valid JSON");
}

class Reader {
  private position = 0;

  constructor(
    private readonly text: string,
    private readonly integersOnly: boolean,
  ) {}

  parseDocument(): JsonValue {
    const value = this.value(0);
    this.skipSpace();
    if (this.position !== this.text.length) invalid();
    return value;
  }

  private skipSpace(): void {
    while (this.position < this.text.length && " \t\n\r".includes(this.text[this.position] ?? "")) this.position++;
  }

  /**
   * End index (exclusive) of the string token that starts at `start`. Scanned with a loop, not a regular
   * expression: a regular expression with a repeated alternation overflows the engine stack on multi-megabyte
   * strings, which would surface as a raw RangeError instead of a typed refusal.
   */
  private stringEnd(start: number): number {
    const text = this.text;
    for (let i = start + 1; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x22) return i + 1;
      if (code < 0x20) return invalid();
      if (code !== 0x5c) continue;
      const escape = text[i + 1] ?? "";
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return invalid();
        i += 5;
      } else if ('"\\/bfnrt'.includes(escape) && escape !== "") {
        i += 1;
      } else {
        return invalid();
      }
    }
    return invalid();
  }

  private string(): string {
    const end = this.stringEnd(this.position);
    const token = this.text.slice(this.position, end);
    this.position = end;
    return JSON.parse(token) as string;
  }

  private token(pattern: RegExp): string {
    pattern.lastIndex = this.position;
    const match = pattern.exec(this.text);
    if (match === null) return invalid();
    this.position += match[0].length;
    return match[0];
  }

  private literal(word: string): void {
    if (!this.text.startsWith(word, this.position)) invalid();
    this.position += word.length;
  }

  private value(depth: number): JsonValue {
    this.skipSpace();
    const char = this.text[this.position];
    if ((char === "{" || char === "[") && depth >= JSON_MAX_DEPTH) invalid();
    if (char === "{") return this.object(depth);
    if (char === "[") return this.array(depth);
    if (char === '"') return this.string();
    if (char === "t") return this.literal("true"), true;
    if (char === "f") return this.literal("false"), false;
    if (char === "n") return this.literal("null"), null;
    const token = this.token(NUMBER_TOKEN);
    // Canonical decimal integers only: no fraction, no exponent, no "-0", no leading zeros.
    if (this.integersOnly && !/^(?:0|-?[1-9]\d*)$/.test(token)) invalid();
    const number = Number(token);
    if (!Number.isFinite(number) || (this.integersOnly && !Number.isSafeInteger(number))) invalid();
    return number;
  }

  private array(depth: number): JsonValue {
    this.position++;
    const items: JsonValue[] = [];
    this.skipSpace();
    if (this.text[this.position] === "]") return this.position++, items;
    for (;;) {
      items.push(this.value(depth + 1));
      this.skipSpace();
      const next = this.text[this.position++];
      if (next === "]") return items;
      if (next !== ",") invalid();
    }
  }

  private object(depth: number): JsonValue {
    this.position++;
    const members = Object.create(null) as Record<string, JsonValue>;
    this.skipSpace();
    if (this.text[this.position] === "}") return this.position++, members;
    for (;;) {
      this.skipSpace();
      if (this.text[this.position] !== '"') invalid();
      const key = this.string();
      if (key in members) invalid();
      this.skipSpace();
      if (this.text[this.position++] !== ":") invalid();
      members[key] = this.value(depth + 1);
      this.skipSpace();
      const next = this.text[this.position++];
      if (next === "}") return members;
      if (next !== ",") invalid();
    }
  }
}

/**
 * Strict parse. With `integersOnly` every number must be a canonical decimal safe integer (used for the manifest,
 * where `1e2`, `1.0`, `-0` and `01` are refused by both readers).
 */
export function parseStrictJson(text: string, options: { readonly integersOnly?: boolean } = {}): JsonValue {
  return new Reader(text, options.integersOnly === true).parseDocument();
}

/** UTF-16 code-unit order, which is what `Array.prototype.sort` without a comparator uses. */
function sortedKeys(object: JsonObject): string[] {
  return Object.keys(object).sort();
}

function indentation(indent: number, level: number): string {
  return indent === 0 ? "" : `\n${" ".repeat(indent * level)}`;
}

function render(value: JsonValue, indent: number, level: number): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw malformed("not a JSON number");
    return JSON.stringify(value);
  }
  const inner = indentation(indent, level + 1);
  const close = indentation(indent, level);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${inner}${value.map((item) => render(item, indent, level + 1)).join(`,${inner}`)}${close}]`;
  }
  const object = value as JsonObject;
  const keys = sortedKeys(object);
  if (keys.length === 0) return "{}";
  const separator = indent === 0 ? ":" : ": ";
  const members = keys.map((key) => `${JSON.stringify(key)}${separator}${render(object[key] as JsonValue, indent, level + 1)}`);
  return `{${inner}${members.join(`,${inner}`)}${close}}`;
}

/**
 * Canonical rendering: keys sorted by UTF-16 code unit at every level, `JSON.stringify` string and number
 * escaping, and either the compact form (`indent` 0) or `JSON.stringify(value, null, 2)` layout with LF
 * (`indent` 2). No trailing newline is added. Sorting here (not by object insertion order) keeps integer-like
 * keys such as "10" and "2" in code-unit order, which a plain object would reorder.
 */
export function serializeCanonical(value: JsonValue, indent: 0 | 2): string {
  return render(value, indent, 0);
}

/** True when every number in the value is a safe integer (no floats, no exponents that produce a non-integer). */
export function containsOnlyIntegers(value: JsonValue): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(containsOnlyIntegers);
  if (typeof value === "object" && value !== null) return Object.values(value as JsonObject).every(containsOnlyIntegers);
  return true;
}
