import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIRST_PULL_GATEWAY_STATEMENT } from "../../src/sync/encrypted-pull";
import { describePullRecord, type EncryptionStatusSource } from "../../src/plugin/encryption-settings-model";
import { FIXTURE_ONLY_PULL_NOTICE } from "../../src/sync/pull-guard";
import { encryptedPullNotice, encryptedPullStatusText, isEventfulReport, PLAINTEXT_UNSUPPORTED_NOTICE, stoppedPullNotice, unfinishedCount, type PullReport } from "../../src/plugin/pull-notices";
import { PULL_NAME_MESSAGE } from "../../src/plugin/pull-target";
import { publishedNotice, unchangedNotice } from "../../src/plugin/publish-notices";
import { describePullTarget } from "../../src/plugin/settings-activity";
import { DEFAULT_PULL_CONFIRM_ABOVE_MB } from "../../src/plugin/settings-model";
import { IpfsSyncSettingTab } from "../../src/plugin/settings-tab";
import { createSettingsViewModel } from "../../src/plugin/settings-view-model";
import { PULL_CONFIRM_ABOVE_DEFAULT } from "../../src/sync/pull-budget";
import type { PublishResult } from "../../src/sync/publish";
import { byId, referencedText } from "../support/fake-dom";
import { App, Plugin } from "../support/obsidian-stub";
import { controlFor, flush, memoryStore, NODE_KEYS, NOW, open, type } from "../support/settings-tab-rig";
import type { FakeEl } from "../support/fake-dom";

const REPORT: PullReport = {
  mode: "pull",
  sequence: 7,
  fetched: 3,
  unchanged: 10,
  conflictCopies: [],
  integrityFailed: [],
  unfetched: [],
  skippedExpected: [],
  skippedUnsafe: [],
  remoteDeleted: 0,
};

describe("encrypted pull notice", () => {
  it("says complete only when nothing failed or was left unfetched", () => {
    const text = encryptedPullNotice(REPORT);
    expect(text).toContain("Pull complete (sequence 7): 3 fetched, 10 unchanged, 0 conflict copies");
    expect(text).not.toContain("unfinished");
  });

  it("says incomplete, names the count of files not written and says the vault is not up to date, for integrity failures", () => {
    const text = encryptedPullNotice({ ...REPORT, integrityFailed: [{ path: "a.md", reason: "authentication failed" }, { path: "b.md" }] });
    expect(text).toContain("Pull incomplete (sequence 7)");
    expect(text).not.toContain("Pull complete");
    expect(text).toContain('2 files were not written because they failed the integrity check. The vault is not up to date: "a.md" (authentication failed), "b.md"');
  });

  it("says that unfinished files are kept as the node has them and are not published from this device", () => {
    const text = encryptedPullNotice({ ...REPORT, unfetched: [{ path: "big.bin", reason: "declined: over your size limit" }] });
    expect(text).toContain('1 file was not fetched: "big.bin" (declined: over your size limit)');
    expect(text).toContain("1 file is unfinished on this device. Your next publish keeps it as the node has it, and does not publish anything from this device for them. Pull again to retry.");
    expect(unfinishedCount({ ...REPORT, unfetched: [{ path: "x" }], integrityFailed: [{ path: "y" }] })).toBe(2);
  });

  it("keeps expected and unsafe skips apart from failures, and they do not make a pull incomplete", () => {
    const text = encryptedPullNotice({ ...REPORT, skippedExpected: [".obsidian/app.json"], skippedUnsafe: ["CON.md", "a:b.md"] });
    expect(text).toContain("Pull complete");
    expect(text).toContain("1 path skipped by this device's exclusion list: \".obsidian/app.json\"");
    expect(text).toContain("2 paths skipped as unsafe on this device: \"CON.md\", \"a:b.md\"");
  });

  it("names at most three paths and counts the rest", () => {
    const text = encryptedPullNotice({ ...REPORT, conflictCopies: ["a", "b", "c", "d", "e"].map((n) => `${n}.md`) });
    expect(text).toContain('Conflict copies: "a.md", "b.md", "c.md" and 2 more');
  });

  it("escapes control characters and bidirectional overrides in a path from the node", () => {
    const text = encryptedPullNotice({ ...REPORT, skippedUnsafe: ["x\u009b31m‮.md"], unfetched: [{ path: "y\u0007.md", reason: "r\u001b" }] });
    expect(text).toContain("x\\u009b31m\\u202e.md");
    expect(text).toContain("y\\u0007.md");
    expect(text).toContain("r\\u001b");
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/);
  });

  it("describes a restore without success claims it cannot make and says later files were not removed", () => {
    const text = encryptedPullNotice({ ...REPORT, mode: "restore", sequence: 4 });
    expect(text).toContain("Restore finished (sequence 4)");
    expect(text).toContain("Files created after this version were not removed.");
    expect(text).toContain("your next publish makes this a new version");
    const failed = encryptedPullNotice({ ...REPORT, mode: "restore", unfetched: [{ path: "q.md" }] });
    expect(failed).toContain("Restore incomplete (sequence 7)");
    expect(failed).not.toContain("Restore finished");
  });

  it("describes a fork resolution and keeps notes after the lines", () => {
    const text = encryptedPullNotice({ ...REPORT, mode: "fork-resolution", conflictCopies: ["n (ipfs conflict 2026-10-01).md"] }, ["manifests/ is nearly full"]);
    expect(text).toContain("Fork resolution finished (sequence 7)");
    expect(text.split("\n").at(-1)).toBe("Note: manifests/ is nearly full");
  });

  it("builds the status text from counts only and flags unfinished files in words", () => {
    const at = new Date(2026, 9, 1, 9, 5);
    expect(encryptedPullStatusText(REPORT, at)).toBe("IPFS Sync: pull 09:05: 3 fetched, 0 conflicts");
    expect(encryptedPullStatusText({ ...REPORT, unfetched: [{ path: "x" }] }, at)).toBe("IPFS Sync: pull 09:05: 3 fetched, 0 conflicts, 1 unfinished");
    expect(isEventfulReport({ ...REPORT, fetched: 0 })).toBe(false);
    expect(isEventfulReport({ ...REPORT, fetched: 0, unfetched: [{ path: "x" }] })).toBe(true);
  });
});

describe("stopped pull notice", () => {
  it("names a fork, not an attack, and offers the Resolve fork action", () => {
    const notice = stoppedPullNotice({ reason: "fork", message: "sequence 5 exists here ... run the pull with --resolve-fork" });
    expect(notice.action).toBe("resolve-fork");
    expect(notice.text).toContain("a fork");
    expect(notice.text).toContain("not by itself a sign of an attack");
    expect(notice.text).toContain("Use Resolve fork");
    expect(notice.text).not.toContain("--");
  });

  it("refuses an older version without offering a rollback or a flag", () => {
    const notice = stoppedPullNotice({ reason: "older", message: "the target has sequence 2 ...; repeat the pull with --allow-rollback" });
    expect(notice.action).toBeUndefined();
    expect(notice.text).toContain("Nothing was written to your vault.");
    expect(notice.text).not.toMatch(/--|rollback|restore/i);
  });

  it("uses the pull's own fixed message otherwise, adds the command-line hint when it names an option, and uses no success wording", () => {
    const plain = stoppedPullNotice({ reason: "wrong-passphrase", message: "the vault was not unlocked: wrong passphrase or damaged key slots" });
    expect(plain.text).toBe("IPFS Sync: pull stopped: the vault was not unlocked: wrong passphrase or damaged key slots. Nothing was written to your vault.");
    const flagged = stoppedPullNotice({ reason: "vault-mismatch", message: "run ipfs-sync keys accept-slots --yes" });
    expect(flagged.text).toContain("Command-line options are available in the ipfs-sync command line tool.");
    expect(`${plain.text}${flagged.text}`).not.toMatch(/complete|success/i);
  });

  it("says a declined first pull wrote nothing", () => {
    const notice = stoppedPullNotice({ reason: "first-pull-declined", message: "declined" });
    expect(notice.text).toContain("Nothing was written: no file, no record of this vault and no copy of the key slots.");
  });
});

describe("pull copy that replaced the placeholders", () => {
  it("no longer says that encrypted pull arrives later, and keeps the fixture-only wording", () => {
    expect(PLAINTEXT_UNSUPPORTED_NOTICE).not.toMatch(/next change|later release|arrives|--allow|switched off|downgrade/);
    expect(PLAINTEXT_UNSUPPORTED_NOTICE).toContain("plaintext publications are no longer supported");
    expect(FIXTURE_ONLY_PULL_NOTICE).not.toMatch(/next change|later release|arrives/);
    expect(FIXTURE_ONLY_PULL_NOTICE).toContain("stays disabled in this build");
    expect(FIXTURE_ONLY_PULL_NOTICE).toContain("Only fixture vaults");
  });

  it("makes the pull-name message mention /ipfs/<cid>", () => {
    expect(PULL_NAME_MESSAGE).toContain("/ipfs/<cid>");
    expect(PULL_NAME_MESSAGE).toContain("no spaces");
  });

  it("describes an explicit root as an advanced input whose bytes the client does not verify against the CID", () => {
    const text = describePullTarget({ kind: "explicit-root", cid: "bafyexample" });
    expect(text).toContain("An explicit root will be pulled: bafyexample.");
    expect(text).toContain("advanced input");
    expect(text).toContain(FIRST_PULL_GATEWAY_STATEMENT);
  });

  it("takes the ceiling default from the pull budget", () => {
    expect(DEFAULT_PULL_CONFIRM_ABOVE_MB * 1024 * 1024).toBe(PULL_CONFIRM_ABOVE_DEFAULT);
  });
});

// ---------- publish notices ----------

const PUBLISHED: PublishResult = {
  published: true,
  written: 2,
  removed: 0,
  skipped: [],
  carried: [],
  dropped: [],
  keyId: "k51x",
  keyCreated: false,
  rootCid: "bafyrootrootrootrootroot",
  sequence: 8,
  warnings: [],
  anomalies: 0,
};

describe("publish notices: carried, dropped and warnings", () => {
  it("is unchanged when there is nothing to add", () => {
    expect(publishedNotice(PUBLISHED)).toBe("IPFS Sync: published: 2 written, 0 removed (root bafyrootrootroot...).");
  });

  it("names carried and dropped paths (at most three, escaped) and the warnings, in both notices", () => {
    const result: PublishResult = {
      ...PUBLISHED,
      carried: ["CON.md", "Note.md", "note.md", "d‮.md"],
      dropped: [{ path: ".obsidian/app.json", reason: "excluded" }],
      warnings: ["manifests/ holds 1,900 of 2,000 entries"],
    };
    for (const text of [publishedNotice(result), unchangedNotice(result)]) {
      expect(text).toContain('4 not published from this device (no current copy here; kept as the node has them): "CON.md", "Note.md", "note.md" and 1 more.');
      expect(text).toContain('1 dropped from the manifest (excluded on this device, or an unsafe path): ".obsidian/app.json".');
      expect(text).toContain(" Note: manifests/ holds 1,900 of 2,000 entries");
      expect(text).not.toContain("‮");
    }
  });

  it("escapes a control character in a carried path from the node", () => {
    const text = publishedNotice({ ...PUBLISHED, carried: ["x\u009b2J.md"] });
    expect(text).toContain("x\\u009b2J.md");
    expect(text).not.toContain("\u009b");
  });
});

// ---------- settings: ceiling field, pull record ----------

const ceilingDescription = (root: FakeEl): string => referencedText(root, controlFor(root, "Ask before pulling more than (MB)").getAttr("aria-describedby"));

describe("settings tab: pull ceiling", () => {
  it("is a labelled numeric field with its range and the effect of declining in words", async () => {
    const { root } = await open();
    const field = controlFor(root, "Ask before pulling more than (MB)");
    expect(field.value).toBe("512");
    expect(field.getAttr("inputmode")).toBe("numeric");
    const text = ceilingDescription(root);
    expect(text).toContain("from 64 to 8192");
    expect(text).toContain("Default: 512");
    expect(text).toContain("nothing is fetched and those files stay unfinished");
  });

  it("refuses 63 and 8193 with a text error tied to the field and keeps the stored value", async () => {
    const { root, store } = await open();
    for (const bad of ["63", "8193", "abc"]) {
      await type(root, "Ask before pulling more than (MB)", bad);
      expect(ceilingDescription(root), bad).toMatch(/Error: The pull ceiling must be a whole number of megabytes from 64 to 8192\./);
      expect(controlFor(root, "Ask before pulling more than (MB)").getAttr("aria-invalid")).toBe("true");
      expect(store.get().pullConfirmAboveMb).toBe(512);
    }
    await type(root, "Ask before pulling more than (MB)", "1024");
    expect(store.get().pullConfirmAboveMb).toBe(1024);
    expect(ceilingDescription(root)).not.toContain("Error:");
    expect(controlFor(root, "Ask before pulling more than (MB)").getAttr("aria-invalid")).toBeNull();
  });

  it("shows the explicit-root note on the target line when the pull name is /ipfs/<cid>", async () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const { root } = await open({ pullName: `/ipfs/${cid}` });
    const line = byId(root, "ipfs-sync-pull-target")?.text ?? "";
    expect(line).toContain(`An explicit root will be pulled: ${cid}.`);
    expect(line).toContain("advanced input");
    expect(line).toContain("does not verify the returned bytes");
  });
});

describe("pull record", () => {
  it("shows sequence, completeness, the unfinished count and restoredFrom in words", () => {
    expect(describePullRecord({ highestSequence: 7, complete: false, unfinished: 3, restoredFrom: 4 }).text).toBe(
      "Highest sequence recorded: 7. The last pull was incomplete. 3 files are unfinished: your next publish keeps them as the node has them, " +
        "and publishes nothing from this device for them. A restore took sequence 4; your next publish makes it a new version.",
    );
    expect(describePullRecord({ highestSequence: 2, complete: true, unfinished: 0, restoredFrom: undefined }).text).toBe(
      "Highest sequence recorded: 2. The last pull was complete.",
    );
    expect(describePullRecord({ highestSequence: 2, complete: false, unfinished: 1, restoredFrom: undefined }).text).toContain("1 file is unfinished");
    expect(describePullRecord(undefined)).toEqual({ exists: false, text: "This device has no pull record for this vault yet." });
  });

  async function openWith(pullRecord: EncryptionStatusSource["pullRecord"]): Promise<FakeEl> {
    const store = memoryStore({});
    const vm = createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => NODE_KEYS });
    const app = new App();
    const source: EncryptionStatusSource = { state: () => "unlocked", lock: () => undefined, ...(pullRecord === undefined ? {} : { pullRecord }) };
    const tab = new IpfsSyncSettingTab(app as unknown as ObsidianApp, new Plugin(app) as unknown as ObsidianPlugin, vm, source);
    tab.display();
    await flush();
    return (tab as unknown as { containerEl: FakeEl }).containerEl;
  }

  it("is shown in the Encryption section after an incomplete pull", async () => {
    const root = await openWith(async () => ({ highestSequence: 7, complete: false, unfinished: 3, restoredFrom: undefined }));
    expect(root.textContent()).toContain("Pull record");
    expect(root.textContent()).toContain("Highest sequence recorded: 7. The last pull was incomplete. 3 files are unfinished");
  });

  it("says so in words when the state cannot be read, and shows no row when the source offers none", async () => {
    const broken = await openWith(async () => {
      throw new Error("lower-layer-detail");
    });
    expect(broken.textContent()).toContain("The pull record could not be read.");
    expect(broken.textContent()).not.toContain("lower-layer-detail");
    const none = await openWith(undefined);
    expect(none.textContent()).not.toContain("Pull record");
  });
});

// ---------- source rules ----------

describe("new pull UI sources", () => {
  const FILES = [
    "first-pull-dialog.ts",
    "first-pull-dialog-model.ts",
    "restore-dialog.ts",
    "restore-dialog-model.ts",
    "fork-dialog.ts",
    "fork-dialog-model.ts",
    "large-pull-dialog.ts",
    "large-pull-dialog-model.ts",
    "pull-confirm-dialog.ts",
    "pull-confirm-model.ts",
    "pull-dialog-copy.ts",
    "pull-notices.ts",
    "publish-notices.ts",
    "settings-tab-pull.ts",
    "encryption-settings.ts",
  ];

  it("build no markup from text and have no clipboard access", () => {
    for (const file of FILES) {
      const source = readFileSync(new URL(`../../src/plugin/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|clipboard|execCommand|document\.write/i);
    }
  });
});
