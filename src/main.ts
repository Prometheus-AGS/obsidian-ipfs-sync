import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

// ─────────────────────────────────────────────────────────────────────────────
// IPFS Sync — Phase 1 (snapshot sync over your own kubo node)
//
// Publish: vault files → multipart /api/v0/add (wrapped dir) → pin → IPNS name
// Pull:    resolve IPNS key → /api/v0/get tar → extract, conflict-safe
//
// Phase 2 replaces the snapshot layer with an embedded Helia + OrbitDB op-log
// for multi-writer CRDT merging. This module deliberately keeps the RPC layer
// isolated (ipfsRequest) so that swap is clean.
// ─────────────────────────────────────────────────────────────────────────────

interface IpfsSyncSettings {
  rpcUrl: string;
  keyName: string;
  authToken: string;
  excludedPaths: string; // one per line, vault-relative, prefix match
  publishIntervalMinutes: number; // 0 = off
}

const DEFAULT_SETTINGS: IpfsSyncSettings = {
  rpcUrl: "https://ipfs.prometheusags.ai",
  keyName: "obsidian-vault",
  authToken: "",
  excludedPaths: [
    ".trash/",
    ".ipfs-sync/",
    ".DS_Store",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/workspace.json.bak",
    ".obsidian/graph.json",
    ".obsidian/cache",
  ].join("\n"),
  publishIntervalMinutes: 0,
};

interface PublishResult {
  rootCid: string;
  ipnsName: string;
  fileCount: number;
  bytes: number;
}

export default class IpfsSyncPlugin extends Plugin {
  settings: IpfsSyncSettings;
  private timer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("network", "IPFS Sync", (evt: MouseEvent) => {
      new Notice("IPFS Sync: use the command palette (Ctrl/Cmd+P)");
    });

    this.addCommand({
      id: "publish-vault",
      name: "Publish vault to IPFS",
      callback: () => this.publishVault(),
    });
    this.addCommand({
      id: "pull-vault",
      name: "Pull vault from IPFS",
      callback: () => this.pullVault(),
    });
    this.addCommand({
      id: "show-status",
      name: "Show sync status",
      callback: () => this.showStatus(),
    });

    this.addSettingTab(new IpfsSyncSettingTab(this.app, this));

    if (this.settings.publishIntervalMinutes > 0) {
      this.armAutoPublish();
    }
  }

  onunload() {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  // ── Settings persistence ──────────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.settings.publishIntervalMinutes > 0) this.armAutoPublish();
  }

  private armAutoPublish() {
    const ms = this.settings.publishIntervalMinutes * 60_000;
    this.timer = window.setInterval(() => {
      void this.publishVault({ quiet: true });
    }, ms);
  }

  // ── RPC layer (the seam Phase 2 keeps) ────────────────────────────────────

  private async ipfsRequest<T = unknown>(
    endpoint: string,
    params: Record<string, string> = {},
    init: RequestInit = {}
  ): Promise<T> {
    const url = new URL(`${this.settings.rpcUrl}/api/v0/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.settings.authToken) {
      headers["Authorization"] = `Bearer ${this.settings.authToken}`;
    }
    const resp = await fetch(url.toString(), { ...init, headers });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`kubo ${endpoint} → HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    return resp.json() as Promise<T>;
  }

  private excludes(): string[] {
    return this.settings.excludedPaths
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private isExcluded(path: string): boolean {
    const norm = path.replace(/\\/g, "/");
    return this.excludes().some((ex) => norm === ex || norm.startsWith(ex));
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  async publishVault(opts: { quiet?: boolean } = {}): Promise<PublishResult | null> {
    const files = this.app.vault
      .getFiles()
      .filter((f) => !this.isExcluded(f.path));
    if (files.length === 0) {
      if (!opts.quiet) new Notice("IPFS Sync: no files to publish");
      return null;
    }

    const notify = (msg: string) => {
      if (!opts.quiet) new Notice(msg, 10_000);
    };

    notify(`IPFS Sync: uploading ${files.length} files…`);

    const form = new FormData();
    let bytes = 0;
    for (const f of files) {
      const data = await this.app.vault.readBinary(f);
      bytes += data.byteLength;
      form.append("file", new Blob([data]), f.path);
    }

    const addUrl = new URL(`${this.settings.rpcUrl}/api/v0/add`);
    addUrl.searchParams.set("cid-version", "1");
    addUrl.searchParams.set("pin", "true");
    addUrl.searchParams.set("wrap-with-directory", "true");
    addUrl.searchParams.set("progress", "false");

    const addResp = await fetch(addUrl.toString(), {
      method: "POST",
      body: form,
      headers: this.settings.authToken
        ? { Authorization: `Bearer ${this.settings.authToken}` }
        : undefined,
    });
    if (!addResp.ok) {
      throw new Error(`ipfs add failed: HTTP ${addResp.status} ${(await addResp.text()).slice(0, 300)}`);
    }

    // Response is newline-delimited JSON; the wrapped directory is the entry
    // with an empty Name.
    const addText = await addResp.text();
    let rootCid = "";
    for (const line of addText.trim().split("\n")) {
      try {
        const entry = JSON.parse(line) as { Name: string; Hash: string };
        if (entry.Name === "" || entry.Name === undefined) rootCid = entry.Hash;
      } catch {
        /* ignore keepalive/progress lines */
      }
    }
    if (!rootCid) throw new Error("ipfs add did not return a wrapped root CID");

    const pub = await this.ipfsRequest<{ Name: string }>("name/publish", {
      arg: rootCid,
      key: this.settings.keyName,
      ttl: "5m",
    });

    const data = (await this.loadData()) ?? {};
    await this.saveData({ ...data, lastPublishedRoot: rootCid, lastPublishedAt: Date.now() });

    notify(`IPFS Sync: published ${files.length} files (${(bytes / 1e6).toFixed(1)} MB)\nroot ${rootCid.slice(0, 16)}… → ${pub.Name}`);
    return { rootCid, ipnsName: pub.Name, fileCount: files.length, bytes };
  }

  // ── Pull ──────────────────────────────────────────────────────────────────

  async pullVault(): Promise<void> {
    const keys = await this.ipfsRequest<{ Keys: { Name: string; Id: string }[] }>("key/list");
    const key = keys.Keys.find((k) => k.Name === this.settings.keyName);
    if (!key) {
      new Notice(`IPFS Sync: key "${this.settings.keyName}" not found on node`);
      return;
    }

    new Notice("IPFS Sync: resolving IPNS…");
    const resolved = await this.ipfsRequest<{ Path: string }>("name/resolve", {
      arg: `/ipns/${key.Id}`,
    });
    const rootCid = resolved.Path.replace(/^\/ipfs\//, "");
    if (!rootCid) {
      new Notice("IPFS Sync: nothing published yet");
      return;
    }

    new Notice("IPFS Sync: downloading snapshot…");
    const getUrl = new URL(`${this.settings.rpcUrl}/api/v0/get`);
    getUrl.searchParams.set("arg", rootCid);
    getUrl.searchParams.set("archive", "true");
    const getResp = await fetch(getUrl.toString(), {
      headers: this.settings.authToken
        ? { Authorization: `Bearer ${this.settings.authToken}` }
        : undefined,
    });
    if (!getResp.ok) {
      throw new Error(`ipfs get failed: HTTP ${getResp.status}`);
    }
    const tar = await getResp.arrayBuffer();

    let written = 0, skipped = 0, conflicts = 0, dirs = 0;
    for (const entry of parseTar(tar)) {
      let rel = entry.name.replace(/^\.\//, "");
      if (!rel || rel === ".") continue;
      if (this.isExcluded(rel)) continue;

      if (entry.type === "dir") {
        if (!this.app.vault.getAbstractFileByPath(rel)) {
          await this.app.vault.createFolder(rel).catch(() => {});
        }
        dirs++;
        continue;
      }
      if (entry.type !== "file") continue; // symlinks etc: phase 2

      const existing = this.app.vault.getAbstractFileByPath(rel);
      if (existing instanceof TFile) {
        const local = await this.app.vault.readBinary(existing);
        if (buffersEqual(local, entry.data)) {
          skipped++;
          continue;
        }
        // Conflict policy (same as scripts/pull.sh): remote wins, local
        // content is preserved as a dated copy. Phase 2's CRDT op-log
        // replaces this with real merging.
        const stamp = new Date().toISOString().slice(0, 10);
        const conflictPath = `${rel} (ipfs conflict ${stamp})`;
        await this.app.vault.create(conflictPath, local);
        await this.app.vault.modify(existing, entry.data);
        conflicts++;
      } else {
        await this.app.vault.create(rel, entry.data);
        written++;
      }
    }

    const data = (await this.loadData()) ?? {};
    await this.saveData({ ...data, lastPulledRoot: rootCid, lastPulledAt: Date.now() });

    new Notice(
      `IPFS Sync: pull complete — ${written} new, ${skipped} unchanged, ${conflicts} conflicts, ${dirs} folders`,
      12_000
    );
  }

  async showStatus(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    const fmt = (ts?: number) => (ts ? new Date(ts).toLocaleString() : "never");
    new Notice(
      [
        `RPC: ${this.settings.rpcUrl}`,
        `Key: ${this.settings.keyName}`,
        `Last published: ${fmt(data.lastPublishedAt)}`,
        `  root: ${data.lastPublishedRoot ?? "—"}`,
        `Last pulled: ${fmt(data.lastPulledAt)}`,
        `  root: ${data.lastPulledRoot ?? "—"}`,
      ].join("\n"),
      20_000
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal USTAR parser — kubo `get --archive` emits ustar; no dependency needed.
// ─────────────────────────────────────────────────────────────────────────────

interface TarEntry {
  name: string;
  type: "file" | "dir" | "other";
  data: ArrayBuffer;
}

function parseTar(buf: ArrayBuffer): TarEntry[] {
  const view = new Uint8Array(buf);
  const entries: TarEntry[] = [];
  let offset = 0;
  const text = (start: number, len: number) => {
    let s = "";
    for (let i = start; i < start + len && view[i] !== 0; i++) s += String.fromCharCode(view[i]);
    return s;
  };
  const octal = (start: number, len: number) => parseInt(text(start, len).trim() || "0", 8);

  while (offset + 512 <= view.length) {
    if (view.slice(offset, offset + 512).every((b) => b === 0)) break; // end block
    let name = text(offset, 100);
    const size = octal(offset + 124, 12);
    const typeflag = String.fromCharCode(view[offset + 156] || 48);
    const prefix = text(offset + 345, 155);
    const isUstar = text(offset + 257, 5) === "ustar";
    if (isUstar && prefix) name = `${prefix}/${name}`;

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === "0" || typeflag === "\0") {
      entries.push({ name, type: "file", data: buf.slice(dataStart, dataEnd) });
    } else if (typeflag === "5") {
      entries.push({ name, type: "dir", data: new ArrayBuffer(0) });
    } else {
      entries.push({ name, type: "other", data: new ArrayBuffer(0) });
    }
    offset = paddedEnd;
  }
  return entries;
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────────────────

class IpfsSyncSettingTab extends PluginSettingTab {
  plugin: IpfsSyncPlugin;

  constructor(app: App, plugin: IpfsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Kubo RPC URL")
      .setDesc("Your node's API endpoint.")
      .addText((t) =>
        t.setPlaceholder("https://ipfs.example.com").setValue(this.plugin.settings.rpcUrl).onChange(async (v) => {
          this.plugin.settings.rpcUrl = v.trim().replace(/\/+$/, "");
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("IPNS key name")
      .setDesc("Key on the node used as the mutable vault pointer.")
      .addText((t) =>
        t.setPlaceholder("obsidian-vault").setValue(this.plugin.settings.keyName).onChange(async (v) => {
          this.plugin.settings.keyName = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auth token (optional)")
      .setDesc("Sent as Bearer token. Leave empty only if your node is on a private network.")
      .addText((t) =>
        t.setPlaceholder("").setValue(this.plugin.settings.authToken).onChange(async (v) => {
          this.plugin.settings.authToken = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("One vault-relative path per line. Prefix match; excluded from both publish and pull.")
      .addTextArea((t) =>
        t.setValue(this.plugin.settings.excludedPaths).onChange(async (v) => {
          this.plugin.settings.excludedPaths = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-publish interval (minutes)")
      .setDesc("0 disables automatic publishing. Pull is always manual in Phase 1.")
      .addText((t) =>
        t.setPlaceholder("0").setValue(String(this.plugin.settings.publishIntervalMinutes)).onChange(async (v) => {
          const n = Math.max(0, parseInt(v, 10) || 0);
          this.plugin.settings.publishIntervalMinutes = n;
          await this.plugin.saveSettings();
        })
      );
  }
}
