import { describe, expect, it } from "vitest";
import {
  assertFixtureVault,
  assertKeyOwnedForPublish,
  assertMfsMutationPath,
  assertValidKeyName,
  classifyKey,
  isValidKeyName,
  validateMfsRoot,
} from "../../src/core/config";

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
  it("passes for a fixture vault", () => {
    expect(() => assertFixtureVault(true)).not.toThrow();
  });

  it("refuses a real vault before any request", () => {
    expect(() => assertFixtureVault(false)).toThrowError(/encryption is not available yet/);
  });
});
