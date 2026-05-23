/**
 * `POST /api/operator/verify-phone/confirm`
 *
 * Complete the SMS verification round-trip:
 *   1. Look up the pending verification by operator_id.
 *   2. Confirm it has not expired.
 *   3. Compare the SHA-256 of the submitted code with the stored hash in
 *      constant time.
 *   4. On match, enable SMS on `operator_channel_prefs` with the verified
 *      number and delete the pending row.
 *   5. On mismatch, return 400 — we do NOT delete the row so a fat-fingered
 *      digit doesn't burn the whole round-trip.
 *
 * Body: `{ code: string }` — the 6-digit code as received by SMS.
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { enableSmsWithVerifiedNumber } from "@/db/queries/operator-channel-prefs";
import {
  deletePendingVerification,
  findPendingVerification,
} from "@/db/queries/phone-verifications";
import { constantTimeEquals, hashVerificationCode } from "@/lib/phone-verify";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new NextResponse(null, { status: 401 });

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) return new NextResponse(null, { status: 403 });

  let code: string;
  try {
    const json = await request.json();
    code = bodySchema.parse(json).code;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const pending = await findPendingVerification(membership.operator.id);
  if (!pending) {
    return NextResponse.json({ error: "no pending verification" }, { status: 400 });
  }
  if (pending.expiresAt < new Date()) {
    // Expired codes are deleted defensively so a stale row doesn't shadow a
    // future start-verification call.
    await deletePendingVerification(membership.operator.id);
    return NextResponse.json({ error: "verification code expired" }, { status: 400 });
  }
  const submittedHash = hashVerificationCode(code);
  if (!constantTimeEquals(submittedHash, pending.codeHash)) {
    return NextResponse.json({ error: "verification code mismatch" }, { status: 400 });
  }

  await enableSmsWithVerifiedNumber({
    operatorId: membership.operator.id,
    phoneE164: pending.phoneE164,
  });
  await deletePendingVerification(membership.operator.id);

  return NextResponse.json({ ok: true, phoneE164: pending.phoneE164 });
}
