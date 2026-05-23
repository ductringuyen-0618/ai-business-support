/**
 * Pure handler for `POST /api/webhooks/google/pubsub`, extracted from
 * `route.ts` so tests can drive it without a Next.js request pipeline.
 *
 * Per ADR-0007 fresh Reviews flow via Pub/Sub independently from the
 * backfill path: Google Business Profile pushes a notification at us, we
 * fetch the affected Reviews via `GoogleAdapter`, and enqueue one
 * `ingest_review` job per Review. The downstream pipeline (slice 9) is
 * idempotent on `(source, source_review_id)` so duplicates are safe.
 *
 * Three responsibilities:
 *   1. Verify the shared-secret token (header preferred over query param).
 *   2. Parse the Pub/Sub push envelope + base64-decoded message payload.
 *   3. Idempotency: stamp the messageId in `processed_pubsub_messages` and
 *      no-op on re-delivery (Pub/Sub re-delivers on any non-2xx response).
 *
 * Returns a discriminated union the route renders into HTTP status codes.
 */
import { recordProcessedPubsubMessage as recordProcessedPubsubMessageDefault } from "@/db/queries/processed-pubsub-messages";
import { getSourceConnectionByGoogleLocationId as getSourceConnectionByGoogleLocationIdDefault } from "@/db/queries/source-connections";
import type { SourceConnectionRow } from "@/db/schema";
import { GoogleAdapter } from "@/lib/sources/google-adapter";
import type { SourceAdapter, SourceConnection } from "@/lib/sources/source-adapter";
import { decryptToken } from "@/lib/source-tokens/encrypt";
import { enqueueIngestReview as enqueueIngestReviewDefault } from "@/queue/boss";

export type PubsubOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_request"; reason: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "ok"; messageId: string; enqueued: number }
  | { kind: "no_match"; messageId: string };

export interface PubsubHandlerInput {
  /** Raw `Authorization: ...` header value, if present. */
  authorizationHeader: string | null;
  /** `?token=...` query param, if present. */
  tokenQuery: string | null;
  /** Raw POST body (a JSON string). */
  rawBody: string;
}

export interface PubsubHandlerDeps {
  recordProcessedPubsubMessage: typeof recordProcessedPubsubMessageDefault;
  getSourceConnectionByGoogleLocationId: typeof getSourceConnectionByGoogleLocationIdDefault;
  enqueueIngestReview: typeof enqueueIngestReviewDefault;
  /** Adapter factory — overridden in tests with a deterministic fixture-mode adapter. */
  buildAdapter: () => SourceAdapter;
  /**
   * Resolve the verification token from the environment. Tests inject a
   * fixed value so they don't have to mutate `process.env` between runs.
   */
  expectedToken: () => string | undefined;
}

export const DEFAULT_PUBSUB_DEPS: PubsubHandlerDeps = {
  recordProcessedPubsubMessage: recordProcessedPubsubMessageDefault,
  getSourceConnectionByGoogleLocationId: getSourceConnectionByGoogleLocationIdDefault,
  enqueueIngestReview: enqueueIngestReviewDefault,
  buildAdapter: () => new GoogleAdapter(),
  expectedToken: () => process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN,
};

/**
 * Shape of the JSON payload Google Pub/Sub push delivers. See
 * https://cloud.google.com/pubsub/docs/push for the envelope, and Google
 * Business Profile notification docs for the inner shape after base64-decode:
 * `{ accountId, locationId, notificationType, ...optional review id }`.
 */
export interface PubsubPushEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

export interface GoogleBusinessNotification {
  accountId?: string;
  locationId?: string;
  notificationType?: string;
  /**
   * On `NEW_REVIEW` / `UPDATED_REVIEW` notifications Google sometimes includes
   * a `reviewName` like `accounts/.../locations/.../reviews/<id>`. We use the
   * trailing segment as `source_review_id` if present; otherwise we ask the
   * adapter for the most recent page.
   */
  reviewName?: string;
}

export async function handleGooglePubsub(
  input: PubsubHandlerInput,
  deps: PubsubHandlerDeps = DEFAULT_PUBSUB_DEPS,
): Promise<PubsubOutcome> {
  // 1. Auth — header first, query fallback.
  const expected = deps.expectedToken();
  if (!expected) {
    // Missing server-side config — refuse rather than accept anything. The
    // route logs server-side; we never echo the reason.
    return { kind: "unauthorized" };
  }
  const presented = extractBearer(input.authorizationHeader) ?? input.tokenQuery;
  if (!presented || presented !== expected) {
    return { kind: "unauthorized" };
  }

  // 2. Parse envelope.
  let envelope: PubsubPushEnvelope;
  try {
    envelope = JSON.parse(input.rawBody) as PubsubPushEnvelope;
  } catch {
    return { kind: "bad_request", reason: "invalid_json" };
  }
  const message = envelope.message;
  if (!message?.messageId || !message?.data) {
    return { kind: "bad_request", reason: "missing_message_fields" };
  }

  // 3. Idempotency stamp BEFORE any work.
  const fresh = await deps.recordProcessedPubsubMessage(message.messageId);
  if (!fresh) {
    return { kind: "duplicate", messageId: message.messageId };
  }

  // 4. Decode payload.
  let notification: GoogleBusinessNotification;
  try {
    const decoded = Buffer.from(message.data, "base64").toString("utf8");
    notification = JSON.parse(decoded) as GoogleBusinessNotification;
  } catch {
    // We've already stamped the messageId — bad payloads ack and get dropped
    // rather than spin in retries. Surfaces as 400 to the route.
    return { kind: "bad_request", reason: "invalid_inner_payload" };
  }
  if (!notification.locationId) {
    return { kind: "bad_request", reason: "missing_location_id" };
  }

  // 5. Resolve the connection.
  const connection = await deps.getSourceConnectionByGoogleLocationId(notification.locationId);
  if (!connection || connection.status !== "healthy") {
    // No matching connection (or the connection is errored / disconnected) —
    // Pub/Sub still gets a 204 so it stops re-delivering this messageId.
    return { kind: "no_match", messageId: message.messageId };
  }

  // 6. Fetch the recent Reviews + enqueue one `ingest_review` per Review.
  //    MVP: re-walk a single page of recent Reviews. The downstream
  //    `(source, source_review_id)` idempotency catches duplicates against
  //    whatever the backfill already loaded.
  const adapter = deps.buildAdapter();
  const inMemoryConnection = toInMemoryConnection(connection);
  let enqueued = 0;
  const page = await adapter.ingestPage(inMemoryConnection);
  for (const review of page.reviews) {
    await deps.enqueueIngestReview({
      source_connection_id: connection.id,
      raw_review: review,
    });
    enqueued += 1;
  }

  return { kind: "ok", messageId: message.messageId, enqueued };
}

function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function toInMemoryConnection(row: SourceConnectionRow): SourceConnection {
  return {
    id: row.id,
    source: "google",
    oauth_access_token: row.oauthAccessToken ? safeDecrypt(row.oauthAccessToken) : "",
    oauth_refresh_token: row.oauthRefreshToken ? safeDecrypt(row.oauthRefreshToken) : "",
  };
}

function safeDecrypt(ciphertext: string): string {
  try {
    return decryptToken(ciphertext);
  } catch {
    return "";
  }
}
