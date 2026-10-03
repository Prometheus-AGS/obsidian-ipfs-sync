// Review-final-B findings B2-02 (plugin sinks) and B2-04: node-supplied text is escaped before a Notice, and the unlock dialog is
// answered as refused when the pull stops for a reason other than the passphrase.
import { describe, expect, it } from "vitest";
import { KuboHttpError } from "../../src/kubo";
import { pullFailedNotice, stoppedPullNotice } from "../../src/plugin/pull-notices";
import { pointNameAt, publishedOnce } from "../helpers/encrypted-pull-rig";
import { pluginOver } from "../helpers/plugin-pull-encrypted-rig";
import { ROOT } from "../helpers/publish-rig";

/** Every C0 control except tab and newline, DEL, the C1 controls and the bidirectional overrides. */
const RAW_CONTROL = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`);
const HOSTILE = `\u001b[2K\u001b]0;owned\u0007\u009b31m${String.fromCodePoint(0x202e)}gnp.exe\u001b[Aipfs-sync: pull complete`;

describe("node-supplied text in plugin notices (B2-02)", () => {
  it("escapes control characters in the failure notice of a pull", () => {
    const notice = pullFailedNotice(new Error(HOSTILE));
    expect(notice).not.toMatch(RAW_CONTROL);
    expect(notice).toContain("\\u001b");
    expect(notice).toContain("pull failed");
  });

  it("escapes control characters in the stop notice of a pull", () => {
    const { text } = stoppedPullNotice({ reason: "manifest-not-authentic", message: HOSTILE });
    expect(text).not.toMatch(RAW_CONTROL);
    expect(text).toContain("\\u009b");
  });

  it("builds a KuboHttpError whose message cannot carry a control sequence", () => {
    const error = new KuboHttpError("rpc", "http://node.invalid/api/v0/x", 500, HOSTILE, HOSTILE);
    expect(error.message).not.toMatch(RAW_CONTROL);
    expect(error.message).toContain("answered HTTP 500");
    expect(pullFailedNotice(error)).not.toMatch(RAW_CONTROL);
  });
});

describe("the unlock dialog after a stop that is not about the passphrase (B2-04)", () => {
  it("is answered as refused with the reason, not as success", async () => {
    const publisher = await publishedOnce();
    publisher.node.files.set(`${ROOT}/manifest.enc`, new Uint8Array(300).fill(7));
    pointNameAt(publisher.node);
    const b = pluginOver(publisher);

    const outcome = await b.pull();

    expect(outcome).toMatchObject({ kind: "stopped", reason: "manifest-not-authentic" });
    expect(b.passphrase.requests).toHaveLength(1);
    expect(b.passphrase.verdicts).toEqual([{ ok: false, reason: expect.stringContaining("does not authenticate") }]);
  });

  it("is answered as success when the pull went on past the passphrase", async () => {
    const b = pluginOver(await publishedOnce());
    expect((await b.pull()).kind).toBe("completed");
    expect(b.passphrase.verdicts).toEqual([{ ok: true }]);
  });
});

