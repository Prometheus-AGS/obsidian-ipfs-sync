import { FakeEl } from "./fake-dom";
import { MemoryAdapter } from "./memory-adapter";
import { Workspace } from "./obsidian-stub-workspace";

export { TextFileView, Workspace, type StubLeaf } from "./obsidian-stub-workspace";

/**
 * Test-only stand-in for the `obsidian` module (vitest alias, see vitest.config.ts). It is never bundled.
 * It records what the plugin registers and shows so tests can assert on it without a running Obsidian.
 */

export class Notice {
  static readonly shown: Notice[] = [];
  static reset(): void {
    Notice.shown.length = 0;
  }

  message: string;
  readonly duration: number | undefined;
  hidden = false;

  constructor(message: string | DocumentFragment, duration?: number) {
    this.message = typeof message === "string" ? message : (message.textContent ?? "");
    this.duration = duration;
    Notice.shown.push(this);
  }

  setMessage(message: string | DocumentFragment): this {
    this.message = typeof message === "string" ? message : (message.textContent ?? "");
    return this;
  }

  hide(): void {
    this.hidden = true;
  }
}

/** Obsidian's `Platform` flags, as a desktop app reports them. A test that needs another platform assigns these fields and restores them. */
export const Platform = { isDesktopApp: true, isMobile: false, isIosApp: false, isAndroidApp: false };

export class App {
  readonly vault: { readonly adapter: MemoryAdapter };
  readonly workspace = new Workspace();

  constructor(adapter: MemoryAdapter = new MemoryAdapter()) {
    this.vault = { adapter };
  }
}

export interface RegisteredCommand {
  readonly id: string;
  readonly name: string;
  readonly callback?: () => unknown;
}

export interface FakeElement {
  text: string;
  setText(text: string): void;
}

export class Plugin {
  readonly app: App;
  readonly manifest: { readonly id: string; readonly version: string };
  data: unknown = null;
  readonly commands: RegisteredCommand[] = [];
  readonly ribbonIcons: { readonly icon: string; readonly title: string; readonly callback: (evt: MouseEvent) => unknown }[] = [];
  readonly statusBarItems: FakeElement[] = [];
  readonly settingTabs: PluginSettingTab[] = [];
  readonly intervals: number[] = [];

  constructor(app: App, manifest: { readonly id: string; readonly version: string } = { id: "ipfs-sync", version: "0.0.0" }) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<unknown> {
    return this.data === null ? null : structuredClone(this.data);
  }

  async saveData(data: unknown): Promise<void> {
    this.data = structuredClone(data);
  }

  addCommand(command: RegisteredCommand): RegisteredCommand {
    this.commands.push(command);
    return command;
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): FakeElement {
    this.ribbonIcons.push({ icon, title, callback });
    return { text: "", setText() {} };
  }

  addStatusBarItem(): FakeElement {
    const item: FakeElement = {
      text: "",
      setText(text: string) {
        item.text = text;
      },
    };
    this.statusBarItems.push(item);
    return item;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  registerInterval(id: number): number {
    this.intervals.push(id);
    return id;
  }
}

export class PluginSettingTab {
  readonly app: App;
  readonly plugin: Plugin;
  /** The tab's content root, as Obsidian hands it to `display()`. */
  readonly containerEl: FakeEl = new FakeEl("div");

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}

/** Modal with the pieces the adopt dialog uses; `open` and `close` run the hooks like Obsidian does. */
export class Modal {
  /** Every modal created since the last `reset`, so tests can find the dialog a control opened. */
  static readonly instances: Modal[] = [];
  static reset(): void {
    Modal.instances.length = 0;
  }

  readonly app: App;
  readonly containerEl = new FakeEl("div");
  readonly modalEl = this.containerEl.createDiv("modal");
  readonly titleEl = this.modalEl.createDiv("modal-title");
  readonly contentEl = this.modalEl.createDiv("modal-content");
  opened = false;

  constructor(app: App) {
    this.app = app;
    Modal.instances.push(this);
  }

  open(): void {
    this.opened = true;
    void this.onOpen();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.onClose();
  }

  onOpen(): void | Promise<void> {}
  onClose(): void {}
}

// ---------- Setting and its components ----------

export class BaseComponent {
  disabled = false;
  then(cb: (component: this) => unknown): this {
    cb(this);
    return this;
  }
}

export class TextComponent extends BaseComponent {
  readonly inputEl: FakeEl;

  constructor(containerEl: FakeEl) {
    super();
    this.inputEl = containerEl.createEl("input", { type: "text" });
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.inputEl.disabled = disabled;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => void callback(this.inputEl.value));
    return this;
  }
}

export class DropdownComponent extends BaseComponent {
  readonly selectEl: FakeEl;

  constructor(containerEl: FakeEl) {
    super();
    this.selectEl = containerEl.createEl("select");
  }

  addOption(value: string, display: string): this {
    this.selectEl.createEl("option", { text: display, value });
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }

  getValue(): string {
    return this.selectEl.value;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.selectEl.disabled = disabled;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.selectEl.addEventListener("change", () => void callback(this.selectEl.value));
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  readonly buttonEl: FakeEl;

  constructor(containerEl: FakeEl) {
    super();
    this.buttonEl = containerEl.createEl("button");
  }

  setButtonText(text: string): this {
    this.buttonEl.text = text;
    return this;
  }

  setCta(): this {
    this.buttonEl.addClass("mod-cta");
    return this;
  }

  setWarning(): this {
    this.buttonEl.addClass("mod-warning");
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }

  setTooltip(tooltip: string): this {
    this.buttonEl.title = tooltip;
    return this;
  }

  onClick(callback: (evt: unknown) => unknown): this {
    this.buttonEl.addEventListener("click", () => void callback({}));
    return this;
  }
}

/** Setting row: Obsidian's `setting-item` structure with name, description and a control area. */
export class Setting {
  readonly settingEl: FakeEl;
  readonly infoEl: FakeEl;
  readonly nameEl: FakeEl;
  readonly descEl: FakeEl;
  readonly controlEl: FakeEl;
  readonly components: BaseComponent[] = [];

  constructor(containerEl: FakeEl) {
    this.settingEl = containerEl.createDiv("setting-item");
    this.infoEl = this.settingEl.createDiv("setting-item-info");
    this.nameEl = this.infoEl.createDiv("setting-item-name");
    this.descEl = this.infoEl.createDiv("setting-item-description");
    this.controlEl = this.settingEl.createDiv("setting-item-control");
  }

  setName(name: string): this {
    this.nameEl.setText(name);
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.setText(desc);
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }

  setHeading(): this {
    this.settingEl.addClass("setting-item-heading");
    return this;
  }

  then(cb: (setting: this) => unknown): this {
    cb(this);
    return this;
  }

  addText(cb: (component: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }

  addDropdown(cb: (component: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }

  addButton(cb: (component: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }

  private add<T extends BaseComponent>(component: T, cb: (component: T) => unknown): this {
    this.components.push(component);
    cb(component);
    return this;
  }
}

// ---------- requestUrl ----------

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
  json: unknown;
}

type RequestUrlHandler = (params: RequestUrlParam) => RequestUrlResponse | Promise<RequestUrlResponse>;

export const requestUrlCalls: RequestUrlParam[] = [];
let requestUrlHandler: RequestUrlHandler = () => {
  throw new Error("no requestUrl handler set for this test");
};

/** Install the answer for every `requestUrl` call until `resetRequestUrl`. */
export function setRequestUrlHandler(handler: RequestUrlHandler): void {
  requestUrlHandler = handler;
}

export function resetRequestUrl(): void {
  requestUrlCalls.length = 0;
  requestUrlHandler = () => {
    throw new Error("no requestUrl handler set for this test");
  };
}

/** A response shaped like Obsidian's `RequestUrlResponse` (body as bytes). */
export function stubResponse(status: number, body: string | Uint8Array = "", headers: Record<string, string> = {}): RequestUrlResponse {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const arrayBuffer = Uint8Array.from(bytes).buffer;
  const text = new TextDecoder().decode(bytes);
  return { status, headers, arrayBuffer, text, get json(): unknown { return JSON.parse(text); } };
}

export async function requestUrl(params: RequestUrlParam): Promise<RequestUrlResponse> {
  requestUrlCalls.push(params);
  return requestUrlHandler(params);
}
