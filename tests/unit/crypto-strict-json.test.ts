import { describe, expect, it } from "vitest";
import { CryptoError } from "../../src/crypto";
import { JSON_MAX_DEPTH, containsOnlyIntegers, parseStrictJson, serializeCanonical, type JsonValue } from "../../src/crypto/strict-json";

function refused(text: string): void {
  try {
    parseStrictJson(text);
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("malformed-input");
    return;
  }
  throw new Error(`expected a refusal for: ${text.slice(0, 40)}`);
}

describe("strict JSON parser", () => {
  it("agrees with JSON.parse on valid documents", () => {
    const samples = [
      "null", "true", "false", "0", "-0.5e+3", "123456789012", '"a\\n\\u0041\\ud83d\\ude00\\/"', "[]", "{}", " [ 1 , 2 , [ 3 ] ] ",
      '{"a":{"b":[true,false,null,"x"]},"c":1.5}', '{"\\u0061":1}', "\t\r\n{\n\"k\" : \"v\"\n}\n",
    ];
    for (const sample of samples) expect(JSON.parse(JSON.stringify(parseStrictJson(sample)))).toEqual(JSON.parse(sample));
  });

  it("refuses duplicate keys, also when one is spelled with an escape", () => {
    refused('{"a":1,"a":2}');
    refused('{"a":{"b":1,"b":1}}');
    refused('{"a":1,"\\u0061":2}');
    refused('[{"x":1,"x":1}]');
  });

  it("refuses malformed syntax", () => {
    for (const text of [
      "", " ", "{", "}", "[", "]", "[1,]", "[,1]", '{"a":1,}', '{"a"}', '{"a":}', '{a:1}', "{'a':1}", '{"a":1 "b":2}', "[1 2]",
      "01", "1.", ".5", "-", "+1", "1e", "1e+", "NaN", "Infinity", "-Infinity", "undefined", "tru", "nul", "TRUE",
      '"unterminated', '"bad\\x escape"', '"\\u12"', '"\\u12g4"', '"raw\ncontrol"', '"tab\there"', "1 2", "[] []", "{} x", "\ufeff{}", '"\\',
    ]) refused(text);
  });

  it("accepts a lone-surrogate escape as data and keeps a __proto__ member as an own property of a prototype-free object", () => {
    expect(parseStrictJson('"\\ud800"')).toBe("\ud800");
    const value = parseStrictJson('{"__proto__":{"polluted":true},"constructor":1}') as Record<string, JsonValue>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.keys(value).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(value["__proto__"])).toBeNull();
  });

  it("refuses nesting deeper than the limit as a typed error and never overflows the stack", () => {
    expect(JSON_MAX_DEPTH).toBe(32);
    expect(parseStrictJson("[".repeat(JSON_MAX_DEPTH) + "]".repeat(JSON_MAX_DEPTH))).toEqual(Array.from({ length: 1 }, () => JSON.parse("[".repeat(JSON_MAX_DEPTH - 1) + "]".repeat(JSON_MAX_DEPTH - 1))));
    refused("[".repeat(JSON_MAX_DEPTH + 2) + "]".repeat(JSON_MAX_DEPTH + 2));
    refused("[".repeat(200_000) + "]".repeat(200_000));
    refused('{"a":'.repeat(50_000));
  });

  it("parses multi-megabyte strings without a regular-expression stack overflow", () => {
    for (const size of [1_000_000, 30_000_000]) {
      const value = parseStrictJson(`{"a":"${"x".repeat(size)}"}`) as Record<string, string>;
      expect(value["a"]).toHaveLength(size);
    }
    const escapes = parseStrictJson(`"${"\\n\\u0041".repeat(500_000)}"`) as string;
    expect(escapes).toHaveLength(1_000_000);
    refused(`{"n":${"1".repeat(400)}}`);
  });

  it("parses 300,000 small objects", () => {
    const text = `[${Array.from({ length: 300_000 }, (_, i) => `{"k${i}":${i}}`).join(",")}]`;
    expect((parseStrictJson(text) as unknown[]).length).toBe(300_000);
  });
});

describe("canonical serialiser", () => {
  it("equals JSON.stringify of a key-sorted value for compact and two-space layouts", () => {
    const value = { z: [1, { b: 2, a: [] }, {}], a: "x\u00e9\n\"\\", m: { y: null, x: true, w: 1.5 }, e: [] };
    const sort = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v;
    expect(serializeCanonical(value as JsonValue, 0)).toBe(JSON.stringify(sort(value)));
    expect(serializeCanonical(value as JsonValue, 2)).toBe(JSON.stringify(sort(value), null, 2));
    expect(serializeCanonical([] as JsonValue, 2)).toBe("[]");
    expect(serializeCanonical({} as JsonValue, 2)).toBe("{}");
    expect(serializeCanonical(-0 as JsonValue, 2)).toBe("0");
  });

  it("sorts keys by UTF-16 code unit, including integer-like keys and astral characters", () => {
    expect(serializeCanonical({ "2": 1, "10": 2, b: 3, a: 4, "\u{1F600}": 5, "\uffff": 6 }, 0)).toBe('{"10":2,"2":1,"a":4,"b":3,"\u{1F600}":5,"\uffff":6}');
  });

  it("refuses non-finite numbers", () => {
    expect(() => serializeCanonical(Number.NaN, 0)).toThrowError(CryptoError);
    expect(() => serializeCanonical(Number.POSITIVE_INFINITY, 2)).toThrowError(CryptoError);
  });

  it("containsOnlyIntegers flags floats, unsafe integers and nested floats", () => {
    expect(containsOnlyIntegers({ a: [1, 2, { b: -3 }], c: "x", d: null, e: true })).toBe(true);
    expect(containsOnlyIntegers({ a: 1.5 })).toBe(false);
    expect(containsOnlyIntegers([[[0.1]]])).toBe(false);
    expect(containsOnlyIntegers(2 ** 53)).toBe(false);
  });
});
