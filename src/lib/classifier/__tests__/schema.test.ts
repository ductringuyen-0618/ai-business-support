/**
 * Schema-level guards. These don't need Anthropic at all — they pin the
 * invariants between `is_incident` and `severity`, the fixed Theme/Sentiment
 * sets, and the 500-char cap on suggested_reply. Independent of prompt v1.
 */
import { describe, expect, it } from "vitest";

import { THEMES, SENTIMENTS, SEVERITIES, classificationSchema } from "../schema";

function base() {
  return {
    is_incident: false,
    severity: null,
    themes: ["service"],
    sentiment: "positive",
    suggested_reply: "Thanks for the review!",
    prompt_version: "v1",
  };
}

describe("classificationSchema", () => {
  it("accepts a minimal valid non-incident Classification", () => {
    const r = classificationSchema.safeParse(base());
    expect(r.success).toBe(true);
  });

  it("requires severity when is_incident is true", () => {
    const r = classificationSchema.safeParse({ ...base(), is_incident: true, severity: null });
    expect(r.success).toBe(false);
  });

  it("requires severity to be null when is_incident is false", () => {
    const r = classificationSchema.safeParse({ ...base(), is_incident: false, severity: "low" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown themes", () => {
    const r = classificationSchema.safeParse({ ...base(), themes: ["fries_quality"] });
    expect(r.success).toBe(false);
  });

  it("requires at least one theme", () => {
    const r = classificationSchema.safeParse({ ...base(), themes: [] });
    expect(r.success).toBe(false);
  });

  it("caps suggested_reply at 500 characters", () => {
    const r = classificationSchema.safeParse({ ...base(), suggested_reply: "x".repeat(501) });
    expect(r.success).toBe(false);
  });

  it("locks the Theme set to the CONTEXT.md taxonomy", () => {
    expect([...THEMES]).toEqual([
      "service",
      "product_quality",
      "cleanliness",
      "wait_time",
      "pricing",
      "staff_attitude",
      "accessibility",
      "other",
    ]);
  });

  it("locks the Sentiment trio", () => {
    expect([...SENTIMENTS]).toEqual(["positive", "neutral", "negative"]);
  });

  it("locks the Severity scale", () => {
    expect([...SEVERITIES]).toEqual(["low", "medium", "high"]);
  });
});
