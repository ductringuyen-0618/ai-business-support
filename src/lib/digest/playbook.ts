/**
 * Playbook seed catalogue.
 *
 * A curated catalogue of remediation and reinforcement Patterns that the
 * Digest LLM (slice 14) selects from when generating the weekly suggested
 * actions. See `docs/adr/0008-playbook-backed-digest-suggestions.md` for
 * the full rationale and the `Pattern` shape.
 *
 * Editing rules — read before adding a Pattern:
 *
 * 1. `id` is a stable slug. Once a Pattern ships, NEVER rename or remove
 *    the id. Stored Digest bodies (slice 14) reference these ids and we
 *    don't want dangling references. To deprecate, leave the entry in
 *    place and stop selecting it via the selector (or remove themes).
 * 2. `themes` must use the fixed Theme set declared below. No free-text.
 * 3. `verticals` is OPTIONAL. Omit entirely for a universal Pattern.
 *    Use lowercase snake_case slugs matching `Business.industry`.
 * 4. `title` is a short imperative ("Review peak-hour staffing levels"),
 *    not a description ("Peak-hour staffing"). Max ~70 chars.
 * 5. `body` is 1–2 sentences with concrete guidance. Avoid generic
 *    platitudes ("improve service"). The Digest LLM will quote actual
 *    Reviews around this text, so leave room for it to add specifics.
 * 6. `signals` describes when the Pattern is most relevant. The LLM uses
 *    this to decide whether the week's Reviews actually match. Be
 *    concrete ("wait_time mentioned 3+ times in a single week"), not
 *    vague ("when there are complaints").
 *
 * See `src/lib/digest/README.md` for the full PR checklist.
 */

export type Theme =
  | "service"
  | "product_quality"
  | "cleanliness"
  | "wait_time"
  | "pricing"
  | "staff_attitude"
  | "accessibility"
  | "other";

export interface Pattern {
  /** Stable slug — never rename once shipped. */
  id: string;
  /** Themes this Pattern applies to. At least one. */
  themes: Theme[];
  /** Optional industry filter. Omit for universal Patterns. */
  verticals?: string[];
  /** Whether this is for negative weeks (remediation) or positive (reinforcement). */
  kind: "remediation" | "reinforcement";
  /** Short imperative title. */
  title: string;
  /** 1–2 sentences expanding the action. */
  body: string;
  /** Note on when this Pattern is most relevant — fed to the Digest LLM. */
  signals: string;
}

const PLAYBOOK_ENTRIES = [
  // ────────────────────────────────────────────────────────────────────
  // SERVICE — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "service-recovery-outreach",
    themes: ["service"],
    kind: "remediation",
    title: "Run a service-recovery outreach to the week's unhappy Reviewers",
    body: "Identify the Reviewers who left 1–2 star Reviews mentioning service breakdowns this week and draft a personal apology + remediation offer. A 24-hour response window typically halves the chance of a follow-up complaint reaching social media.",
    signals: "Multiple service-themed 1–2 star Reviews in the same week.",
  },
  {
    id: "service-script-refresh",
    themes: ["service"],
    kind: "remediation",
    title: "Refresh front-line scripts for the top recurring complaint",
    body: "Pull the single most repeated service complaint from this week's Reviews and write a 3-line response script the team can use when a customer raises it. Practise it at the next shift huddle.",
    signals: "Same service complaint repeats across 3+ Reviews.",
  },
  {
    id: "service-shadow-shift",
    themes: ["service"],
    kind: "remediation",
    title: "Shadow a full shift to confirm the gap is real",
    body: "Spend one peak shift observing the customer journey end-to-end without intervening. Most repeating service complaints surface within 30 minutes of watching the live flow.",
    signals: "Vague service complaints that don't point at one root cause.",
  },
  {
    id: "service-feedback-loop",
    themes: ["service", "other"],
    kind: "remediation",
    title: "Close the loop with the Reviewer once the fix lands",
    body: "When a service issue raised in a Review is fixed, message the Reviewer with a one-line update. Showing you read and acted on the Review is the fastest path to a revised rating.",
    signals: "Reviewer mentions a specific fixable issue (not a one-off mood complaint).",
  },

  // ────────────────────────────────────────────────────────────────────
  // PRODUCT_QUALITY — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "product-quality-batch-audit",
    themes: ["product_quality"],
    kind: "remediation",
    title: "Audit the batch / supplier behind the week's quality complaints",
    body: "Cross-reference the dates of the negative product Reviews against your delivery / production logs. A single bad batch or supplier change is the most common explanation for a quality cluster.",
    signals: "Quality complaints cluster within a 2–3 day window.",
  },
  {
    id: "product-quality-spec-check",
    themes: ["product_quality"],
    kind: "remediation",
    title: "Re-check the spec on the most-complained-about item",
    body: "Pull the recipe / spec sheet for the item Reviewers named most often this week and confirm it still matches what the team is actually producing. Specs drift quietly over months.",
    signals: "One specific product / item named in multiple Reviews.",
  },
  {
    id: "product-quality-supplier-conversation",
    themes: ["product_quality"],
    kind: "remediation",
    title: "Open a supplier conversation with the week's complaints in hand",
    body: "Send the relevant supplier a concise note quoting (anonymised) Reviewer complaints. Suppliers respond faster to specific customer feedback than to generic quality concerns.",
    signals: "Quality complaints point at an ingredient / component you don't make in-house.",
  },
  {
    id: "product-quality-secret-shopper",
    themes: ["product_quality", "service"],
    kind: "remediation",
    title: "Run a secret-shopper pass on the flagged item",
    body: "Have someone unfamiliar to the team order or use the item and report back with photos. Often catches the quality drift the regular team has stopped noticing.",
    signals: "Repeated complaints about an item the team insists is fine.",
  },

  // ────────────────────────────────────────────────────────────────────
  // CLEANLINESS — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "cleanliness-deep-clean",
    themes: ["cleanliness"],
    kind: "remediation",
    title: "Schedule a one-off deep clean of the area Reviewers named",
    body: "Block a slot before opening this week for a deep clean of the specific area mentioned in Reviews (restrooms, table edges, floors). Photograph before/after for the team channel.",
    signals: "Reviewers mention a specific area being unclean.",
  },
  {
    id: "cleanliness-checklist-rotation",
    themes: ["cleanliness"],
    kind: "remediation",
    title: "Rotate the cleaning-checklist owner each shift",
    body: "Cleaning checklists go stale when the same person signs them every day. Rotate the owner per shift and require a photo at sign-off for the next two weeks.",
    signals: "Cleanliness complaints persist despite a checklist being in place.",
  },
  {
    id: "cleanliness-restroom-audit",
    themes: ["cleanliness"],
    kind: "remediation",
    title: "Audit restroom cleaning frequency against peak traffic",
    body: "Restrooms are the most common cleanliness complaint and the first thing Reviewers photograph. Check whether cleaning intervals double during your busiest hours.",
    signals: "Cleanliness complaint specifically names restrooms / toilets.",
  },

  // ────────────────────────────────────────────────────────────────────
  // WAIT_TIME — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "wait-time-staffing-review",
    themes: ["wait_time"],
    kind: "remediation",
    title: "Review peak-hour staffing levels against last quarter's rota",
    body: "Compare the rota for the days Reviewers complained about waiting with the same days last quarter. Most wait-time clusters trace back to a single under-staffed shift pattern.",
    signals: "wait_time mentioned 3+ times in a single week.",
  },
  {
    id: "wait-time-queue-comms",
    themes: ["wait_time"],
    kind: "remediation",
    title: "Set an explicit wait-time expectation at the door",
    body: "Reviewers tolerate waits twice as long when the expected duration is stated up front. Brief the host / greeter to quote a current wait and offer a wait-list SMS.",
    signals: "Reviewer says the wait was unexpected, not that it was long.",
  },
  {
    id: "wait-time-throughput-bottleneck",
    themes: ["wait_time"],
    kind: "remediation",
    title: "Time the bottleneck step end-to-end on a busy shift",
    body: "Pick the step Reviewers complain about (order-taking, prep, payment) and stopwatch it across 20 customers on a busy shift. Throughput problems almost always live in one step, not the whole flow.",
    signals: "Reviews mention slowness at a specific stage (ordering, paying, food coming out).",
  },
  {
    id: "wait-time-online-queue",
    themes: ["wait_time"],
    kind: "remediation",
    title: "Add an online queue or callback system",
    body: "If wait-time complaints come from Reviewers physically queueing on-site, an online queue (SMS callback, virtual ticket) typically cuts the perceived wait by half within two weeks.",
    signals: "Wait-time complaints describe standing in line, not in-seat waits.",
  },

  // ────────────────────────────────────────────────────────────────────
  // PRICING — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "pricing-value-narrative",
    themes: ["pricing"],
    kind: "remediation",
    title: "Refresh the value narrative on menus / price lists",
    body: "Pricing complaints are usually value complaints. Add a one-line explanation next to your highest-priced items (sourcing, portion, technique) — Reviewers stop perceiving them as overpriced once they understand why.",
    signals: "Reviewers say items are 'overpriced' without naming a specific defect.",
  },
  {
    id: "pricing-comparison-check",
    themes: ["pricing"],
    kind: "remediation",
    title: "Benchmark your prices against three nearby competitors",
    body: "Walk three nearby competitors and price-check your five most-ordered items. If you're within 10% the issue is perception, not absolute price — change the narrative, not the price.",
    signals: "Reviewers compare your prices to a named competitor.",
  },
  {
    id: "pricing-surprise-charges",
    themes: ["pricing"],
    kind: "remediation",
    title: "Eliminate surprise charges at the bill / checkout",
    body: "Surcharges that appear only at checkout (service charge, card fee, weekend uplift) are the most reliable trigger for a pricing complaint. Surface them on the menu / quote instead.",
    signals: "Pricing complaint mentions being surprised at the bill / final cost.",
  },
  {
    id: "pricing-loyalty-offer",
    themes: ["pricing"],
    kind: "remediation",
    title: "Offer a returning-customer discount to repeat unhappy Reviewers",
    body: "If a Reviewer is otherwise a regular, a small loyalty offer often converts the next visit into a positive Review and re-anchors their price perception.",
    signals: "Reviewer mentions being a regular / returning customer in a pricing complaint.",
  },

  // ────────────────────────────────────────────────────────────────────
  // STAFF_ATTITUDE — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "staff-attitude-named-coaching",
    themes: ["staff_attitude"],
    kind: "remediation",
    title: "Coach the named team member privately within 48 hours",
    body: "When a Reviewer names a specific staff member, a private, non-disciplinary coaching conversation within 48 hours is the highest-leverage move. Don't share the Review verbatim — paraphrase the behaviour.",
    signals: "A staff member is named explicitly in a negative Review.",
  },
  {
    id: "staff-attitude-shift-debrief",
    themes: ["staff_attitude"],
    kind: "remediation",
    title: "Run a 10-minute shift debrief on the day in question",
    body: "Identify the shift the complaint happened on and ask the whole team what was unusual that day. Attitude complaints often correlate with stress events (a no-show, a system outage) the team will tell you about.",
    signals: "Attitude complaint is anonymous but tied to a specific date / shift.",
  },
  {
    id: "staff-attitude-policy-clarity",
    themes: ["staff_attitude", "service"],
    kind: "remediation",
    title: "Clarify the policy the team was enforcing",
    body: "Many attitude complaints stem from a staff member enforcing a real policy (no refunds after X, no substitutions) without the soft skills to explain it warmly. Write the policy + the warm-explanation script together.",
    signals: "Reviewer is angry about a refusal or refusal-style interaction.",
  },
  {
    id: "staff-attitude-team-sentiment",
    themes: ["staff_attitude"],
    kind: "remediation",
    title: "Check in on team sentiment before more Reviews land",
    body: "Persistent staff-attitude complaints almost always reflect team morale, not individual personality. Run a 1-on-1 with each customer-facing team member this week and ask one question: what's making the job harder than it should be?",
    signals: "Attitude complaints from multiple different Reviewers in the same week.",
  },

  // ────────────────────────────────────────────────────────────────────
  // ACCESSIBILITY — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "accessibility-physical-audit",
    themes: ["accessibility"],
    kind: "remediation",
    title: "Walk the premises with an accessibility checklist",
    body: "Borrow a free local-council or charity accessibility checklist and walk the premises end-to-end this week. Reviewers' specific complaints (step at the door, narrow aisle) are usually the tip of a wider issue.",
    signals: "Reviewer mentions a physical-access issue (steps, doorways, ramps, restrooms).",
  },
  {
    id: "accessibility-staff-training",
    themes: ["accessibility", "staff_attitude"],
    kind: "remediation",
    title: "Brief the team on accessible-service basics",
    body: "Run a 15-minute team brief covering the basics: ask before helping, speak directly to the customer (not their companion), keep aisles clear. Reviewers more often complain about the interaction than the building itself.",
    signals: "Accessibility complaint describes a staff interaction, not a physical barrier.",
  },
  {
    id: "accessibility-signage-and-info",
    themes: ["accessibility"],
    kind: "remediation",
    title: "Publish accessibility info on your booking / location page",
    body: "Many accessibility complaints come from Reviewers who only discovered an issue on arrival. Document step-free entry, restroom layout, parking, and quiet hours on your website's location page.",
    signals: "Reviewer says they would have known not to come if the info had been online.",
  },
  {
    id: "accessibility-companion-policy",
    themes: ["accessibility"],
    kind: "remediation",
    title: "Confirm your companion / service-animal policy is on display",
    body: "Service-animal and companion-of-customer policies are required in most jurisdictions and often unclear at the door. Confirm signage is current and that every team member can state the policy in one sentence.",
    signals: "Accessibility complaint involves a service animal or companion being challenged.",
  },

  // ────────────────────────────────────────────────────────────────────
  // OTHER — remediation
  // ────────────────────────────────────────────────────────────────────
  {
    id: "other-respond-publicly",
    themes: ["other"],
    kind: "remediation",
    title: "Draft a public reply to the most-detailed Review of the week",
    body: "When the complaint doesn't fit a clean Theme, the highest-leverage move is a calm public reply on the Source itself. Future Reviewers reading the page will weight your response heavily.",
    signals: "Detailed Review with a unique complaint that won't recur often.",
  },
  {
    id: "other-categorise-and-watch",
    themes: ["other"],
    kind: "remediation",
    title: "Tag the new complaint type and watch for repeats",
    body: "If a complaint doesn't fit existing Themes, write a one-line note describing it in your operations log. If two more land in the next four weeks, treat it as a new Theme worth a dedicated action.",
    signals: "First-time complaint pattern you haven't seen before.",
  },
  {
    id: "other-third-party-issue",
    themes: ["other"],
    kind: "remediation",
    title: "Escalate the issue to the third party named in the Review",
    body: "Some complaints (delivery rider, parking, payment processor, landlord) are not yours to fix directly. Send a concise escalation to the responsible third party quoting the Review and ask for a written response within a week.",
    signals: "Reviewer complains about something operated by a third party.",
  },

  // ────────────────────────────────────────────────────────────────────
  // Vertical-specific remediation Patterns
  // ────────────────────────────────────────────────────────────────────
  {
    id: "restaurant-food-safety-audit",
    themes: ["cleanliness", "product_quality"],
    verticals: ["restaurant", "cafe"],
    kind: "remediation",
    title: "Run an internal food-safety audit before the next inspection",
    body: "A Reviewer mentioning anything food-safety adjacent (illness, off taste, hair, cross-contamination) should trigger a same-week internal audit. Document temperatures, dates, and handwashing compliance.",
    signals: "Any Review hints at illness, off taste, or cross-contamination.",
  },
  {
    id: "restaurant-table-turn-review",
    themes: ["wait_time"],
    verticals: ["restaurant", "cafe"],
    kind: "remediation",
    title: "Recalculate table-turn assumptions against actual data",
    body: "Pull the last four Friday/Saturday seatings and measure actual table-turn vs. the planned cadence. Most weekend wait-time complaints come from a 5–10 minute overrun no one is tracking.",
    signals: "Wait-time complaints concentrate on weekend evenings.",
  },
  {
    id: "barbershop-walkin-management",
    themes: ["wait_time", "service"],
    verticals: ["barbershop", "salon"],
    kind: "remediation",
    title: "Switch walk-ins to a virtual queue for the next two Saturdays",
    body: "Walk-in queues physically clog the shop and frustrate booked customers. A free virtual-queue app for two Saturdays will tell you whether the underlying issue is throughput or perception.",
    signals: "Wait-time or service complaints on weekends with mention of walk-ins.",
  },
  {
    id: "salon-consultation-discipline",
    themes: ["service", "product_quality"],
    verticals: ["salon", "barbershop"],
    kind: "remediation",
    title: "Reinforce the pre-service consultation script",
    body: "Most service / outcome complaints in personal-care trace back to a rushed consultation. Require a 3-minute consultation with reference photos for every colour / cut service this week.",
    signals: "Reviewer says the outcome didn't match what they asked for.",
  },
  {
    id: "dentist-pain-followup-call",
    themes: ["service", "staff_attitude"],
    verticals: ["dentist"],
    kind: "remediation",
    title: "Add a 24-hour post-procedure follow-up call",
    body: "Most dental Reviews complaining about pain or staff coldness reference the hours immediately after the procedure, not the chair-side experience. A scripted follow-up call within 24 hours shifts the perception dramatically.",
    signals: "Reviewer mentions post-procedure pain or feeling unsupported after leaving.",
  },
  {
    id: "dentist-cost-transparency",
    themes: ["pricing"],
    verticals: ["dentist"],
    kind: "remediation",
    title: "Issue a written cost estimate before every procedure",
    body: "Dental pricing complaints are nearly always about the difference between expected and actual cost. Require a signed written estimate for any procedure over a set threshold before treatment begins.",
    signals: "Reviewer mentions an unexpected bill or quote-vs-final-bill mismatch.",
  },
  {
    id: "auto-repair-pre-work-photos",
    themes: ["product_quality", "pricing", "service"],
    verticals: ["auto_repair"],
    kind: "remediation",
    title: "Photograph the vehicle and the issue before work begins",
    body: "Auto-repair complaints often hinge on what was wrong before vs. after. Photograph pre-work condition and the specific fault, share with the customer alongside the quote, and attach the photos to the invoice.",
    signals: "Reviewer disputes what was wrong with the vehicle or what was fixed.",
  },
  {
    id: "auto-repair-loaner-policy",
    themes: ["wait_time", "service"],
    verticals: ["auto_repair"],
    kind: "remediation",
    title: "Offer a loaner or ride for jobs running past the promised slot",
    body: "Most wait-time complaints in auto-repair are really transport complaints. Pre-arrange a loaner or rideshare voucher for any job that slips past its quoted finish time.",
    signals: "Reviewer complains about being stranded or losing a day.",
  },

  // ────────────────────────────────────────────────────────────────────
  // Reinforcement Patterns — for positive weeks
  // ────────────────────────────────────────────────────────────────────
  {
    id: "reinforce-named-staff-shoutout",
    themes: ["service", "staff_attitude"],
    kind: "reinforcement",
    title: "Shout out the named staff member in the team channel",
    body: "Reviewers naming a specific team member positively is the highest-signal compliment you'll get. Share the quote (with the Reviewer anonymised if needed) in the team channel and reference it in the next 1-on-1.",
    signals: "Positive Review names a specific staff member.",
  },
  {
    id: "reinforce-replicate-the-good-shift",
    themes: ["service", "wait_time", "cleanliness"],
    kind: "reinforcement",
    title: "Identify what was different about the praised shift",
    body: "Find the shift that prompted the positive Reviews and list what was different: who was on, what was prepped, what wasn't. Replicating a good shift is more reliable than trying to fix a bad one.",
    signals: "Cluster of positive Reviews on a specific day / shift.",
  },
  {
    id: "reinforce-share-on-storefront",
    themes: ["service", "product_quality", "cleanliness", "staff_attitude"],
    kind: "reinforcement",
    title: "Pin the strongest Review of the week to your storefront",
    body: "A single specific, recent positive Review on your Google / Yelp profile is worth more than ten generic five-stars. Pin the strongest one and link to it from your website.",
    signals: "At least one detailed positive Review with a quotable line.",
  },
  {
    id: "reinforce-loyalty-thanks",
    themes: ["pricing", "service"],
    kind: "reinforcement",
    title: "Send a personal thanks to repeat positive Reviewers",
    body: "Reviewers who post a second positive Review months apart are your most valuable advocates. A brief personal thanks (not a discount) signals you noticed and tends to produce a third Review.",
    signals: "Same Reviewer has posted positively before.",
  },
  {
    id: "reinforce-document-the-good",
    themes: ["product_quality", "cleanliness", "accessibility", "other"],
    kind: "reinforcement",
    title: "Document what's working so the team doesn't drift",
    body: "Whatever earned the positive Reviews this week is at risk of quiet erosion. Write a one-paragraph note in the operations log describing the practice, the team, and the period — your future self will thank you.",
    signals: "Two or more positive Reviews praising the same operational detail.",
  },
  {
    id: "reinforce-ask-for-photo",
    themes: ["product_quality"],
    kind: "reinforcement",
    title: "Invite the happy Reviewer to add a photo",
    body: "Positive Reviews with photos sit higher in Source rankings and convert better. Reply to the Reviewer thanking them and gently invite a photo if they took one.",
    signals: "Detailed positive Review with no photo attached.",
  },
  {
    id: "reinforce-loop-back-after-complaint-resolved",
    themes: ["service", "other"],
    kind: "reinforcement",
    title: "Loop back to Reviewers whose past complaint you fixed",
    body: "If a previous-month complaint has been addressed, message that Reviewer with a one-line update. The strongest second Reviews come from Reviewers who saw their feedback taken seriously.",
    signals:
      "A previously-complaining Reviewer is silent this week and the underlying issue is fixed.",
  },
] as const satisfies readonly Pattern[];

/**
 * The Playbook catalogue. Widened to `readonly Pattern[]` so consumers
 * (and tests) see the canonical `Pattern` shape — in particular, the
 * optional `verticals` field is visible on every entry, not narrowed
 * away on entries that happen to omit it.
 *
 * The literal `PLAYBOOK_ENTRIES` array above still enforces compile-time
 * checking of Theme literals via `as const satisfies readonly Pattern[]`.
 */
export const PLAYBOOK: readonly Pattern[] = PLAYBOOK_ENTRIES;
