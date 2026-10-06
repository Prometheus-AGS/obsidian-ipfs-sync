import { describe, expect, it } from "vitest";
import type { ConflictEvent, PublishCompleteEvent, PullCompleteEvent } from "../../src/core/events/event-types";
import { mapConflictEvent, mapPublishEvent, mapPullEvent } from "../../src/core/store";

const publishEvent: PublishCompleteEvent = {
  rootCid: "bafy-root",
  manifestCid: "bafy-cur",
  written: 4,
  removed: 2,
  durationMs: 87,
};

const pullEvent: PullCompleteEvent = {
  rootCid: "bafy-root",
  manifestCid: "bafy-cur",
  fetched: 6,
  unchanged: 10,
  conflicted: 1,
  failed: 0,
  remoteDeleted: 2,
  locallyModified: 3,
  forcedReverify: false,
  durationMs: 150,
};

describe("map-event", () => {
  it("maps a publish event to a record with root CID, counts and duration", () => {
    const record = mapPublishEvent(publishEvent, 1_000);
    expect(record).toEqual({
      kind: "publish",
      occurredAtMs: 1_000,
      rootCid: "bafy-root",
      manifestCid: "bafy-cur",
      written: 4,
      removed: 2,
      durationMs: 87,
    });
  });

  it("maps a plaintext pull event without inventing mvp-07a counters", () => {
    const record = mapPullEvent(pullEvent, 2_000);
    expect(record).toEqual({
      kind: "pull",
      occurredAtMs: 2_000,
      rootCid: "bafy-root",
      manifestCid: "bafy-cur",
      fetched: 6,
      unchanged: 10,
      conflicted: 1,
      failed: 0,
      remoteDeleted: 2,
      locallyModified: 3,
      durationMs: 150,
    });
    expect("forcedReverify" in record).toBe(false);
    expect("sequence" in record).toBe(false);
    expect("integrityFailed" in record).toBe(false);
  });

  it("carries the mvp-07a counters when the pull event sets them", () => {
    const encryptedPull: PullCompleteEvent = {
      ...pullEvent,
      forcedReverify: true,
      sequence: 41,
      complete: false,
      integrityFailed: 1,
      unfetched: 2,
      policySkipped: 3,
      restored: 4,
    };
    const record = mapPullEvent(encryptedPull, 3_000);
    expect(record).toMatchObject({
      kind: "pull",
      occurredAtMs: 3_000,
      sequence: 41,
      complete: false,
      integrityFailed: 1,
      unfetched: 2,
      policySkipped: 3,
      restored: 4,
    });
    expect("forcedReverify" in record).toBe(false);
  });

  it("maps a conflict event to a record that holds neither the path nor the conflictPath", () => {
    const event: ConflictEvent = {
      path: "notes/secret-meeting.md",
      conflictPath: "notes/secret-meeting.conflict-20261005.md",
      localSha256: "deadbeef",
      remoteSha256: "cafef00d",
    };
    const record = mapConflictEvent(event, "bafy-root", 4_000);
    expect(record).toEqual({
      kind: "conflict",
      occurredAtMs: 4_000,
      rootCid: "bafy-root",
      localSha256: "deadbeef",
      remoteSha256: "cafef00d",
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(event.path);
    expect(serialized).not.toContain(event.conflictPath);
    expect(serialized).not.toContain("secret-meeting");
  });
});
