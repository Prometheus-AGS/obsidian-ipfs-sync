import { describe, expect, it } from "vitest";
import {
  assertKeyOwnedForPublish,
  assertMfsMutationPath,
  assertValidKeyName,
  classifyKey,
  isValidKeyName,
  validateMfsRoot,
} from "../../src/core/config";
import { assertFixtureVault, classifyMarkerText } from "../../src/sync/publish-guard";

describe("validateMfsRoot", () => {
  it.each([
    ["/obsidian-vault-sync", "/obsidian-vault-sync"],
    ["/obsidian-vault-sync/", "/obsidian-vault-sync"],
    ["/obsidian-vault-sync/.probe", "/obsidian-vault-sync/.probe"],
    ["/obsidian-vault-sync/e2e/run-1/", "/obsidian-vault-sync/e2e/run-1"],
  ])("accepts %s", (input, expected) => {
    expect(validateMfsRoot(input)).toBe(expected);
  });

  it.each([
    "/obsidian-vault-staging",
    "/obsidian-vault-sync/../other",
    "/obsidian-vault-sync/../obsidian-vault-staging",
    "/obsidian-vault-sync-evil",
    "/obsidian-vault-syncx/child",
    "/obsidian-vault-sync//child",
    "/obsidian-vault-sync/./child",
    "/obsidian-vault-sync/%2e%2e/other",
    "/obsidian-vault-sync\\..\\other",
    "obsidian-vault-sync",
    "/",
    "",
    "/other",
  ])("rejects %s", (input) => {
    expect(() => validateMfsRoot(input)).toThrowError(/outside \/obsidian-vault-sync/);
  });
});

describe("assertMfsMutationPath", () => {
  it("accepts paths strictly under the base", () => {
    expect(assertMfsMutationPath("/obsidian-vault-sync/.probe/p.txt")).toBe("/obsidian-vault-sync/.probe/p.txt");
  });

  it.each(["/obsidian-vault-sync", "/obsidian-vault-staging/x", "/obsidian-vault-sync/../x", "/", "/x/obsidian-vault-sync/y"])(
    "rejects %s",
    (input) => {
      expect(() => assertMfsMutationPath(input)).toThrowError(/confined to \/obsidian-vault-sync\//);
    },
  );
});

describe("publication key names", () => {
  it.each(["obsidian-vault", "obsidian-vault-work", "obsidian-vault-a1-b2"])("accepts %s", (name) => {
    expect(isValidKeyName(name)).toBe(true);
    expect(assertValidKeyName(name)).toBe(name);
  });

  it.each(["consult-capture", "gomark-relay-lab", "prince-live", "self", "obsidian-vault-", "Obsidian-Vault", "obsidian-vaultx", ""])(
    "rejects %s",
    (name) => {
      expect(isValidKeyName(name)).toBe(false);
      expect(() => assertValidKeyName(name)).toThrowError(/refused/);
    },
  );

  it("explains that a reserved name belongs to another project", () => {
    expect(() => assertValidKeyName("prince-live")).toThrowError(/another project/);
  });
});

describe("classifyKey", () => {
  const nodeKeys = [
    { name: "self", id: "k51self" },
    { name: "prince-live", id: "k51prince" },
    { name: "obsidian-vault", id: "k51mine" },
  ];

  it("reports absent when no key has the name", () => {
    expect(classifyKey("obsidian-vault-new", nodeKeys, ["k51mine"]).state).toBe("absent");
  });

  it("reports owned when the node key ID is recorded", () => {
    const result = classifyKey("obsidian-vault", nodeKeys, ["k51mine"]);
    expect(result).toMatchObject({ state: "owned", id: "k51mine" });
  });

  it("reports foreign for a name match with an unrecorded ID", () => {
    const result = classifyKey("obsidian-vault", nodeKeys, ["k51other"]);
    expect(result).toMatchObject({ state: "foreign", id: "k51mine" });
  });

  it("reports foreign when nothing is recorded as owned", () => {
    expect(classifyKey("obsidian-vault", nodeKeys, []).state).toBe("foreign");
  });

  it("reports foreign when the node returns no key ID", () => {
    const result = classifyKey("obsidian-vault", [{ name: "obsidian-vault" }], ["k51mine"]);
    expect(result.state).toBe("foreign");
    expect(result.reason).toMatch(/cannot be verified/);
  });

  it("only an owned key passes the publish gate", () => {
    const owned = classifyKey("obsidian-vault", nodeKeys, ["k51mine"]);
    const foreign = classifyKey("obsidian-vault", nodeKeys, []);
    expect(() => assertKeyOwnedForPublish("obsidian-vault", owned)).not.toThrow();
    expect(() => assertKeyOwnedForPublish("obsidian-vault", foreign)).toThrowError(/publishing is refused/);
  });
});

describe("assertFixtureVault", () => {
  it("passes only for the `fixture` marker value", () => {
    expect(() => assertFixtureVault("fixture")).not.toThrow();
  });

  it.each(["absent", "pulled-fixture", "empty", "unrecognised"] as const)("refuses the marker state %s with the review-pending message", (state) => {
    expect(() => assertFixtureVault(state)).toThrowError(/not yet independently reviewed or verified in Obsidian/);
    expect(() => assertFixtureVault(state)).toThrowError(/create \.ipfs-sync-fixture at the vault root containing the text "fixture"/);
    expect(() => assertFixtureVault(state)).toThrowError(expect.objectContaining({ code: "fixture-marker-required" }));
  });
});

describe("classifyMarkerText", () => {
  it.each([
    ["fixture", "fixture"],
    ["fixture\n", "fixture"],
    ["fixture\r\n", "fixture"],
    ["pulled-fixture", "pulled-fixture"],
    ["pulled-fixture\n", "pulled-fixture"],
    ["", "empty"],
    ["\n", "empty"],
    ["Fixture", "unrecognised"],
    ["fixture\n\n", "unrecognised"],
    [" fixture", "unrecognised"],
    ["fixture copy created by ipfs-sync pull\n", "unrecognised"],
    ["marker", "unrecognised"],
  ] as const)("reads %j as %s", (text, expected) => {
    expect(classifyMarkerText(text)).toBe(expected);
  });
});
