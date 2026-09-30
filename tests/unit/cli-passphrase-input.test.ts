import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassphraseInputError, readVaultPassphrase, type PassphraseHost } from "../../cli/passphrase-input";
import { createPassphraseFile, stripTerminator } from "../../cli/passphrase-file";
import { promptHidden } from "../../cli/passphrase-prompt";
import { PASSPHRASE_INPUT_MAX_BYTES } from "../../src/crypto";
import { createFakeTerminal, type FakeTerminal } from "../helpers/fake-terminal";
import { REJECTED_PHRASES, VALID_PASSPHRASE } from "../vectors/passphrase";

const POSIX_USER = process.getuid?.();
const decode = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString("ascii");

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof PassphraseInputError ? error.code : `other: ${String(error)}`;
  }
}

describe("passphrase sources", () => {
  let dir: string;
  let warnings: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-pass-"));
    warnings = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const host = (env: Record<string, string | undefined>, extra: Partial<PassphraseHost> = {}): PassphraseHost => ({
    env,
    platform: process.platform,
    userId: POSIX_USER,
    warn: (text) => void warnings.push(text),
    ...extra,
  });
  const secretFile = async (name: string, text: string, mode = 0o600): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, text, { mode });
    await chmod(path, mode);
    return path;
  };

  describe("environment variable", () => {
    it("canonicalises a hyphenated, lower-case passphrase to the 25 symbols", async () => {
      const result = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE: VALID_PASSPHRASE.display.toLowerCase() }));
      expect(decode(result)).toBe(VALID_PASSPHRASE.canonical);
    });

    it("returns undefined with no source and no terminal", async () => {
      expect(await readVaultPassphrase(host({}))).toBeUndefined();
    });

    it.each(REJECTED_PHRASES)("refuses %j with the passphrase-format explanation and without quoting it", async (phrase) => {
      const failure = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE: phrase.text })).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PassphraseInputError);
      const error = failure as PassphraseInputError;
      expect(error.code).toBe("passphrase-format");
      expect(error.message).toContain("check symbols do not match");
      expect(error.message).toContain("IPFS_SYNC_PASSPHRASE");
      expect(error.message).not.toContain(phrase.text);
      expect(error.message.toUpperCase()).not.toContain("HORSE");
    });

    it("refuses text of the wrong length and text outside the alphabet", async () => {
      await expect(readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE: "ABCDE-FGHIJ" }))).rejects.toMatchObject({ code: "passphrase-format" });
      await expect(readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE: "HEZVI-DN7IB-GLQIX-B5L7V-ARDH1" }))).rejects.toMatchObject({ code: "passphrase-format" });
      await expect(readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE: "" }))).rejects.toMatchObject({ code: "passphrase-format" });
    });
  });

  describe("file", () => {
    it("reads a 0600 file, removing only the terminating line feed or carriage-return-line-feed", async () => {
      for (const ending of ["", "\n", "\r\n"]) {
        const path = await secretFile("ok.txt", `${VALID_PASSPHRASE.display}${ending}`);
        expect(decode(await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: path })))).toBe(VALID_PASSPHRASE.canonical);
      }
      expect(warnings).toEqual([]);
    });

    it("removes exactly one terminator", () => {
      expect(decode(stripTerminator(Buffer.from("AB\n\n")))).toBe("AB\n");
      expect(decode(stripTerminator(Buffer.from("AB\r\n")))).toBe("AB");
      expect(decode(stripTerminator(Buffer.from("AB\r")))).toBe("AB\r");
      expect(decode(stripTerminator(Buffer.from("AB ")))).toBe("AB ");
    });

    it("refuses both variables set, before reading anything", async () => {
      const path = await secretFile("ok.txt", VALID_PASSPHRASE.display);
      const failure = readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE: VALID_PASSPHRASE.display, IPFS_SYNC_PASSPHRASE_FILE: path }));
      await expect(failure).rejects.toMatchObject({ code: "both-sources" });
      await expect(failure).rejects.toThrow(/exactly one/);
    });

    it.skipIf(process.platform === "win32").each([0o644, 0o640, 0o604, 0o660])("refuses a file with mode %o and names 0600", async (mode) => {
      const path = await secretFile("open.txt", VALID_PASSPHRASE.display, mode);
      const failure = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: path })).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "file-unsafe" });
      expect((failure as Error).message).toContain("0600");
      expect((failure as Error).message).not.toContain(VALID_PASSPHRASE.display);
    });

    it.skipIf(process.platform === "win32")("accepts a stricter mode (0400)", async () => {
      const path = await secretFile("ro.txt", VALID_PASSPHRASE.display, 0o400);
      expect(decode(await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: path })))).toBe(VALID_PASSPHRASE.canonical);
    });

    it.skipIf(process.platform === "win32")("refuses a symbolic link, even to a 0600 file", async () => {
      const real = await secretFile("real.txt", VALID_PASSPHRASE.display);
      const link = join(dir, "link.txt");
      await symlink(real, link);
      const failure = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: link })).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "file-unsafe" });
      expect((failure as Error).message).toContain("symbolic link");
    });

    it.skipIf(POSIX_USER === undefined || process.platform === "win32")("refuses a file owned by another user", async () => {
      const path = await secretFile("theirs.txt", VALID_PASSPHRASE.display);
      const failure = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: path }, { userId: (POSIX_USER ?? 0) + 1 })).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "file-unsafe" });
      expect((failure as Error).message).toContain("another user");
    });

    it.skipIf(process.platform === "win32")("refuses a named pipe at once instead of waiting for a writer to open it", { timeout: 5000 }, async () => {
      const pipe = join(dir, "pipe.txt");
      try {
        execFileSync("mkfifo", [pipe]);
      } catch {
        return;
      }
      const failure = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: pipe })).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "file-unsafe" });
      expect((failure as Error).message).toContain("not a regular file");
    });

    it("refuses a directory, a missing file and an oversize file", async () => {
      await mkdir(join(dir, "folder"));
      await expect(readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: join(dir, "folder") }))).rejects.toMatchObject({ code: "file-unsafe" });
      await expect(readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: join(dir, "missing") }))).rejects.toMatchObject({ code: "file-unreadable" });
      const big = await secretFile("big.txt", "A".repeat(PASSPHRASE_INPUT_MAX_BYTES + 3));
      await expect(readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: big }))).rejects.toMatchObject({ code: "file-unreadable" });
    });

    it.each(REJECTED_PHRASES)("refuses %j from a file with the passphrase-format explanation", async (phrase) => {
      const path = await secretFile("phrase.txt", `${phrase.text}\n`);
      const failure = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: path })).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "passphrase-format" });
      expect((failure as Error).message).toContain("check symbols do not match");
    });

    it("on a system without POSIX modes: warns that permissions cannot be verified, accepts a wide mode, still refuses a link", async () => {
      const path = await secretFile("wide.txt", VALID_PASSPHRASE.display, 0o644);
      const windows = { platform: "win32" as const, userId: undefined };
      expect(decode(await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: path }, windows)))).toBe(VALID_PASSPHRASE.canonical);
      expect(warnings.join("\n")).toContain("permissions cannot be verified");
      if (process.platform !== "win32") {
        const link = join(dir, "wlink.txt");
        await symlink(path, link);
        await expect(readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE_FILE: link }, windows))).rejects.toMatchObject({ code: "file-unsafe" });
      }
    });
  });

  describe("prompt", () => {
    const withTerminal = (terminal: FakeTerminal): PassphraseHost => host({}, { terminal });

    it("is a source only when standard input is a terminal", async () => {
      expect(await readVaultPassphrase(withTerminal(createFakeTerminal({ inputIsTty: false, answers: ["x\n"] })))).toBeUndefined();
      expect(await readVaultPassphrase(host({}, { terminal: undefined }))).toBeUndefined();
    });

    it("reads a pasted passphrase with separators, canonicalises it, and echoes nothing", async () => {
      const terminal = createFakeTerminal({ answers: [`${VALID_PASSPHRASE.display.toLowerCase()}\r`] });
      expect(decode(await readVaultPassphrase(withTerminal(terminal)))).toBe(VALID_PASSPHRASE.canonical);
      expect(terminal.written).toEqual(["Vault passphrase: ", "\n"]);
      expect(terminal.rawModes).toEqual([true, false]);
      expect(terminal.listeners()).toBe(0);
      expect(terminal.flowing()).toBe(false);
    });

    it("does not prompt when a variable is set (the variable wins over the prompt)", async () => {
      const terminal = createFakeTerminal({ answers: ["ignored\n"] });
      const result = await readVaultPassphrase(host({ IPFS_SYNC_PASSPHRASE: VALID_PASSPHRASE.display }, { terminal }));
      expect(decode(result)).toBe(VALID_PASSPHRASE.canonical);
      expect(terminal.rawModes).toEqual([]);
      expect(terminal.remaining()).toBe(1);
    });

    it("refuses a typed non-generated passphrase with the passphrase-format explanation, terminal restored", async () => {
      const terminal = createFakeTerminal({ answers: ["Correct Horse Battery Staple\n"] });
      await expect(readVaultPassphrase(withTerminal(terminal))).rejects.toMatchObject({ code: "passphrase-format" });
      expect(terminal.rawModes.at(-1)).toBe(false);
    });
  });
});

describe("no-echo prompt", () => {
  const read = (terminal: FakeTerminal): Promise<Uint8Array> => promptHidden(terminal, "Secret: ");

  it("handles backspace as one character, including a multi-byte character", async () => {
    const terminal = createFakeTerminal({ answers: [["ABD\u007fC", "é\u0008X\r"]] });
    expect(decode(await read(terminal))).toBe("ABCX");
  });

  it("ignores arrow-key escape sequences and other control bytes", async () => {
    const terminal = createFakeTerminal({ answers: [["AB\u001b[A\u001b[1;5CC", "\u0001\u0002D\n"]] });
    expect(decode(await read(terminal))).toBe("ABCD");
  });

  it("drops ESC O plus the one byte that follows it (application-mode arrow and function keys)", async () => {
    const terminal = createFakeTerminal({ answers: [["AB\u001bOAC", "\u001bOPD\r"]] });
    expect(decode(await read(terminal))).toBe("ABCD");
  });

  it("accepts a paste that arrives in several chunks and drops what follows the newline", async () => {
    const terminal = createFakeTerminal({ answers: [["HEZVI-DN7", "IB-GLQIX-B5L7V-ARDHC\nleftover"]] });
    expect(decode(await read(terminal))).toBe(VALID_PASSPHRASE.display);
  });

  it.each([
    ["Ctrl-C", "AB\u0003"],
    ["Ctrl-D", "AB\u0004"],
  ])("%s aborts, restores the terminal and leaves nothing attached", async (_name, typed) => {
    const terminal = createFakeTerminal({ answers: [typed] });
    await expect(read(terminal)).rejects.toMatchObject({ code: "aborted" });
    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.listeners()).toBe(0);
    expect(terminal.flowing()).toBe(false);
  });

  it("aborts when the input closes", async () => {
    const terminal = createFakeTerminal();
    const pending = read(terminal);
    terminal.send("AB");
    terminal.close();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.listeners()).toBe(0);
  });

  it("accepts exactly 256 bytes and refuses the 257th, restoring the terminal", async () => {
    const exact = createFakeTerminal({ answers: [`${"A".repeat(PASSPHRASE_INPUT_MAX_BYTES)}\n`] });
    expect((await read(exact)).length).toBe(PASSPHRASE_INPUT_MAX_BYTES);
    const over = createFakeTerminal({ answers: [`${"A".repeat(PASSPHRASE_INPUT_MAX_BYTES + 1)}\n`] });
    await expect(read(over)).rejects.toMatchObject({ code: "input-too-long" });
    expect(over.rawModes).toEqual([true, false]);
    expect(over.listeners()).toBe(0);
  });

  it("refuses to prompt without a terminal and never touches raw mode", async () => {
    const terminal = createFakeTerminal({ inputIsTty: false });
    await expect(read(terminal)).rejects.toMatchObject({ code: "no-terminal" });
    expect(terminal.rawModes).toEqual([]);
  });

  it("restores the terminal when switching to raw mode is what fails", async () => {
    const terminal = createFakeTerminal();
    const calls: boolean[] = [];
    const failing = {
      ...terminal,
      input: {
        ...terminal.input,
        setRawMode: (raw: boolean) => {
          calls.push(raw);
          if (raw) throw new Error("tty gone");
        },
      },
    };
    await expect(promptHidden(failing, "Secret: ")).rejects.toThrow("tty gone");
    expect(calls).toEqual([true, false]);
  });

  it("overwrites the chunks it was handed", async () => {
    const terminal = createFakeTerminal();
    const chunk = Buffer.from("ABC\n");
    const pending = read(terminal);
    terminal.send(chunk);
    expect(decode(await pending)).toBe("ABC");
    expect([...chunk]).toEqual([0, 0, 0, 0]);
  });
});

describe("creating the passphrase file", () => {
  let dir: string;
  const host = { platform: process.platform, userId: POSIX_USER };
  const content = new TextEncoder().encode("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE\n");

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "ipfs-sync-create-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const folder = async (name: string, mode: number): Promise<string> => {
    const path = join(dir, name);
    await mkdir(path);
    await chmod(path, mode);
    return path;
  };

  it.skipIf(process.platform === "win32").each([0o770, 0o707, 0o777])("refuses a folder with mode %o (group or others can change it, no sticky bit) and writes nothing", async (mode) => {
    const secret = await folder("open", mode);
    const failure = await createPassphraseFile(join(secret, "vault.pass"), content, host).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "file-target" });
    expect((failure as Error).message).toContain("sticky bit");
    expect(await readdir(secret)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("accepts a group- and world-writable folder that has the sticky bit, and the file is 0600", async () => {
    const shared = await folder("sticky", 0o1777);
    const path = await createPassphraseFile(join(shared, "vault.pass"), content, host);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path)).toEqual(Buffer.from(content));
  });

  it.skipIf(process.platform === "win32")("creates the file in the real folder when an ancestor of its folder is a symbolic link, and returns the path as given", async () => {
    const real = await folder("real", 0o700);
    await mkdir(join(real, "inner"), { mode: 0o700 });
    const via = join(dir, "via");
    await symlink(real, via);
    const given = join(via, "inner", "vault.pass");
    expect(await createPassphraseFile(given, content, host)).toBe(given);
    expect(await readFile(join(real, "inner", "vault.pass"))).toEqual(Buffer.from(content));
  });

  it("tells the user what to do with a file left by an interrupted init", async () => {
    const secret = await folder("secret", 0o700);
    await writeFile(join(secret, "vault.pass"), "old\n", { mode: 0o600 });
    const failure = await createPassphraseFile(join(secret, "vault.pass"), content, host).catch((error: unknown) => error);
    expect((failure as Error).message).toContain("interrupted");
    expect((failure as Error).message).toContain("delete it and run init again");
    expect(await readFile(join(secret, "vault.pass"), "utf8")).toBe("old\n");
  });
});
