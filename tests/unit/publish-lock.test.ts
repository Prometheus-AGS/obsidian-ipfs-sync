import { describe, expect, it, vi } from "vitest";
import {
  LOCK_HEARTBEAT_MS,
  LOCK_HOST_MAX,
  LOCK_MAX_BYTES,
  LOCK_STALE_MS,
  acquirePublishLock,
  breakPublishLock,
  decodeLock,
  describeLock,
  encodeLock,
  isStaleLock,
  type LockContext,
  type LockFile,
  type LockRecord,
} from "../../src/sync/publish-lock";
import { guardKv } from "../../src/sync/guarded-kv";

interface Rig {
  readonly file: LockFile & { bytes: Uint8Array<ArrayBuffer> | undefined };
  readonly ctx: LockContext & { time: number; alive: Set<number>; ticks: (() => void)[]; stopped: number };
}

function rig(overrides: Partial<{ pid: number; host: string; token: string }> = {}): Rig {
  const file: Rig["file"] = {
    bytes: undefined,
    createExclusive: async (bytes) => {
      if (file.bytes !== undefined) return false;
      file.bytes = bytes;
      return true;
    },
    read: async () => file.bytes,
    write: async (bytes) => {
      file.bytes = bytes;
    },
    remove: async () => {
      file.bytes = undefined;
    },
    moveAside: async () => {
      const moved = file.bytes;
      file.bytes = undefined;
      return moved === undefined ? undefined : { bytes: moved, discard: async () => undefined };
    },
  };
  let tokens = 0;
  const ctx: Rig["ctx"] = {
    time: 1_800_000_000_000,
    alive: new Set<number>(),
    ticks: [],
    stopped: 0,
    now: () => ctx.time,
    pid: overrides.pid ?? 4242,
    host: overrides.host ?? "host-a",
    newToken: () => overrides.token ?? `token-${(tokens += 1)}`,
    isProcessAlive: (pid) => ctx.alive.has(pid),
    every: (ms, task) => {
      expect(ms).toBe(LOCK_HEARTBEAT_MS);
      ctx.ticks.push(task);
      return () => {
        ctx.stopped += 1;
      };
    },
  };
  return { file, ctx };
}

const other = (overrides: Partial<LockRecord> = {}): LockRecord => ({ token: "other-token", pid: 999, host: "host-a", time: 1_800_000_000_000, ...overrides });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("publish lock", () => {
  it("is exclusive: a second publish is stopped with a message naming the holder, never its token", async () => {
    const r = rig();
    await acquirePublishLock(r.file, r.ctx);
    const second = rig();
    second.ctx.alive.add(4242); // the first publish is a live process on this host
    const error = await acquirePublishLock(r.file, { ...second.ctx, newToken: () => "second-token" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "lock-held" });
    expect((error as Error).message).toContain('process 4242 on "host-a"');
    expect((error as Error).message).toContain("--break-lock");
    expect((error as Error).message).not.toContain("token-1");
  });

  it("holds a random token, the process id, the host and the time", async () => {
    const r = rig();
    await acquirePublishLock(r.file, r.ctx);
    expect(decodeLock(r.file.bytes ?? new Uint8Array())).toEqual({ token: "token-1", pid: 4242, host: "host-a", time: r.ctx.time });
  });

  it("refreshes the heartbeat on every tick", async () => {
    const r = rig();
    await acquirePublishLock(r.file, r.ctx);
    r.ctx.time += LOCK_HEARTBEAT_MS;
    r.ctx.ticks[0]?.();
    await flush();
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.time).toBe(r.ctx.time);
  });

  it("release removes the lock only if it is still ours, stops the heartbeat, and is safe twice", async () => {
    const r = rig();
    const lock = await acquirePublishLock(r.file, r.ctx);
    await lock.release();
    await lock.release();
    expect(r.file.bytes).toBeUndefined();
    expect(r.ctx.stopped).toBe(1);

    const taken = rig();
    const mine = await acquirePublishLock(taken.file, taken.ctx);
    taken.file.bytes = encodeLock(other());
    await mine.release();
    expect(decodeLock(taken.file.bytes)?.token).toBe("other-token");
  });

  it("assertHeld throws lock-lost when the lock was taken over or removed", async () => {
    const r = rig();
    const lock = await acquirePublishLock(r.file, r.ctx);
    expect(() => lock.assertHeld()).not.toThrow();
    r.file.bytes = encodeLock(other());
    r.ctx.ticks[0]?.();
    await flush();
    expect(() => lock.assertHeld()).toThrowError(expect.objectContaining({ code: "lock-lost" }));
  });

  it("assertHeld throws lock-lost when the heartbeat cannot be written", async () => {
    const r = rig();
    const lock = await acquirePublishLock(r.file, r.ctx);
    r.file.write = async () => {
      throw new Error("disk full");
    };
    r.ctx.ticks[0]?.();
    await flush();
    expect(() => lock.assertHeld()).toThrowError(expect.objectContaining({ code: "lock-lost" }));
  });
});

describe("stale locks", () => {
  const stale = (age: number, record: Partial<LockRecord> = {}): LockRecord => other({ time: 1_800_000_000_000 - age, ...record });

  it("replaces a lock at once when its process is gone from this host, however fresh its heartbeat", async () => {
    const r = rig();
    r.file.bytes = encodeLock(stale(1_000));
    await acquirePublishLock(r.file, r.ctx);
    expect(decodeLock(r.file.bytes)?.token).toBe("token-1");
  });

  it("replaces a lock with no heartbeat for 15 minutes on any host, alive process or not", async () => {
    for (const record of [stale(LOCK_STALE_MS), stale(LOCK_STALE_MS, { host: "host-b" }), stale(LOCK_STALE_MS * 3, { host: "host-b" })]) {
      const r = rig();
      r.ctx.alive.add(record.pid);
      r.file.bytes = encodeLock(record);
      await acquirePublishLock(r.file, r.ctx);
      expect(decodeLock(r.file.bytes)?.token).toBe("token-1");
    }
  });

  it.each([
    ["a heartbeat 14 minutes old from another host", stale(LOCK_STALE_MS - 60_000, { host: "host-b" }), false],
    ["a process that is still alive here with a fresh heartbeat", stale(60_000), true],
    ["a lock written on another host a moment ago", stale(1_000, { host: "host-b" }), false],
  ])("does not take over %s", async (_label, record, alive) => {
    const r = rig();
    if (alive) r.ctx.alive.add(record.pid);
    r.file.bytes = encodeLock(record);
    await expect(acquirePublishLock(r.file, r.ctx)).rejects.toMatchObject({ code: "lock-held" });
    expect(decodeLock(r.file.bytes)?.token).toBe("other-token");
  });

  it("isStaleLock is true for a dead local process or a 15-minute-old heartbeat, and false otherwise", () => {
    const r = rig();
    expect(isStaleLock(stale(1_000), r.ctx)).toBe(true); // same host, process not alive
    r.ctx.alive.add(999);
    expect(isStaleLock(stale(1_000), r.ctx)).toBe(false); // alive here, fresh
    expect(isStaleLock(stale(LOCK_STALE_MS + 1), r.ctx)).toBe(true); // alive here but silent for 15 minutes
    expect(isStaleLock(stale(1_000, { host: "host-b" }), r.ctx)).toBe(false); // other host: cannot be probed, time only
    expect(isStaleLock(stale(LOCK_STALE_MS, { host: "host-b" }), r.ctx)).toBe(true);
  });

  it("gives up when the stale lock is replaced by someone else between the read and the takeover", async () => {
    const r = rig();
    const old = stale(LOCK_STALE_MS * 2);
    r.file.bytes = encodeLock(old);
    let reads = 0;
    const realRead = r.file.read;
    r.file.read = async () => {
      reads += 1;
      if (reads === 2) r.file.bytes = encodeLock(other({ token: "winner", time: r.ctx.time }));
      return realRead();
    };
    await expect(acquirePublishLock(r.file, r.ctx)).rejects.toMatchObject({ code: "lock-held" });
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.token).toBe("winner");
  });

  it("refuses a lock file that is not a lock record, naming --break-lock", async () => {
    const r = rig();
    r.file.bytes = new TextEncoder().encode("garbage");
    const error = await acquirePublishLock(r.file, r.ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "lock-unreadable" });
    expect((error as Error).message).toContain("--break-lock");
  });
});

describe("W-05: takeover race, lapse, local writes", () => {
  const stale = (): LockRecord => other({ time: 1_800_000_000_000 - LOCK_STALE_MS * 2 });

  /** Every file operation yields, so two acquirers interleave at each step. */
  function yielding(r: Rig): void {
    const real = { ...r.file };
    for (const name of ["createExclusive", "read", "moveAside", "remove"] as const) {
      const inner = real[name].bind(r.file) as (...args: never[]) => Promise<unknown>;
      (r.file as unknown as Record<string, unknown>)[name] = async (...args: never[]) => {
        await Promise.resolve();
        await Promise.resolve();
        return inner(...args);
      };
    }
  }

  it("two takers that saw the same stale token: exactly one wins and the loser never removes the winner's lock", async () => {
    const r = rig();
    r.file.bytes = encodeLock(stale());
    yielding(r);
    let n = 0;
    const ctxFor = (name: string): LockContext => ({ ...r.ctx, newToken: () => `${name}-${(n += 1)}` });
    const settled = await Promise.allSettled([acquirePublishLock(r.file, ctxFor("a")), acquirePublishLock(r.file, ctxFor("b"))]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: "lock-held" });
    const record = decodeLock(r.file.bytes ?? new Uint8Array());
    expect(record?.token).toMatch(/^[ab]-/);
    expect(() => (won[0] as PromiseFulfilledResult<{ assertHeld(): void }>).value.assertHeld()).not.toThrow();
  });

  it("a taker that moves a FRESH lock (its holder replaced the stale one first) puts it back and refuses", async () => {
    const r = rig();
    r.file.bytes = encodeLock(stale());
    const realMove = r.file.moveAside;
    r.file.moveAside = async () => {
      r.file.bytes = encodeLock(other({ token: "fresh-holder", time: r.ctx.time })); // the winner's takeover finished just before our rename
      return realMove();
    };
    await expect(acquirePublishLock(r.file, r.ctx)).rejects.toMatchObject({ code: "lock-held" });
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.token).toBe("fresh-holder");
  });

  it("assertHeld throws once the last successful heartbeat is older than twice the interval, even with no failure seen", async () => {
    const r = rig();
    const lock = await acquirePublishLock(r.file, r.ctx);
    r.ctx.time += 2 * LOCK_HEARTBEAT_MS;
    expect(() => lock.assertHeld()).not.toThrow();
    r.ctx.time += 1;
    expect(() => lock.assertHeld()).toThrowError(expect.objectContaining({ code: "lock-lost" }));
  });

  it("a successful heartbeat resets the lapse", async () => {
    const r = rig();
    const lock = await acquirePublishLock(r.file, r.ctx);
    r.ctx.time += 3 * LOCK_HEARTBEAT_MS;
    r.ctx.ticks[0]?.();
    await flush();
    expect(() => lock.assertHeld()).not.toThrow();
  });

  it("guarded kv calls assertHeld before every set and delete, and lets reads through", async () => {
    const calls: string[] = [];
    const inner = { get: async () => undefined, list: async () => [], set: async () => void calls.push("inner-set"), delete: async () => void calls.push("inner-delete") };
    let held = true;
    const kv = guardKv(inner, () => {
      if (!held) throw new Error("lock-lost");
      calls.push("check");
    });
    await kv.set("a", new Uint8Array());
    await kv.delete("a");
    await kv.get("a");
    expect(calls).toEqual(["check", "inner-set", "check", "inner-delete"]);
    held = false;
    await expect(kv.set("a", new Uint8Array())).rejects.toThrow("lock-lost");
    await expect(kv.delete("a")).rejects.toThrow("lock-lost");
    expect(calls).toHaveLength(4);
  });
});

describe("--break-lock", () => {
  it("removes the lock only after the confirmation, and shows what is being removed", async () => {
    const r = rig();
    r.file.bytes = encodeLock(other({ time: r.ctx.time - 90_000 }));
    const asked: string[] = [];
    expect(await breakPublishLock(r.file, r.ctx.now, async (d) => (asked.push(d), false))).toBe("declined");
    expect(r.file.bytes).toBeDefined();
    expect(await breakPublishLock(r.file, r.ctx.now, async (d) => (asked.push(d), true))).toBe("removed");
    expect(r.file.bytes).toBeUndefined();
    expect(asked).toEqual(['process 999 on "host-a", last heartbeat 90 s ago', 'process 999 on "host-a", last heartbeat 90 s ago']);
  });

  it("reports when there is no lock and can break a lock that cannot be read", async () => {
    const r = rig();
    expect(await breakPublishLock(r.file, r.ctx.now, async () => true)).toBe("no-lock");
    r.file.bytes = new TextEncoder().encode("garbage");
    let description = "";
    expect(await breakPublishLock(r.file, r.ctx.now, async (d) => ((description = d), true))).toBe("removed");
    expect(description).toBe("a lock file that cannot be read");
  });

  it("after a break the publish can take the lock", async () => {
    const r = rig();
    r.file.bytes = encodeLock(other());
    await breakPublishLock(r.file, r.ctx.now, async () => true);
    await acquirePublishLock(r.file, r.ctx);
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.token).toBe("token-1");
  });
});

describe("lock records", () => {
  it("round trips and rejects anything malformed", () => {
    const record = other();
    expect(decodeLock(encodeLock(record))).toEqual(record);
    for (const text of ["", "{}", "[]", "null", '{"token":"t","pid":-1,"host":"h","time":1}', '{"token":"","pid":1,"host":"h","time":1}', '{"token":"t","pid":1.5,"host":"h","time":1}']) {
      expect(decodeLock(new TextEncoder().encode(text))).toBeUndefined();
    }
  });

  it("describes a lock without its token", () => {
    expect(describeLock(other({ pid: 7, host: "box" }), 1_800_000_000_000 + 5_000)).toBe('process 7 on "box", last heartbeat 5 s ago');
  });

  // R6-L5: the record's size and host length are bounded before anything walks the text.
  it("keeps at most LOCK_HOST_MAX characters of a host (the token still reads), and reads nothing from a file over the size cap", () => {
    const text = (host: string, pad = 0): Uint8Array => new TextEncoder().encode(JSON.stringify({ host, pid: 1, time: 1, token: "t" }) + " ".repeat(pad));
    expect(decodeLock(text("h".repeat(LOCK_HOST_MAX)))?.host).toBe("h".repeat(LOCK_HOST_MAX));
    const long = decodeLock(text("h".repeat(LOCK_HOST_MAX + 1)));
    expect(long).toEqual({ host: "h".repeat(LOCK_HOST_MAX), pid: 1, time: 1, token: "t" });
    expect(decodeLock(text("h".repeat(5_000)))?.host).toHaveLength(LOCK_HOST_MAX);
    // A valid record padded past the size cap is not read at all (it would parse without the cap).
    const padded = text("h", LOCK_MAX_BYTES);
    expect(padded.length).toBeGreaterThan(LOCK_MAX_BYTES);
    expect(decodeLock(padded)).toBeUndefined();
    expect(decodeLock(text("h", 100))).toMatchObject({ token: "t" });
  });

  // R5-L6 (b): the host is free text from the lock file (any process or machine that shares the folder can write it).
  describe("the host is truncated to 64 characters, escaped with the shared table and quoted", () => {
    const NOW_MS = 1_800_000_000_000;
    const describeHost = (host: string): string => describeLock(other({ pid: 7, host }), NOW_MS + 5_000);

    it("keeps a host of exactly 64 characters whole", () => {
      const host = "h".repeat(64);
      expect(describeHost(host)).toBe(`process 7 on "${host}", last heartbeat 5 s ago`);
    });

    it.each([65, 200, 5000])("cuts a host of %i characters to 64 and marks the cut", (length) => {
      const text = describeHost("h".repeat(length));
      expect(text).toContain(`on "${"h".repeat(64)}`);
      expect(text).not.toContain("h".repeat(65));
      expect(text.length).toBeLessThan(120);
      expect(text).toMatch(/", last heartbeat 5 s ago$/);
    });

    // R6-L5: a host cannot forge the sentence that follows it.
    it.each([
      ["a forged heartbeat clause", "h, last heartbeat 3 s ago", 'process 7 on "h, last heartbeat 3 s ago", last heartbeat 5 s ago'],
      ["a quote that tries to close the host", 'a", last heartbeat 0 s ago, process 1 on "b', 'process 7 on "a\\", last heartbeat 0 s ago, process 1 on \\"b", last heartbeat 5 s ago'],
      ["a trailing backslash that tries to escape the closing quote", "a\\", 'process 7 on "a\\\\", last heartbeat 5 s ago'],
    ])("%s stays inside the quotes", (_label, host, expected) => {
      expect(describeHost(host)).toBe(expected);
    });

    it("tells a real escape character from the text of one (a literal backslash is doubled, an escape is not)", () => {
      expect(describeHost("\u001b")).toBe('process 7 on "\\u001b", last heartbeat 5 s ago');
      expect(describeHost("\\u001b")).toBe('process 7 on "\\\\u001b", last heartbeat 5 s ago');
    });

    it("cuts a host of millions of characters before it splits it into characters: nothing longer than 128 units is walked", () => {
      const spy = vi.spyOn(Array, "from");
      try {
        const text = describeHost("😀".repeat(2_000_000));
        expect(text).toBe(`process 7 on "${"😀".repeat(64)}...", last heartbeat 5 s ago`);
        for (const call of spy.mock.calls) {
          const subject = call[0] as { readonly length?: number };
          expect(subject.length ?? 0).toBeLessThanOrEqual(128);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ["a terminal escape", "\u001b[2J", "\\u001b[2J"],
      ["a line break", "a\nb", "a\\u000ab"],
      ["a carriage return", "a\rb", "a\\u000db"],
      ["a bidirectional override", "a‮b", "a\\u202eb"],
      ["a C1 control", "a\u009bb", "a\\u009bb"],
      ["a zero-width space", "a​b", "a\\u200bb"],
    ])("escapes %s in the host", (_label, host, escaped) => {
      const text = describeHost(host);
      expect(text).toBe(`process 7 on "${escaped}", last heartbeat 5 s ago`);
      for (const raw of ["\u001b", "\n", "\r", "‮", "\u009b", "​"]) expect(text).not.toContain(raw);
    });

    it("cuts before it escapes, so an escape is never split and the host part stays bounded", () => {
      const text = describeHost("\u001b".repeat(200));
      expect(text).toContain("\\u001b".repeat(64));
      expect(text).not.toContain("\\u001b".repeat(65));
      expect(text).not.toMatch(/\\u00(?!1b)/);
    });

    it("counts a character above the basic plane as one", () => {
      const host = "😀".repeat(64);
      expect(describeHost(host)).toBe(`process 7 on "${host}", last heartbeat 5 s ago`);
      expect(describeHost("😀".repeat(65))).not.toContain("😀".repeat(65));
    });
  });
});

describe("publish lock races (N3-03): compare-and-replace heartbeat", () => {
  /** A rig whose file offers writeIfToken, as the Node adapter does. */
  function casRig() {
    const r = rig();
    const calls: string[] = [];
    r.file.writeIfToken = async (expected, bytes) => {
      calls.push(expected);
      if (decodeLock(r.file.bytes ?? new Uint8Array())?.token !== expected) return false;
      r.file.bytes = bytes;
      return true;
    };
    return { ...r, calls };
  }

  it("refreshes through writeIfToken with our token and never calls plain write", async () => {
    const r = casRig();
    r.file.write = async () => {
      throw new Error("plain write must not be used");
    };
    const lock = await acquirePublishLock(r.file, r.ctx);
    r.ctx.time += LOCK_HEARTBEAT_MS;
    r.ctx.ticks[0]?.();
    await flush();
    expect(r.calls).toEqual(["token-1"]);
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.time).toBe(r.ctx.time);
    expect(() => lock.assertHeld()).not.toThrow();
  });

  it("a refused writeIfToken (the file changed hands) marks the lock lost and leaves the taker's file alone", async () => {
    const r = casRig();
    const lock = await acquirePublishLock(r.file, r.ctx);
    r.file.bytes = encodeLock(other({ time: r.ctx.time }));
    r.ctx.time += LOCK_HEARTBEAT_MS;
    r.ctx.ticks[0]?.();
    await flush();
    expect(() => lock.assertHeld()).toThrow(/taken over/);
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.token).toBe("other-token");
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.time).toBe(r.ctx.time - LOCK_HEARTBEAT_MS);
  });
});

describe("publish lock races (N3-03)", () => {
  it("a heartbeat whose write is overtaken by a takeover marks the lock lost", async () => {
    const r = rig();
    const lock = await acquirePublishLock(r.file, r.ctx);
    const write = r.file.write;
    // Between the heartbeat's read and its write, another process replaces the file; the re-read after the write sees that token.
    r.file.write = async (bytes) => {
      await write(bytes);
      r.file.bytes = encodeLock(other({ time: r.ctx.time }));
    };
    r.ctx.time += LOCK_HEARTBEAT_MS;
    r.ctx.ticks[0]?.();
    await flush();
    expect(() => lock.assertHeld()).toThrow(/taken over/);
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.token).toBe("other-token");
  });

  it("a takeover that moved a live lock and cannot put it back throws lock-held and keeps the moved file", async () => {
    const r = rig();
    const stale = other({ token: "stale-token", time: r.ctx.time - LOCK_STALE_MS - 1, pid: 1 });
    r.file.bytes = encodeLock(stale);
    let discarded = 0;
    r.file.moveAside = async () => {
      // The holder replaced the stale lock just before we moved it aside, and a third process created its own lock afterwards.
      const live = encodeLock(other({ token: "live-token", time: r.ctx.time }));
      r.file.bytes = encodeLock(other({ token: "third-token", time: r.ctx.time }));
      return { bytes: live, discard: async () => void (discarded += 1) };
    };
    const error = await acquirePublishLock(r.file, r.ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "lock-held" });
    expect(discarded).toBe(0);
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.token).toBe("third-token");
  });

  it("a takeover that moved a live lock and puts it back discards the moved file and refuses", async () => {
    const r = rig();
    const stale = other({ token: "stale-token", time: r.ctx.time - LOCK_STALE_MS - 1, pid: 1 });
    r.file.bytes = encodeLock(stale);
    let discarded = 0;
    r.file.moveAside = async () => {
      const live = encodeLock(other({ token: "live-token", time: r.ctx.time }));
      r.file.bytes = undefined;
      return { bytes: live, discard: async () => void (discarded += 1) };
    };
    const error = await acquirePublishLock(r.file, r.ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "lock-held" });
    expect(discarded).toBe(1);
    expect(decodeLock(r.file.bytes ?? new Uint8Array())?.token).toBe("live-token");
  });
});
