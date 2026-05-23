import { describe, it, expect } from "vitest";
import { redact, REDACTION_TOKEN } from "./index";
import { FIXTURES } from "./__fixtures__/cases";

describe("redact() — acceptance criteria", () => {
  describe("fixture cases", () => {
    for (const fx of FIXTURES) {
      it(fx.name, () => {
        expect(redact(fx.input, fx.knownNames)).toBe(fx.expected);
      });
    }
  });

  describe("pass 1: known names", () => {
    it("replaces a display name case-insensitively", () => {
      expect(redact("janed was here, JANED again, and JaneD finally", ["JaneD"])).toBe(
        `${REDACTION_TOKEN} was here, ${REDACTION_TOKEN} again, and ${REDACTION_TOKEN} finally`,
      );
    });

    it("is word-boundary aware (does not redact substrings)", () => {
      // "Jim" appears as a substring of "Jiminy"; only the standalone token
      // should be redacted. We use a non-dictionary placeholder name to
      // keep this test focused on pass 1's word-boundary logic.
      // (Note: "Jim" *is* in the dictionary, so pass 2 would catch the
      // standalone occurrence anyway — we still want pass 1 to honour
      // boundaries.)
      const out = redact("Jiminy Cricket says hi to Jim.", ["Jim"]);
      expect(out).toBe(`Jiminy Cricket says hi to ${REDACTION_TOKEN}.`);
    });

    it("redacts multi-word display names", () => {
      expect(redact("Posted by Jane Doe today.", ["Jane Doe"])).toBe(
        `Posted by ${REDACTION_TOKEN} today.`,
      );
    });

    it("prefers the longer known name when entries overlap", () => {
      const out = redact("Anne Marie wrote this. Anne also.", ["Anne", "Anne Marie"]);
      expect(out).toBe(`${REDACTION_TOKEN} wrote this. ${REDACTION_TOKEN} also.`);
    });

    it("handles regex metacharacters in known names", () => {
      const out = redact("Posted by C++Dev today.", ["C++Dev"]);
      expect(out).toBe(`Posted by ${REDACTION_TOKEN} today.`);
    });

    it("treats empty / whitespace-only entries as no-ops", () => {
      const out = redact("Just a generic review.", ["", "   "]);
      expect(out).toBe("Just a generic review.");
    });
  });

  describe("pass 2: NER lite", () => {
    it("redacts a capitalised dictionary hit", () => {
      expect(redact("Our server Sarah was great.", [])).toBe(
        `Our server ${REDACTION_TOKEN} was great.`,
      );
    });

    it("does not redact a lower-case dictionary word", () => {
      // "mark" appears in the dictionary but as lower-case ("you can mark
      // your spot") it should not be redacted.
      expect(redact("Please mark your spot in the queue.", [])).toBe(
        "Please mark your spot in the queue.",
      );
    });

    it("handles accented dictionary hits via diacritic-stripped lookup", () => {
      expect(redact("Joaquín served us.", [])).toBe(`${REDACTION_TOKEN} served us.`);
      expect(redact("Søren was on shift.", [])).toBe(`${REDACTION_TOKEN} was on shift.`);
    });

    it("redacts a name at the start of a sentence", () => {
      expect(redact("Sarah is the best server here.", [])).toBe(
        `${REDACTION_TOKEN} is the best server here.`,
      );
    });

    it("does not redact arbitrary capitalised non-names", () => {
      expect(redact("The Restaurant on Main Street was clean.", [])).toBe(
        "The Restaurant on Main Street was clean.",
      );
    });
  });

  describe("April-the-month vs April-the-person", () => {
    it("does not redact April after a date preposition", () => {
      expect(redact("We came in April for the festival.", [])).toBe(
        "We came in April for the festival.",
      );
    });

    it("does not redact April followed by a day-of-month number", () => {
      expect(redact("Visited April 3rd, 2026.", [])).toBe("Visited April 3rd, 2026.");
      expect(redact("Reservation on April 14.", [])).toBe("Reservation on April 14.");
    });

    it("redacts April when it reads as a person", () => {
      expect(redact("Our server April was wonderful.", [])).toBe(
        `Our server ${REDACTION_TOKEN} was wonderful.`,
      );
    });

    it("applies the same heuristic to May, June, July", () => {
      expect(redact("We visited in May, came back in June, and again in July.", [])).toBe(
        "We visited in May, came back in June, and again in July.",
      );
      expect(redact("Our server May took great care of us.", [])).toBe(
        `Our server ${REDACTION_TOKEN} took great care of us.`,
      );
    });
  });

  describe("preserves non-name content verbatim", () => {
    it("preserves punctuation and spacing", () => {
      const input = "Wow!!  Sarah — what a server...  Truly 5/5 :)";
      const out = redact(input, []);
      expect(out).toBe(`Wow!!  ${REDACTION_TOKEN} — what a server...  Truly 5/5 :)`);
    });

    it("preserves line breaks", () => {
      const input = "Line one.\nSarah was here.\n\nLine three.";
      expect(redact(input, [])).toBe(`Line one.\n${REDACTION_TOKEN} was here.\n\nLine three.`);
    });

    it("preserves emoji", () => {
      const input = "Sarah was great 😊🌟! Highly recommend 🔥";
      expect(redact(input, [])).toBe(`${REDACTION_TOKEN} was great 😊🌟! Highly recommend 🔥`);
    });

    it("preserves CRLF line endings", () => {
      expect(redact("Sarah here.\r\nMore text.", [])).toBe(
        `${REDACTION_TOKEN} here.\r\nMore text.`,
      );
    });
  });

  describe("purity and determinism", () => {
    it("returns the same output for the same input (determinism)", () => {
      const a = redact("Sarah and Tom went to dinner.", ["Tom"]);
      const b = redact("Sarah and Tom went to dinner.", ["Tom"]);
      expect(a).toBe(b);
    });

    it("does not mutate the knownNames array", () => {
      const names = ["JaneD", "Tom"];
      const snapshot = [...names];
      redact("JaneD and Tom were here.", names);
      expect(names).toEqual(snapshot);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(redact("", [])).toBe("");
      expect(redact("", ["JaneD"])).toBe("");
    });

    it("handles input that is all whitespace", () => {
      expect(redact("   \n\t  ", ["JaneD"])).toBe("   \n\t  ");
    });

    it("handles zero-name Reviews (no-op)", () => {
      const input = "The wait was long but the food was decent.";
      expect(redact(input, [])).toBe(input);
    });

    it("handles very long input (10k+ chars) in well under 100ms", () => {
      // 10k+ chars of mixed content, sprinkled with redactable names.
      const filler = "The service was quick and the food was hot. ".repeat(300);
      const input = `Sarah said: ${filler} Signed, JaneD.`;
      expect(input.length).toBeGreaterThan(10_000);

      const start = performance.now();
      const out = redact(input, ["JaneD"]);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
      expect(out.startsWith(`${REDACTION_TOKEN} said:`)).toBe(true);
      expect(out.endsWith(`Signed, ${REDACTION_TOKEN}.`)).toBe(true);
      // Filler does not contain any first names, so it should round-trip.
      expect(out).toContain(filler.trim());
    });

    it("idempotent — running redact twice yields the same result", () => {
      const once = redact("Sarah and Tom were great.", ["Tom"]);
      const twice = redact(once, ["Tom"]);
      expect(twice).toBe(once);
    });
  });
});
