import { describe, expect, it } from "vitest";
import { createEventBus, createSyncEventBus, type ListenerFailure } from "../../src/core/events";

describe("event bus", () => {
  it("delivers typed payloads to every listener of an event only", () => {
    const bus = createSyncEventBus();
    const changed: string[] = [];
    const completed: string[] = [];
    bus.on("file.changed", (event) => void changed.push(`${event.kind}:${event.path}`));
    bus.on("publish.complete", (event) => void completed.push(event.rootCid));

    bus.emit("file.changed", { path: "a.md", kind: "added", sha256: "ab" });
    bus.emit("publish.complete", { rootCid: "bafyroot", manifestCid: "bafycur", written: 1, removed: 0, durationMs: 5 });

    expect(changed).toEqual(["added:a.md"]);
    expect(completed).toEqual(["bafyroot"]);
  });

  it("removes listeners through the returned function and through off", () => {
    const bus = createSyncEventBus();
    const seen: string[] = [];
    const listener = (event: { readonly path: string }): void => void seen.push(event.path);
    const stop = bus.on("file.changed", listener);
    bus.emit("file.changed", { path: "1", kind: "added" });
    stop();
    bus.emit("file.changed", { path: "2", kind: "added" });
    bus.on("file.changed", listener);
    bus.off("file.changed", listener);
    bus.emit("file.changed", { path: "3", kind: "added" });
    expect(seen).toEqual(["1"]);
  });

  it("isolates a throwing or rejecting listener and reports it on the error channel", async () => {
    const bus = createSyncEventBus();
    const failures: ListenerFailure[] = [];
    const seen: string[] = [];
    bus.onListenerFailure((failure) => void failures.push(failure));
    bus.on("file.changed", () => {
      throw new Error("boom");
    });
    bus.on("file.changed", () => Promise.reject(new Error("async boom")));
    bus.on("file.changed", (event) => void seen.push(event.path));

    bus.emit("file.changed", { path: "x.md", kind: "modified" });
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual(["x.md"]);
    expect(failures.map((f) => (f.error as Error).message).sort()).toEqual(["async boom", "boom"]);
    expect(failures.every((f) => f.event === "file.changed")).toBe(true);
  });

  it("survives a failing failure handler", () => {
    const bus = createSyncEventBus();
    bus.onListenerFailure(() => {
      throw new Error("handler broke");
    });
    bus.on("file.changed", () => {
      throw new Error("boom");
    });
    expect(() => bus.emit("file.changed", { path: "x", kind: "removed" })).not.toThrow();
  });

  it("rejects a payload with a secret-looking field at compile time", () => {
    // @ts-expect-error a `token` field is refused in an event payload
    createEventBus<{ readonly "auth.done": { readonly authToken: string } }>();
    // @ts-expect-error file contents are refused in an event payload
    createEventBus<{ readonly "note.read": { readonly fileContent: string } }>();
    const ok = createEventBus<{ readonly "note.seen": { readonly path: string } }>();
    ok.emit("note.seen", { path: "a" });
    expect(ok).toBeDefined();
  });
});
