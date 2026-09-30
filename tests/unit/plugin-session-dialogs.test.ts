import { describe, expect, it, vi } from "vitest";
import { CryptoError } from "../../src/crypto";
import { KuboNetworkError } from "../../src/kubo";
import {
  CLOSE_AND_RETRY_TEXT,
  UNLOCK_WRONG_TEXT,
  createSessionDialogs,
  describeDialogError,
  passphraseFormatCheck,
  type DialogFactories,
} from "../../src/plugin/session-dialogs";
import { createSessionKeys, type OpenRequest, type SessionKeys } from "../../src/plugin/session-keys";
import type { SetupCreateResult, SetupDialogRequest } from "../../src/plugin/setup-dialog";
import type { UnlockDialogRequest, UnlockResult } from "../../src/plugin/unlock-dialog";
import { observed } from "../../src/plugin/session-status";
import { VaultSetupRefusedError } from "../../src/plugin/vault-opener";
import type { UnlockedVault } from "../../src/sync/vault-keys";
import { REJECTED_PHRASES, VALID_PASSPHRASE } from "../vectors/passphrase";

const VAULT = { keys: {}, vaultId: "0".repeat(32), keySlots: new Uint8Array([1]), keySlotsSha256: "a".repeat(64) } as unknown as UnlockedVault;
const wrongPassphrase = (): CryptoError => new CryptoError("wrong-passphrase-or-damaged-slot", "wrong passphrase or damaged key slot");

interface Harness {
  readonly session: SessionKeys;
  readonly unlockDialogs: { request: UnlockDialogRequest; finish: (outcome: "unlocked" | "cancelled") => void; close: ReturnType<typeof vi.fn> }[];
  readonly setupDialogs: { request: SetupDialogRequest; finish: (outcome: "created" | "cancelled") => void; close: ReturnType<typeof vi.fn> }[];
  readonly opens: OpenRequest[];
  readonly changes: () => number;
  dispose(): void;
}

function harness(open: (request: OpenRequest) => Promise<UnlockedVault>, vaultExists = true): Harness {
  const unlockDialogs: Harness["unlockDialogs"] = [];
  const setupDialogs: Harness["setupDialogs"] = [];
  const opens: OpenRequest[] = [];
  const factories: DialogFactories = {
    unlock: (request, finish) => {
      const close = vi.fn();
      unlockDialogs.push({ request, finish, close });
      return { close };
    },
    setup: (request, finish) => {
      const close = vi.fn();
      setupDialogs.push({ request, finish, close });
      return { close };
    },
  };
  const dialogs = createSessionDialogs(factories);
  const observer = observed(
    dialogs.settling(
      createSessionKeys({
        dialogs: dialogs.callbacks,
        open: async (request) => {
          opens.push(request);
          return open(request);
        },
        vaultExists: async () => vaultExists,
      }),
    ),
  );
  let count = 0;
  observer.status({ openSetup: () => undefined, openUnlock: () => undefined }).subscribe?.(() => void (count += 1));
  return { session: observer.session, unlockDialogs, setupDialogs, opens, changes: () => count, dispose: dialogs.dispose };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function submit(h: Harness, text: string, onProgress: (fraction: number) => void = () => undefined): Promise<UnlockResult> {
  const dialog = h.unlockDialogs.at(-1);
  if (dialog === undefined) throw new Error("no unlock dialog is open");
  return dialog.request.unlock(text, onProgress);
}

describe("passphraseFormatCheck: the public canonical-passphrase function decides", () => {
  it("accepts a valid passphrase in any grouping and case", () => {
    expect(passphraseFormatCheck(VALID_PASSPHRASE.display)).toBeUndefined();
    expect(passphraseFormatCheck(VALID_PASSPHRASE.canonical.toLowerCase())).toBeUndefined();
    expect(passphraseFormatCheck(` ${VALID_PASSPHRASE.display.replaceAll("-", " ")} `)).toBeUndefined();
  });

  it("maps a wrong length, wrong characters and a failed check to the dialog's three problems", () => {
    expect(passphraseFormatCheck(VALID_PASSPHRASE.canonical.slice(1))).toBe("wrong-length");
    expect(passphraseFormatCheck(`${VALID_PASSPHRASE.canonical}A`)).toBe("wrong-length");
    expect(passphraseFormatCheck(`${VALID_PASSPHRASE.canonical.slice(0, 24)}!`)).toBe("wrong-characters");
    expect(passphraseFormatCheck(`${VALID_PASSPHRASE.canonical.slice(0, 23)}AB`)).toBe("check-failed");
    expect(passphraseFormatCheck(REJECTED_PHRASES[0].text)).toBe("check-failed");
  });
});

describe("unlock dialog spanning the session's attempts", () => {
  it("one dialog: the entry reaches the session, progress reaches the dialog, and success closes it", async () => {
    const h = harness(async (request) => {
      request.onProgress(0.5);
      return VAULT;
    });
    const progress: number[] = [];
    const unlocking = h.session.unlock();
    await settle();
    expect(h.unlockDialogs).toHaveLength(1);
    const verdict = submit(h, VALID_PASSPHRASE.display, (fraction) => void progress.push(fraction));
    expect((await unlocking).kind).toBe("unlocked");
    expect(await verdict).toEqual({ ok: true });
    expect(progress).toEqual([0.5]);
    expect(h.opens).toHaveLength(1);
    expect(h.session.state()).toBe("unlocked");
    expect(h.changes()).toBeGreaterThan(0);
  });

  it("a wrong passphrase answers the dialog in place and the same dialog takes the next entry", async () => {
    let attempt = 0;
    const h = harness(async () => {
      attempt += 1;
      if (attempt === 1) throw wrongPassphrase();
      return VAULT;
    });
    const unlocking = h.session.unlock();
    await settle();
    const first = await submit(h, VALID_PASSPHRASE.display);
    expect(first).toEqual({ ok: false, reason: UNLOCK_WRONG_TEXT });
    expect(JSON.stringify(first)).not.toContain(VALID_PASSPHRASE.canonical);
    const second = submit(h, VALID_PASSPHRASE.display);
    expect((await unlocking).kind).toBe("unlocked");
    expect(await second).toEqual({ ok: true });
    expect(h.unlockDialogs).toHaveLength(1);
  });

  it("cancelling the dialog cancels the unlock and derives nothing", async () => {
    const h = harness(async () => VAULT);
    const unlocking = h.session.unlock();
    await settle();
    h.unlockDialogs[0]?.finish("cancelled");
    expect(await unlocking).toEqual({ kind: "cancelled" });
    expect(h.opens).toHaveLength(0);
    expect(h.session.state()).toBe("locked");
  });

  it("an error after the entry shows its fixed message in the dialog, rejects the call, and a further entry is told to start again", async () => {
    const typed = VALID_PASSPHRASE.display;
    const h = harness(async () => {
      throw new KuboNetworkError("rpc", "http://node.test:5001", new Error("connection refused"));
    });
    const unlocking = h.session.unlock();
    const rejected = unlocking.then(() => undefined, (error: unknown) => error);
    await settle();
    const verdict = await submit(h, typed);
    expect(await rejected).toBeInstanceOf(KuboNetworkError);
    expect(verdict).toMatchObject({ ok: false });
    expect((verdict as { reason: string }).reason).toContain("cannot reach the rpc endpoint");
    expect(JSON.stringify(verdict)).not.toContain(VALID_PASSPHRASE.canonical);
    expect(await submit(h, typed)).toEqual({ ok: false, reason: CLOSE_AND_RETRY_TEXT });
    expect(h.session.state()).toBe("locked");
  });

  it("a new unlock reuses a dialog left open by an earlier failure", async () => {
    let fail = true;
    const h = harness(async () => {
      if (fail) throw new VaultSetupRefusedError("the root cannot be used");
      return VAULT;
    });
    const first = h.session.unlock().then(() => undefined, () => undefined);
    await settle();
    await submit(h, VALID_PASSPHRASE.display);
    await first;
    fail = false;
    const again = h.session.unlock();
    await settle();
    expect(h.unlockDialogs).toHaveLength(1);
    const verdict = submit(h, VALID_PASSPHRASE.display);
    expect((await again).kind).toBe("unlocked");
    expect(await verdict).toEqual({ ok: true });
  });

  it("an error of a kind that is not known to carry fixed text shows a generic line, never its message", async () => {
    expect(describeDialogError(new Error(`secret ${VALID_PASSPHRASE.canonical}`))).not.toContain(VALID_PASSPHRASE.canonical);
    expect(describeDialogError(new CryptoError("passphrase-format", "not a valid generated passphrase: it does not have exactly 25 symbols"))).toContain("25 symbols");
  });

  it("with no vault on the device, unlock reports not-set-up and opens no dialog", async () => {
    const h = harness(async () => VAULT, false);
    expect(await h.session.unlock()).toEqual({ kind: "not-set-up" });
    expect(h.unlockDialogs).toHaveLength(0);
    expect(h.setupDialogs).toHaveLength(0);
  });
});

describe("setup dialog", () => {
  it("Create hands the session the displayed passphrase; the session creates the vault with it; success closes the dialog", async () => {
    let created = "";
    const h = harness(async (request) => {
      created = String.fromCharCode(...(request.create ?? []));
      request.onProgress(0.25);
      return VAULT;
    }, false);
    const setting = h.session.setup();
    await settle();
    const dialog = h.setupDialogs[0];
    expect(dialog?.request.passphrase.replaceAll("-", "")).toHaveLength(25);
    const progress: number[] = [];
    const verdict = dialog?.request.create((fraction) => void progress.push(fraction));
    expect((await setting).kind).toBe("unlocked");
    expect(await verdict).toEqual({ ok: true });
    expect(progress).toEqual([0.25]);
    const opened = h.opens[0];
    expect(opened?.create).toBeDefined();
    expect(created).toBe(dialog?.request.passphrase.replaceAll("-", ""));
    expect(opened?.passphrase.every((byte) => byte === 0)).toBe(true); // wiped after the derivation
  });

  it("cancelling the dialog cancels the setup and creates nothing", async () => {
    const h = harness(async () => VAULT, false);
    const setting = h.session.setup();
    await settle();
    h.setupDialogs[0]?.finish("cancelled");
    expect(await setting).toEqual({ kind: "cancelled" });
    expect(h.opens).toHaveLength(0);
  });

  it("a creation error is shown in the dialog with its fixed text, and Create cannot be served again", async () => {
    const h = harness(async () => {
      throw new VaultSetupRefusedError("this MFS root already holds a vault");
    }, false);
    const setting = h.session.setup();
    const rejected = setting.then(() => undefined, (error: unknown) => error);
    await settle();
    const verdict = await (h.setupDialogs[0]?.request.create(() => undefined) as Promise<SetupCreateResult>);
    expect(await rejected).toBeInstanceOf(VaultSetupRefusedError);
    expect(verdict).toEqual({ ok: false, reason: "this MFS root already holds a vault" });
    const again = await (h.setupDialogs[0]?.request.create(() => undefined) as Promise<SetupCreateResult>);
    expect(again).toEqual({ ok: false, reason: CLOSE_AND_RETRY_TEXT });
  });

  it("dispose closes open dialogs and cancels the waiting call", async () => {
    const h = harness(async () => VAULT);
    const unlocking = h.session.unlock();
    await settle();
    h.dispose();
    expect(h.unlockDialogs[0]?.close).toHaveBeenCalled();
    h.unlockDialogs[0]?.finish("cancelled"); // what the real dialog does when it closes
    expect(await unlocking).toEqual({ kind: "cancelled" });
  });
});
