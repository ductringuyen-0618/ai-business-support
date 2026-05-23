/**
 * Deterministic in-process Anthropic mock for E2E tests.
 *
 * Activated by `E2E_TEST_MODE=1` (see `src/lib/classifier/anthropic-client.ts`).
 * Returns a Classification verdict driven purely by the user message text +
 * star rating — no network call, no fixture file lookup, just a pure function
 * so the assertions in `tests/e2e/happy-path.spec.ts` are stable.
 *
 * The verdicts are tuned to the slice-5 `single-page.json` fixture:
 *   - 5★ "Best coffee in town" → positive, NOT an incident, theme=service
 *   - 4★ "Good food, a bit slow" → neutral, NOT an incident, theme=wait_time
 *   - 5★ star-only Review (Anonymous, no body) → neutral, NOT an incident, theme=other
 *   - 2★ "Found a hair in my salad" → NEGATIVE, **incident=true, severity=high**,
 *     themes=cleanliness + product_quality. This is the Review the spec drives
 *     the "Mark resolved" flow on, and the one that triggers the mocked
 *     Resend send via the fire_incident → deliver_escalation pipeline.
 *   - 1★ "Waited 40 minutes" → NEGATIVE, not-incident (slow, not unsafe),
 *     theme=wait_time. We mark only ONE incident in the fixture set so the
 *     unresolved-Incident badge math in the spec is obvious.
 */
import type {
  AnthropicCreateParams,
  AnthropicCreateResponse,
  AnthropicMessageClient,
} from "@/lib/classifier/anthropic-client";

import { recordMockCall } from "./recorder";

interface Verdict {
  is_incident: boolean;
  severity: "low" | "medium" | "high" | null;
  themes: string[];
  sentiment: "positive" | "neutral" | "negative";
  suggested_reply: string;
}

/**
 * Classify a Review from its user-message text. The Classifier embeds the
 * redacted text + star rating directly in the user message; we sniff for
 * keywords to derive the verdict.
 */
function classifyFromText(text: string): Verdict {
  const lower = text.toLowerCase();
  const starMatch = /star[_ ]?rating[^\d]*(\d)/i.exec(text);
  const stars = starMatch ? Number(starMatch[1]) : null;

  // Hair / contamination — the canonical Incident in the fixture set.
  if (lower.includes("hair") || lower.includes("contamination") || lower.includes("unsafe")) {
    return {
      is_incident: true,
      severity: "high",
      themes: ["cleanliness", "product_quality"],
      sentiment: "negative",
      suggested_reply:
        "Hi — we are so sorry, this is unacceptable. Please email us at hello@example.com so we can make it right and audit our prep line.",
    };
  }
  if (lower.includes("wait") || lower.includes("waited") || lower.includes("slow")) {
    return {
      is_incident: false,
      severity: null,
      themes: ["wait_time"],
      sentiment: stars !== null && stars <= 2 ? "negative" : "neutral",
      suggested_reply:
        "Thank you for the feedback — we are working on staffing peak hours and your note helps us prioritise.",
    };
  }
  if (lower.includes("best") || lower.includes("great") || lower.includes("love")) {
    return {
      is_incident: false,
      severity: null,
      themes: ["service"],
      sentiment: "positive",
      suggested_reply: "Thank you for the kind words — we will pass this on to the team.",
    };
  }
  // Star-only or fallthrough.
  return {
    is_incident: false,
    severity: null,
    themes: ["other"],
    sentiment: stars !== null && stars >= 4 ? "positive" : "neutral",
    suggested_reply: "Thanks for taking the time to leave a review.",
  };
}

export function createE2EAnthropicMock(): AnthropicMessageClient {
  return {
    async create(params: AnthropicCreateParams): Promise<AnthropicCreateResponse> {
      const userMessage = params.messages.map((m) => m.content).join("\n");
      const verdict = classifyFromText(userMessage);
      recordMockCall({
        service: "anthropic",
        payload: {
          model: params.model,
          // Truncated — full system prompt is ~8KB and not useful in assertions.
          system_prefix: params.system[0]?.text.slice(0, 80) ?? "",
          user_message_prefix: userMessage.slice(0, 200),
          verdict,
        },
      });
      // The Classifier extracts JSON between `<output>...</output>` tags.
      const json = JSON.stringify(verdict);
      return {
        content: [{ type: "text", text: `<output>${json}</output>` }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
  };
}
