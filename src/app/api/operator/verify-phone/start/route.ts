/**
 * `POST /api/operator/verify-phone/start`
 *
 * Begin the SMS verification round-trip for the calling Operator (slice 11):
 *   1. Generate a 6-digit code.
 *   2. Persist its SHA-256 + the candidate phone number to
 *      `phone_verifications` (PK on operator_id so a second click invalidates
 *      the previous code).
 *   3. SMS the plaintext code via Twilio.
 *
 * Body: `{ phoneE164: string }` — E.164 format ("+15555550123").
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { upsertPendingVerification } from "@/db/queries/phone-verifications";
import {
  VERIFICATION_CODE_TTL_SECONDS,
  generateVerificationCode,
  hashVerificationCode,
  isPlausibleE164,
} from "@/lib/phone-verify";
import { sendSms } from "@/lib/sms/twilio";

export const runtime = "nodejs";

const bodySchema = z.object({
  phoneE164: z.string().min(1),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new NextResponse(null, { status: 401 });

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) return new NextResponse(null, { status: 403 });

  let phoneE164: string;
  try {
    const json = await request.json();
    phoneE164 = bodySchema.parse(json).phoneE164;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!isPlausibleE164(phoneE164)) {
    return NextResponse.json({ error: "phoneE164 must be in E.164 format" }, { status: 400 });
  }

  const code = generateVerificationCode();
  const codeHash = hashVerificationCode(code);
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_SECONDS * 1000);

  await upsertPendingVerification({
    operatorId: membership.operator.id,
    phoneE164,
    codeHash,
    expiresAt,
  });

  // We send AFTER the DB write so a sent-but-unstored situation is
  // impossible (which would leave Operators with a code they can't use).
  await sendSms({
    to: phoneE164,
    body: `Your ai-business-support verification code is ${code}. It expires in ${
      VERIFICATION_CODE_TTL_SECONDS / 60
    } minutes.`,
  });

  return NextResponse.json({ ok: true });
}
