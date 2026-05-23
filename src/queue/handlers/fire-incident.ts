/**
 * `fire_incident` job handler (slice 11, issue #12).
 *
 * Algorithm (in order):
 *
 *   1. Load the Review (to derive `business_id` via its source_connection).
 *      If the Review has vanished (Business cancelled mid-flight), bail.
 *   2. Load the Classification. If it's missing OR `is_incident=false`, bail —
 *      a re-classification under prompt v2 may have flipped the verdict.
 *   3. Upsert the `incidents` row keyed on `review_id`. Idempotent — a second
 *      job for the same Review hits the same row.
 *   4. Idempotency check: if this Incident already has Escalations, the
 *      first fire already fanned out — DO NOT fan out again (we'd double-page
 *      the Operators).
 *   5. Load every Operator at the Business + their channel prefs in one
 *      round-trip. For Operators lacking explicit prefs, synthesise a
 *      default "Email always-on" pref so they still get paged (ADR-0009).
 *   6. Call `EscalationRouter.route` to derive `Delivery[]`.
 *   7. For each Delivery: insert an `escalations` row, then enqueue a
 *      `deliver_escalation` job with `startAfter = deliver_at` so quiet-hours
 *      deferral is honoured at the queue layer.
 *
 * Idempotency: steps 3 + 4 are the contract. The router is pure, so re-running
 * on the same Incident with no Escalations yet (e.g. handler crashed between
 * upsertIncident and the fan-out) produces the same Delivery[] every time.
 */
import type { Job } from "pg-boss";

import {
  countEscalationsForIncident as countEscalationsForIncidentDefault,
  insertEscalation as insertEscalationDefault,
} from "@/db/queries/escalations";
import { upsertIncidentByReviewId as upsertIncidentByReviewIdDefault } from "@/db/queries/incidents";
import {
  findOperatorsWithPrefsByBusiness as findOperatorsWithPrefsByBusinessDefault,
  type OperatorWithPrefs,
} from "@/db/queries/operator-channel-prefs";
import { findClassificationByReviewId as findClassificationByReviewIdDefault } from "@/db/queries/classifications";
import { findReviewWithBusinessId as findReviewWithBusinessIdDefault } from "@/db/queries/reviews";
import {
  route as routeDefault,
  type Channel,
  type Delivery,
  type Incident,
  type OperatorChannelPref,
} from "@/lib/escalation";

import {
  type FireIncidentPayload,
  enqueueDeliverEscalation as enqueueDeliverEscalationDefault,
} from "../boss";

export { FIRE_INCIDENT_JOB, type FireIncidentPayload } from "../boss";

/**
 * Dependency-injection seam. Mirrors `ingest-review.ts` so the two handlers
 * feel the same to test.
 */
export interface FireIncidentDeps {
  findReviewWithBusinessId: typeof findReviewWithBusinessIdDefault;
  findClassificationByReviewId: typeof findClassificationByReviewIdDefault;
  upsertIncidentByReviewId: typeof upsertIncidentByReviewIdDefault;
  countEscalationsForIncident: typeof countEscalationsForIncidentDefault;
  findOperatorsWithPrefsByBusiness: typeof findOperatorsWithPrefsByBusinessDefault;
  insertEscalation: typeof insertEscalationDefault;
  enqueueDeliverEscalation: typeof enqueueDeliverEscalationDefault;
  route: typeof routeDefault;
  /** Time source — injectable so tests can pin `now` and assert deferral math. */
  now: () => Date;
}

export const DEFAULT_FIRE_INCIDENT_DEPS: FireIncidentDeps = {
  findReviewWithBusinessId: findReviewWithBusinessIdDefault,
  findClassificationByReviewId: findClassificationByReviewIdDefault,
  upsertIncidentByReviewId: upsertIncidentByReviewIdDefault,
  countEscalationsForIncident: countEscalationsForIncidentDefault,
  findOperatorsWithPrefsByBusiness: findOperatorsWithPrefsByBusinessDefault,
  insertEscalation: insertEscalationDefault,
  enqueueDeliverEscalation: enqueueDeliverEscalationDefault,
  route: routeDefault,
  now: () => new Date(),
};

export async function handleFireIncident(
  jobs: Job<FireIncidentPayload>[],
  deps: FireIncidentDeps = DEFAULT_FIRE_INCIDENT_DEPS,
): Promise<void> {
  for (const job of jobs) {
    await processOne(job, deps);
  }
}

async function processOne(job: Job<FireIncidentPayload>, deps: FireIncidentDeps): Promise<void> {
  const { review_id: reviewId } = job.data;

  // 1. Load the Review (+ business_id). Vanished → bail quietly.
  const review = await deps.findReviewWithBusinessId(reviewId);
  if (!review) {
    console.warn(`[fire_incident] review ${reviewId} not found; abandoning job ${job.id}`);
    return;
  }

  // 2. Load the Classification. Missing or not-incident → bail. A
  // re-classification path may have flipped `is_incident` between the
  // enqueue and the dispatch; trusting the DB is the safe move.
  const classification = await deps.findClassificationByReviewId(reviewId);
  if (!classification || !classification.isIncident || !classification.severity) {
    console.warn(
      `[fire_incident] review ${reviewId} no longer flagged as incident; abandoning job ${job.id}`,
    );
    return;
  }

  // 3. Upsert the Incident. Severity is denormalised from the Classification
  // at fire-time.
  const incident = await deps.upsertIncidentByReviewId({
    reviewId,
    businessId: review.businessId,
    severity: classification.severity,
  });

  // 4. Idempotency check — if Escalations already exist for this Incident,
  // the first fire already did the fan-out. A second `fire_incident` job is
  // a re-delivery; we must NOT page Operators twice.
  const existingCount = await deps.countEscalationsForIncident(incident.id);
  if (existingCount > 0) {
    console.log(
      `[fire_incident] incident ${incident.id} already has ${existingCount} escalations; skipping fan-out`,
    );
    return;
  }

  // 5. Load Operators + prefs. Synthesise default Email-on prefs for any
  // Operator with no rows yet — Email is "always available" per ADR-0009.
  const operatorsWithPrefs = await deps.findOperatorsWithPrefsByBusiness(review.businessId);
  if (operatorsWithPrefs.length === 0) {
    console.warn(
      `[fire_incident] incident ${incident.id} has no active operators to page; created Incident but no Escalations`,
    );
    return;
  }

  const operators = operatorsWithPrefs.map((o) => ({ id: o.operatorId }));
  const prefs: OperatorChannelPref[] = buildPrefs(operatorsWithPrefs);

  // 6. Pure-function fan-out.
  const incidentForRouter: Incident = {
    id: incident.id,
    severity: classification.severity as "low" | "medium" | "high",
  };
  const deliveries: Delivery[] = deps.route({
    incident: incidentForRouter,
    operators,
    prefs,
    now: deps.now(),
  });

  // 7. Persist Escalations + enqueue Delivery jobs.
  for (const delivery of deliveries) {
    const escalation = await deps.insertEscalation({
      incidentId: incident.id,
      operatorId: delivery.operator_id,
      channel: delivery.channel,
    });
    await deps.enqueueDeliverEscalation(
      { escalation_id: escalation.id },
      { startAfter: delivery.deliver_at },
    );
  }
}

/**
 * Build the `OperatorChannelPref[]` array the router consumes. For Operators
 * with no rows yet, we synthesise an Email-on / SMS-off default — Email is
 * "always available" per ADR-0009, and SMS opts in via the settings UI.
 */
function buildPrefs(operatorsWithPrefs: OperatorWithPrefs[]): OperatorChannelPref[] {
  const out: OperatorChannelPref[] = [];
  for (const op of operatorsWithPrefs) {
    const haveChannels = new Set<Channel>();
    for (const p of op.prefs) {
      haveChannels.add(p.channel);
      out.push({
        operator_id: op.operatorId,
        channel: p.channel,
        enabled: p.enabled,
        quiet_hours_start: p.quietHoursStart,
        quiet_hours_end: p.quietHoursEnd,
        timezone: p.timezone,
      });
    }
    if (!haveChannels.has("email")) {
      out.push({
        operator_id: op.operatorId,
        channel: "email",
        enabled: true,
        quiet_hours_start: null,
        quiet_hours_end: null,
        timezone: "UTC",
      });
    }
    // SMS default is `enabled = false` per ADR-0009 — we do NOT synthesise a
    // pref row for it, because the router would route to a row with no
    // verified phone number.
  }
  return out;
}
