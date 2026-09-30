import { describe, expect, it } from "vitest";
import { promptText, stripControlCharacters } from "../../cli/io";

describe("cli io: node-chosen text in prompts (N3-06)", () => {
  it("strips C0, DEL, C1 and bidirectional controls from the prompt text", () => {
    const hostile = "Remove \u001b[2Jjunk\u0085\u007f\u009f‮⁦name‏\nnext line?";
    const shown = promptText(hostile);
    expect(shown).toBe("Remove ?[2Jjunk?????name??next line? [y/N] ");
    expect(shown).not.toMatch(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
  });

  it("leaves ordinary text, including non-ASCII letters, unchanged", () => {
    expect(stripControlCharacters("Continue? café 日本")).toBe("Continue? café 日本");
    expect(promptText("Continue?")).toBe("Continue? [y/N] ");
  });
});
