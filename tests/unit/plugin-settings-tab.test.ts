import type { App as ObsidianApp } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdoptKeyDialog } from "../../src/plugin/adopt-key-dialog";
import { keyReasonSentence } from "../../src/plugin/settings-tab-copy";
import { AUTH_SCHEMES } from "../../src/plugin/settings-model";
import { ADOPT_CONSEQUENCES, createSettingsViewModel, FIELD_IDS, SECRET_FIELDS, type FieldId } from "../../src/plugin/settings-view-model";
import { byId, focusOrder, referencedText, type FakeEl } from "../support/fake-dom";
import { App, Modal } from "../support/obsidian-stub";
import { controlFor, flush, labelOf, memoryStore, NODE_KEYS, NOW, open, OWNED_ID, PEER_ID, type } from "../support/settings-tab-rig";

const ENCRYPTION_NOTE = "Every publish is encrypted with your vault passphrase before anything leaves this device.";

beforeEach(() => Modal.reset());

describe("settings tab: labels and controls", () => {
  it("shows the encryption note first, with its own title, and no fixture-only or review-pending wording (the guard is removed)", async () => {
    const { root } = await open();
    const first = root.children[0];
    expect(first?.hasClass("callout")).toBe(true);
    expect(first?.textContent()).toContain("Publishing is encrypted");
    expect(first?.textContent()).toContain(ENCRYPTION_NOTE);
    expect(root.textContent()).not.toMatch(/Fixture-only build|independently reviewed|only publishes fixture vaults/);
  });

  it("renders a labelled control for every view-model field, across all four schemes", async () => {
    const { root, vm } = await open();
    const seen = new Set<FieldId>();
    for (const scheme of AUTH_SCHEMES) {
      await type(root, "Authentication scheme", scheme);
      for (const field of [...vm.visibleAuthFields(), "authScheme" as const]) seen.add(field);
      for (const input of focusOrder(root).filter((el) => el.tag === "input" || el.tag === "select")) {
        expect(labelOf(root, input), `an input under scheme ${scheme} has no label`).not.toBe("");
      }
    }
    for (const field of ["rpcUrl", "rpcPort", "gatewayUrl", "gatewayPort", "publicationKey", "mfsRoot", "publishIntervalMinutes"] as const) seen.add(field);
    expect([...seen].sort()).toEqual([...FIELD_IDS].sort());
  });

  it("gives every focusable control an accessible name, and every input a description", async () => {
    const { root } = await open();
    for (const el of focusOrder(root)) expect(labelOf(root, el), `${el.tag} has no accessible name`).not.toBe("");
    for (const el of focusOrder(root).filter((c) => c.tag === "input" || c.tag === "select")) {
      expect(el.getAttr("aria-describedby"), "input without aria-describedby").not.toBeNull();
    }
  });

  it("shows only the fields of the selected scheme and keeps the picker element", async () => {
    const { root } = await open({ auth: { scheme: "bearer", token: "t-123" } });
    const picker = controlFor(root, "Authentication scheme");
    expect(labelOf(root, controlFor(root, "Bearer token"))).toBe("Bearer token");
    await type(root, "Authentication scheme", "basic");
    expect(focusOrder(root).some((el) => labelOf(root, el) === "Bearer token")).toBe(false);
    expect(controlFor(root, "User")).toBeDefined();
    expect(controlFor(root, "Password")).toBeDefined();
    expect(controlFor(root, "Authentication scheme")).toBe(picker);
  });
});

describe("settings tab: secrets", () => {
  it("masks every secret field and shows the plain-text warning as text near the auth fields", async () => {
    const { root } = await open();
    const picker = controlFor(root, "Authentication scheme");
    const secretLabels = { authPassword: "Password", authToken: "Bearer token", authHeaderValue: "Header value" } as const;
    for (const [scheme, field] of [["basic", "authPassword"], ["bearer", "authToken"], ["header", "authHeaderValue"]] as const) {
      await type(root, "Authentication scheme", scheme);
      const secret = controlFor(root, secretLabels[field]);
      expect(secret.type, `${field} must be masked`).toBe("password");
      expect(referencedText(root, secret.getAttr("aria-describedby"))).toContain("unencrypted");
    }
    expect([...SECRET_FIELDS].sort()).toEqual(Object.keys(secretLabels).sort());
    const warning = byId(root, "ipfs-sync-secrets-warning");
    expect(warning?.textContent()).toContain("Secrets are stored in plain text");
    expect(warning?.textContent()).toContain(".obsidian/plugins/ipfs-sync/data.json");
    const nodes = root.descendants();
    expect(nodes.indexOf(warning as FakeEl)).toBeLessThan(nodes.indexOf(picker));
  });

  it("leaves non-secret fields as plain text inputs", async () => {
    const { root } = await open({ auth: { scheme: "basic", user: "ann", password: "pw" } });
    expect(controlFor(root, "User").type).toBe("text");
    expect(controlFor(root, "RPC URL").type).toBe("text");
  });
});

describe("settings tab: inline errors", () => {
  it("names both ports in text tied to the field, marks it invalid, and keeps the saved value", async () => {
    const { root, store } = await open();
    await type(root, "RPC URL", "https://rpc.example.org:5001");
    await type(root, "RPC port", "8080");
    const port = controlFor(root, "RPC port");
    const url = controlFor(root, "RPC URL");
    const errors = [port, url].map((el) => referencedText(root, el.getAttr("aria-describedby")));
    expect(errors.some((text) => /Error: .*5001.*8080|Error: .*8080.*5001/s.test(text))).toBe(true);
    expect([port, url].some((el) => el.getAttr("aria-invalid") === "true")).toBe(true);
    // The URL alone was valid and saved; the conflicting port was refused.
    expect(store.get().rpc).toEqual({ url: "https://rpc.example.org:5001" });
  });

  it("explains a foreign MFS root beside the field, clears it when fixed, and saves the fix", async () => {
    const { root, store } = await open();
    await type(root, "MFS root", "/obsidian-vault-staging");
    const field = controlFor(root, "MFS root");
    expect(referencedText(root, field.getAttr("aria-describedby"))).toMatch(/Error: .*obsidian-vault-sync/);
    expect(field.getAttr("aria-invalid")).toBe("true");
    expect(store.get().mfsRoot).toBe("/obsidian-vault-sync/default");
    await type(root, "MFS root", "/obsidian-vault-sync/notes");
    expect(referencedText(root, field.getAttr("aria-describedby"))).not.toContain("Error:");
    expect(field.getAttr("aria-invalid")).toBeNull();
    expect(store.get().mfsRoot).toBe("/obsidian-vault-sync/notes");
  });

  it("rejects another project's key name with text and keeps the previous name", async () => {
    const { root, store } = await open();
    await type(root, "Publication key name", "consult-capture");
    expect(referencedText(root, controlFor(root, "Publication key name").getAttr("aria-describedby"))).toContain("Error:");
    expect(store.get().publicationKey).toBe("obsidian-vault-sync");
  });

  it("shares one auth error across the auth controls, and an incomplete scheme says it is not saved", async () => {
    const { root, store } = await open();
    await type(root, "Authentication scheme", "basic");
    await type(root, "User", "ann");
    const status = byId(root, "ipfs-sync-auth-status");
    expect(status?.textContent()).toContain("Not saved yet");
    expect(store.get().auth.scheme).toBe("none");
    for (const label of ["User", "Password"]) {
      expect(controlFor(root, label).getAttr("aria-describedby")).toContain("ipfs-sync-error-auth");
      expect(controlFor(root, label).getAttr("aria-describedby")).toContain("ipfs-sync-auth-status");
    }
    await type(root, "Password", "pw");
    expect(store.get().auth).toEqual({ scheme: "basic", user: "ann", password: "pw" });
    expect(status?.textContent()).not.toContain("Not saved yet");
  });

  it("warns in words about an expired JWT and still saves it", async () => {
    const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const expired = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(NOW.getTime() / 1000) - 3600 })}.sig`;
    const { root, store } = await open();
    await type(root, "Authentication scheme", "bearer");
    await type(root, "Bearer token", expired);
    expect(store.get().auth).toEqual({ scheme: "bearer", token: expired });
    expect(byId(root, "ipfs-sync-auth-status")?.textContent()).toMatch(/^Warning: .*expire/i);
  });
});

describe("settings tab: keyboard order", () => {
  it("visits controls in reading order, top to bottom", async () => {
    const { root } = await open();
    await flush();
    const labels = focusOrder(root).map((el) => labelOf(root, el));
    const expected = [
      "RPC URL",
      "RPC port",
      "Gateway URL",
      "Gateway port",
      "Gateway authentication",
      "Publication key name",
      "MFS root",
      "Auto-publish interval (minutes)",
      "Authentication scheme",
      "Add an exclusion",
      "Add",
      "Publication key: ask the node about the publication key",
      "Adopt a key by ID",
      "Adopt...",
      "Pull IPNS name",
      "Ask before pulling more than (MB)",
      "Catch up on load",
      "Read cap (MB)",
    ];
    // "Check again" is labelled by aria-label; its visible text is "Check again".
    expect(labels.map((l) => l.replace(/^Check again: .*/, "Publication key: ask the node about the publication key"))).toEqual(expected);
  });
});

describe("settings tab: exclusions", () => {
  it("shows defaults as fixed, lists additions with remove buttons, and changes the hash on add", async () => {
    const { root, store } = await open();
    const hashOf = (): string => root.find((el) => el.tag === "code" && /^[0-9a-f]{16,}$/.test(el.text))?.text ?? "";
    const before = hashOf();
    expect(root.textContent()).toContain(".trash/");
    expect(root.textContent()).toContain("cannot be removed");
    expect(focusOrder(root).some((el) => /Remove \.trash\//.test(labelOf(root, el)))).toBe(false);
    await type(root, "Add an exclusion", "drafts/");
    await controlFor(root, "Add").dispatch("click");
    await vi.waitFor(() => expect(store.get().userExclusions).toEqual(["drafts/"]));
    await vi.waitFor(() => expect(hashOf()).not.toBe(before));
    await controlFor(root, "Remove drafts/ from your additions").dispatch("click");
    await vi.waitFor(() => expect(store.get().userExclusions).toEqual([]));
  });

  it("says why a duplicate or default entry is not added", async () => {
    const { root, store } = await open();
    await type(root, "Add an exclusion", ".trash/");
    await controlFor(root, "Add").dispatch("click");
    await flush();
    expect(byId(root, "ipfs-sync-exclusions-message")?.text).toMatch(/^Not changed: .*already excluded/);
    expect(store.get().userExclusions).toEqual([]);
  });
});

describe("settings tab: owned keys and the adopt dialog", () => {
  it("shows the key state and recorded IDs as text", async () => {
    const { root } = await open({ ownedKeys: [OWNED_ID] });
    await vi.waitFor(() => expect(root.textContent()).toContain("Owned. The key ID is recorded as owned."));
    expect(root.textContent()).toContain(OWNED_ID);
  });

  it("words every key state as a clean sentence", async () => {
    const foreign = await open();
    await vi.waitFor(() => expect(foreign.root.textContent()).toContain("Foreign. The key ID is not in the recorded owned set."));
    const absent = await open({ publicationKey: "obsidian-vault-none" });
    await vi.waitFor(() => expect(absent.root.textContent()).toContain("Absent. The node has no key with this name."));
  });

  it("capitalises and ends an unlisted reason", () => {
    expect(keyReasonSentence("some new reason")).toBe("Some new reason.");
    expect(keyReasonSentence("Already a sentence.")).toBe("Already a sentence.");
  });

  it("records nothing until the dialog is confirmed, and the dialog states every consequence", async () => {
    const { root, store } = await open();
    await type(root, "Adopt a key by ID", PEER_ID);
    await controlFor(root, "Adopt...").dispatch("click");
    await flush();
    const dialog = Modal.instances.at(-1) as unknown as { opened: boolean; contentEl: FakeEl };
    expect(dialog.opened).toBe(true);
    expect(store.get().ownedKeys).toEqual([]);
    for (const line of ADOPT_CONSEQUENCES) expect(dialog.contentEl.textContent()).toContain(line);
    expect(dialog.contentEl.textContent()).toContain("obsidian-vault-peer");
    const buttons = focusOrder(dialog.contentEl);
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Adopt key"]);
    expect(buttons[0]?.focused).toBe(true);
    expect(byId(dialog.contentEl, buttons[1]?.getAttr("aria-describedby") ?? "")?.textContent()).toContain(ADOPT_CONSEQUENCES[0]);

    await buttons[1]?.dispatch("click");
    await flush();
    expect(store.get().ownedKeys).toEqual([PEER_ID]);
    expect(dialog.opened).toBe(false);
    expect(byId(root, "ipfs-sync-adopt-feedback")?.text).toContain("Recorded key obsidian-vault-peer");
  });

  it("leaves the owned list unchanged when the dialog is cancelled, and when it is closed any other way", async () => {
    const { root, store } = await open();
    await type(root, "Adopt a key by ID", PEER_ID);
    await controlFor(root, "Adopt...").dispatch("click");
    await flush();
    const first = Modal.instances.at(-1) as unknown as { contentEl: FakeEl; opened: boolean };
    await focusOrder(first.contentEl)[0]?.dispatch("click");
    expect(store.get().ownedKeys).toEqual([]);
    expect(first.opened).toBe(false);
    expect(byId(root, "ipfs-sync-adopt-feedback")?.text).toContain("Nothing was recorded");

    await controlFor(root, "Adopt...").dispatch("click");
    await flush();
    (Modal.instances.at(-1) as unknown as { close(): void }).close(); // Escape
    expect(store.get().ownedKeys).toEqual([]);
  });

  it("refuses a key whose name is not an allowed project key, with a text explanation and no dialog", async () => {
    const { root, store } = await open();
    await type(root, "Adopt a key by ID", "k51princeprinceprince");
    await controlFor(root, "Adopt...").dispatch("click");
    await flush();
    expect(Modal.instances).toHaveLength(0);
    expect(byId(root, "ipfs-sync-adopt-feedback")?.text).toMatch(/^Error: .*prince-live.*another project/);
    expect(store.get().ownedKeys).toEqual([]);
  });

  it("does not open when the dialog is created without a pending confirmation", () => {
    const store = memoryStore({});
    const vm = createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => NODE_KEYS });
    const finished = vi.fn();
    new AdoptKeyDialog(new App() as unknown as ObsidianApp, vm.keys, finished).open();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(store.get().ownedKeys).toEqual([]);
  });
});

describe("settings tab: layout of long values", () => {
  it("gives URL and path inputs their own full-width line, and leaves ports compact", async () => {
    const { root } = await open();
    for (const label of ["RPC URL", "Gateway URL", "MFS root", "Publication key name"]) {
      expect(controlFor(root, label).style["width"], label).toBe("100%");
    }
    expect(controlFor(root, "RPC port").style["width"]).toBeUndefined();
    const row = controlFor(root, "MFS root").parent?.parent;
    expect(row?.style["flex-wrap"]).toBe("wrap");
  });

  it("uses hint placeholders that cannot be mistaken for port values", async () => {
    const { root } = await open();
    for (const label of ["RPC port", "Gateway port"]) {
      expect(controlFor(root, label).placeholder).toBe("optional");
      expect(referencedText(root, controlFor(root, label).getAttr("aria-describedby"))).toContain("hint, not a value");
    }
  });

  it("renders the hash and owned key IDs as wrapping monospace text inside the description area", async () => {
    const { root } = await open({ ownedKeys: [OWNED_ID] });
    await vi.waitFor(() => expect(root.textContent()).toContain(OWNED_ID));
    const values = root.findAll((el) => el.tag === "code" && (el.text === OWNED_ID || /^[0-9a-f]{16,}$/.test(el.text)));
    expect(values.length).toBeGreaterThanOrEqual(2);
    for (const code of values) {
      expect(code.style["overflow-wrap"]).toBe("anywhere");
      let ancestor = code.parent;
      while (ancestor !== null && !ancestor.hasClass("setting-item-description")) ancestor = ancestor.parent;
      expect(ancestor, "value must sit in the wrapping description area, not the flex control area").not.toBeNull();
    }
  });
});
