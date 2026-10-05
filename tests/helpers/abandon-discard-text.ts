import { expect } from "vitest";

/**
 * R6-M2: what every abandon surface (CLI consequences, CLI help, plugin dialog) must say about `keys discard`. The truth is
 * `discardStatements` in `src/sync/key-management-text.ts` and `cli/keys-discard.ts`: discard takes the key-slot file of a rewrap
 * back only while that rewrap has not published; otherwise it forgets the record and takes nothing back.
 */
export function expectDiscardCaveat(rawText: string): void {
  const text = rawText.replace(/\s+/g, " ");
  // The existing statements stay.
  expect(text).toMatch(/pending key-slot rewrap or history prune/);
  expect(text).toMatch(/dropped/);
  expect(text).toMatch(/not withdrawn/);
  expect(text).toMatch(/may stay in the shared tree/);
  expect(text).toContain("keys discard");
  // The new conditions.
  expect(text).toMatch(/only for a rewrap that has not yet published/);
  expect(text).toMatch(/for a prune, or a rewrap that has published, it forgets the record and takes nothing back/);
  expect(text).toMatch(/removed history files stay removed/);
  expect(text).toMatch(/a published key-slot file stays/);
  // The order, and why.
  expect(text).toMatch(/before you abandon/);
  expect(text).toMatch(/abandon drops the record that would let it/);
  // No sentence says discard withdraws without the condition.
  expect(text).not.toMatch(/keys discard`? (is the command that )?withdraws it/);
  expect(text).not.toMatch(/is the command that withdraws/);
  expect(text).not.toMatch(/to withdraw it, run/i);
  for (const sentence of text.split(/(?<=\.)\s/)) {
    if (/keys discard/.test(sentence) && /withdraws/.test(sentence)) expect(sentence).toMatch(/only for a rewrap that has not yet published/);
  }
}
