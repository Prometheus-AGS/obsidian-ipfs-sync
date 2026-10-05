// Delta review A-L1 and A-L5 (cli/io.ts).
//   A-L1  confirm and prompt are offered only when BOTH standard input and standard output are terminals.
//   A-L5  io.ts replaces the SAME unsafe characters escapeNodeText escapes (one range table), and keeps line breaks in multi-line output.
import { describe, expect, it, vi } from "vitest";
import { createProcessIo, promptText, stripControlCharacters } from "../../cli/io";
import { escapeNodeText } from "../../src/kubo";

type Tty = boolean | undefined;

function withStreams(stdin: Tty, stdout: Tty, run: () => void): void {
  const originalIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const originalOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
  try {
    run();
  } finally {
    if (originalIn === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", originalIn);
    if (originalOut === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
    else Object.defineProperty(process.stdout, "isTTY", originalOut);
  }
}

describe("a question is asked only where both ends are a terminal (A-L1)", () => {
  const cases: readonly (readonly [string, Tty, Tty, boolean])[] = [
    ["stdin and stdout are terminals", true, true, true],
    ["only stdin is a terminal", true, false, false],
    ["only stdin is a terminal (stdout unknown)", true, undefined, false],
    ["only stdout is a terminal", false, true, false],
    ["only stdout is a terminal (stdin unknown)", undefined, true, false],
    ["neither is a terminal", false, false, false],
    ["neither is known", undefined, undefined, false],
  ];

  it.each(cases)("%s: offered=%s", (_label, stdin, stdout, offered) => {
    withStreams(stdin, stdout, () => {
      const io = createProcessIo();
      expect(io.confirm !== undefined).toBe(offered);
      expect(io.prompt !== undefined).toBe(offered);
    });
  });
});

/** Characters the shared range table marks unsafe, each as a one-character string. */
const UNSAFE: readonly string[] = [
  "\u0000",
  "\u001b",
  "\u007f",
  "\u009b",
  "­",
  "؜",
  "​",
  "‌",
  "‍",
  "‎",
  "‏",
  " ",
  " ",
  "‪",
  "‮",
  "⁠",
  "⁦",
  "⁩",
  "﻿",
  String.fromCodePoint(0xe0000),
  String.fromCodePoint(0xe0041),
  String.fromCodePoint(0xe007f),
];

const SAFE = ["a", " ", "é", "日", "¬", "®", "‧", " ", " ", "⁥", "⁪", "﻾", "￰", String.fromCodePoint(0xe0080), "😀"];

describe("io.ts covers every character escapeNodeText escapes (A-L5)", () => {
  it.each(UNSAFE.map((c) => [`U+${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`, c] as const))("%s is replaced", (_label, character) => {
    expect(escapeNodeText(character)).not.toBe(character);
    expect(stripControlCharacters(`a${character}b`)).toBe("a?b");
    expect(promptText(`a${character}b`)).toBe("a?b [y/N] ");
  });

  it.each(SAFE.map((c) => [`U+${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`, c] as const))("%s is kept", (_label, character) => {
    expect(escapeNodeText(character)).toBe(character);
    expect(stripControlCharacters(`a${character}b`)).toBe(`a${character}b`);
  });

  it("agrees with escapeNodeText on a mixed string: the same positions are replaced", () => {
    const text = `names: x${" "}y${"​"}z${String.fromCodePoint(0xe0041)}w${"﻿"}v${"­"}u 日本`;
    const replaced = [...stripControlCharacters(text)].map((c) => c === "?");
    const escaped = [...text].map((c) => escapeNodeText(c) !== c);
    expect(replaced).toEqual(escaped);
  });

  it("io.out replaces them in a line and keeps the line breaks of multi-line text", () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      createProcessIo().out(`first forged\nsecond​ line\nthird${String.fromCodePoint(0xe0041)}`);
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual(["first?forged\nsecond? line\nthird?\n"]);
  });

  it("io.err replaces them", () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      createProcessIo().err("ipfs-sync: names  a﻿b");
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual(["ipfs-sync: names ?a?b\n"]);
  });
});
