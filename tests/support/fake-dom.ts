/**
 * A tiny element tree that implements the parts of Obsidian's DOM helpers the settings tab uses
 * (`createEl`, `createDiv`, `empty`, `setText`, `setAttr`, `addClass`, events). Test-only, never bundled.
 * Tests that render the tab read the tree back: ids, attributes, text and document order.
 */

export interface FakeElInfo {
  readonly cls?: string | readonly string[];
  readonly text?: string;
  readonly attr?: Readonly<Record<string, string | number | boolean | null>>;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly title?: string;
}

type Handler = (event: FakeEvent) => unknown;

export interface FakeEvent {
  readonly type: string;
  readonly key?: string;
}

const FOCUSABLE_TAGS = new Set(["input", "select", "button", "textarea"]);

function classList(cls: FakeElInfo["cls"]): readonly string[] {
  if (cls === undefined) return [];
  return typeof cls === "string" ? cls.split(/\s+/).filter((c) => c !== "") : cls;
}

export class FakeEl {
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly style: Record<string, string> = {};
  private readonly handlers = new Map<string, Handler[]>();
  parent: FakeEl | null = null;
  id = "";
  text = "";
  type = "";
  value = "";
  placeholder = "";
  title = "";
  disabled = false;
  checked = false;
  focused = false;

  constructor(readonly tag: string) {}

  createEl(tag: string, info?: FakeElInfo | string, callback?: (el: FakeEl) => void): FakeEl {
    const el = new FakeEl(tag);
    const opts: FakeElInfo = typeof info === "string" ? { cls: info } : (info ?? {});
    for (const c of classList(opts.cls)) el.classes.add(c);
    if (opts.text !== undefined) el.text = opts.text;
    if (opts.type !== undefined) el.type = opts.type;
    if (opts.value !== undefined) el.value = opts.value;
    if (opts.placeholder !== undefined) el.placeholder = opts.placeholder;
    if (opts.title !== undefined) el.title = opts.title;
    for (const [key, value] of Object.entries(opts.attr ?? {})) if (value !== null) el.attrs.set(key, String(value));
    el.parent = this;
    this.children.push(el);
    callback?.(el);
    return el;
  }

  createDiv(info?: FakeElInfo | string, callback?: (el: FakeEl) => void): FakeEl {
    return this.createEl("div", info, callback);
  }

  createSpan(info?: FakeElInfo | string, callback?: (el: FakeEl) => void): FakeEl {
    return this.createEl("span", info, callback);
  }

  empty(): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.text = "";
  }

  setText(text: string): void {
    this.text = text;
  }

  setAttr(name: string, value: string | number | boolean | null): void {
    if (value === null) this.attrs.delete(name);
    else this.attrs.set(name, String(value));
  }

  setCssProps(props: Record<string, string>): void {
    Object.assign(this.style, props);
  }

  getAttr(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  addClass(...names: string[]): void {
    for (const name of names) this.classes.add(name);
  }

  removeClass(...names: string[]): void {
    for (const name of names) this.classes.delete(name);
  }

  toggleClass(names: string | string[], on: boolean): void {
    for (const name of typeof names === "string" ? [names] : names) {
      if (on) this.classes.add(name);
      else this.classes.delete(name);
    }
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  addEventListener(type: string, handler: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  /** Run the handlers of an event and wait for async ones, as the browser would dispatch it. */
  async dispatch(type: string, extra: { readonly key?: string } = {}): Promise<void> {
    for (const handler of this.handlers.get(type) ?? []) await handler({ type, ...extra });
  }

  focus(): void {
    this.focused = true;
  }

  isFocusable(): boolean {
    return FOCUSABLE_TAGS.has(this.tag) && !this.disabled && this.type !== "hidden";
  }

  /** All descendants in document order. */
  descendants(): FakeEl[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  find(predicate: (el: FakeEl) => boolean): FakeEl | undefined {
    return this.descendants().find(predicate);
  }

  findAll(predicate: (el: FakeEl) => boolean): FakeEl[] {
    return this.descendants().filter(predicate);
  }

  /** Own text plus the text of every descendant, in document order. */
  textContent(): string {
    return [this.text, ...this.children.map((child) => child.textContent())].filter((t) => t !== "").join(" ");
  }
}

/** The element with this id anywhere under `root`. */
export function byId(root: FakeEl, id: string): FakeEl | undefined {
  return root.find((el) => el.id === id);
}

/** Text of the elements a space-separated id list points to, as `aria-labelledby` and `aria-describedby` resolve it. */
export function referencedText(root: FakeEl, ids: string | null): string {
  if (ids === null) return "";
  return ids
    .split(/\s+/)
    .map((id) => byId(root, id)?.textContent() ?? "")
    .filter((t) => t !== "")
    .join(" ");
}

/** The controls a keyboard user can reach, in tab order (no positive tabindex is used, so document order). */
export function focusOrder(root: FakeEl): FakeEl[] {
  return root.findAll((el) => el.isFocusable());
}
