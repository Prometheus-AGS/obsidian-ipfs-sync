// mvp-07a task 4.5: decideThreeWay moved out of pull-plan.ts into three-way.ts. Every row of the table (pull-plan.ts is gone since mvp-07b 3.1c).
import { describe, expect, it } from "vitest";
import { decideThreeWay, type ThreeWayOutcome } from "../../src/sync/three-way";

describe("decideThreeWay (three-way.ts)", () => {
  const A = "a";
  const B = "b";
  const C = "c";
  // [local, base, remote, outcome]: every combination of present/absent and equal/different.
  const table: readonly (readonly [string | undefined, string | undefined, string, ThreeWayOutcome])[] = [
    [undefined, undefined, A, "fetch"],
    [undefined, A, A, "fetch"],
    [undefined, B, A, "fetch"],
    [A, undefined, A, "unchanged"],
    [A, A, A, "unchanged"],
    [A, B, A, "unchanged"],
    [A, undefined, B, "conflict"],
    [A, A, B, "replace"],
    [A, B, C, "conflict"],
    [A, C, B, "conflict"],
    [B, A, A, "locally-modified"],
    [B, undefined, A, "conflict"],
    [B, C, A, "conflict"],
  ];

  it.each(table)("L=%s B=%s R=%s -> %s", (local, base, remote, outcome) => {
    expect(decideThreeWay(local, base, remote)).toBe(outcome);
  });
});
