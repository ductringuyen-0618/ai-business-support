# Deletion Request runbook

A Reviewer has asked us to delete their data. This runbook is the end-to-end
recipe for honouring the request.

Background: see [CONTEXT.md "Deletion Request"](../../CONTEXT.md) and
[ADR-0006](../adr/0006-pii-redact-before-llm-full-storage.md). The TL;DR is
that we null `reviewer_display_name` and `review_text` on the matching Review
rows but keep the row itself so trend reporting (themes, severity, timestamp)
still works. The `redacted_text` column already contains a Reviewer-name-free
copy of the text — that's what the LLM ever saw at ingest time, so leaving it
in place is consistent with ADR-0006.

## SLA

**We commit to honouring Deletion Requests within 7 days of receipt** (PRD #1).
Most should be done same-day; the 7-day window is a hard ceiling that absorbs
weekends, holidays, and verification back-and-forth.

## 1. Receiving the request

For MVP, Deletion Requests come in via email to `support@<our-domain>`. There
is no in-app form yet — that's a follow-up once volume justifies it.

A real request looks like one of:

- "Please delete my review of \<business name\>." (no specific Review IDs)
- "Delete this review: \<google-maps-link\>" (one specific Review)

If the request mentions multiple Businesses or platforms (Yelp, Facebook),
treat each Business as a separate ticket; this workflow only acts on one
Business at a time.

## 2. Verifying the requester

We don't have a relationship with Reviewers (CONTEXT.md), so we can't
authenticate them via a login. Verify identity by reply-back:

1. Reply to the original email asking the Reviewer to confirm:
   - The exact display name as it appears on the Review (case-sensitive).
   - The Business name and approximate date of the Review.
   - One of:
     - A photo of any in-store correspondence (receipt, business card with a
       handwritten note) that matches the Reviewer's claimed identity, OR
     - The original email address used to leave the Review on the Source (we
       can cross-check against the Source's public display).

2. If anything looks off, escalate to the team channel before proceeding —
   we'd rather take an extra day than null out the wrong Reviewer's rows.

3. Once verified, open a support ticket (or reuse the email thread) and
   record the verification artefacts. The ticket is the audit trail for this
   request — see step 5.

## 3. Running the script

The deletion endpoint lives at `POST /api/internal/deletion-request` and is
admin-gated. Day-to-day you'll invoke it via the CLI wrapper:

```bash
# By display name (most common — Reviewer asked us to delete all their
# Reviews at a Business):
pnpm deletion-request \
  --business-id 11111111-1111-1111-1111-111111111111 \
  --reviewer-name "Jane D"

# By specific Source-side Review IDs (Reviewer asked us to delete THIS one):
pnpm deletion-request \
  --business-id 11111111-1111-1111-1111-111111111111 \
  --review-ids "ChIJ-google-id-1,ChIJ-google-id-2"

# Against a non-local environment:
pnpm deletion-request --base-url https://app.example.com ...
```

The script prompts:

```
About to honour a Deletion Request:
  business_id : 11111111-1111-1111-1111-111111111111
  reviewer    : "Jane D"
  target      : http://localhost:3000

This will NULL `review_text` and `reviewer_display_name` on the matching Reviews.
Classifications stay intact (trend reporting is preserved).
This action cannot be undone.

Type YES to continue:
```

Type exactly `YES` (case-sensitive) to proceed. Anything else aborts.

### Required env

The CLI reads these from the shell:

- `INTERNAL_ADMIN_KEY` — must match the value the deployed endpoint has in
  its env. See `.env.example` for the variable; the production value is in
  1Password under "ai-business-support / INTERNAL_ADMIN_KEY".
- `ADMIN_USER_IDS` — only consumed by the endpoint itself, not the CLI; the
  CLI authenticates via the header key path.

### Expected output

```
Affected rows: 3
Business      : 11111111-1111-1111-1111-111111111111
Matched review IDs:
  aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
  cccccccc-cccc-cccc-cccc-cccccccccccc

Paste the above IDs into the support ticket as the audit record.
```

If `Affected rows: 0`:

- Double-check the `--business-id` (most common cause: wrong tenant).
- Double-check the `--reviewer-name` casing (the match is case-sensitive).
- The Reviewer may have already had their rows nulled by a prior request;
  check the support ticket history.

If the script errors with `403`, the `INTERNAL_ADMIN_KEY` is missing or
wrong. If it errors with `400`, you provided both `--reviewer-name` and
`--review-ids` (or neither) — the endpoint enforces XOR.

### Idempotency

Re-running on the same input is safe but the script still reports a non-zero
`Affected rows:` count, because the SQL UPDATE re-matches the rows and sets
their already-null columns to null again. If you see the same count on a
second run, that's expected — it does NOT mean more data was changed.

## 4. Communicating back

Template reply to the Reviewer once the rows are nulled:

> Hi \<name\>,
>
> Thanks for getting in touch. I've processed your deletion request for
> \<business name\>: \<N\> Review(s) attributed to you have had your display
> name and Review text removed from our records.
>
> We do retain the star rating, the date, and the topical categorisation
> ("themes") for those Reviews so we can keep producing trend reports for
> the Business, but those fields contain no information about you
> personally. If you'd like those retained fields removed as well, reply
> to this email and we'll arrange a full row-level delete on a
> case-by-case basis.
>
> Please note: this only affects our copy of your Review(s). The original
> still lives on \<Source\> (e.g. Google) and you would need to remove it
> there separately if you wish.
>
> If you have any questions, just reply to this email.
>
> Best,
> \<your name\>

Adjust `<N>` to the `Affected rows:` count the script reported. If the count
was 0, do NOT send the above — first investigate (see "If `Affected rows:
0`" above) and follow up with the Reviewer once you understand why.

## 5. Audit trail

Paste into the support ticket:

- The script invocation (command + flags).
- The script's full output (the `Matched review IDs:` block in particular).
- A timestamp.
- The verification artefacts from step 2.

That ticket is the audit trail. We do NOT currently keep a permanent
server-side log of who ran the deletion (no `deletion_requests` table, no
admin-action audit log). ADR-0006 accepts this for MVP — the nulled DB rows
plus the support ticket form the audit pair. If we ever need a queryable
admin audit log (e.g. for a SOC 2 or DPA), that's a follow-up:

> **Follow-up**: add a `deletion_requests` table that logs `(actor_clerk_id,
business_id, target_reviewer_display_name | source_review_ids[],
matched_review_ids, executed_at)` on every script run. Wire it into the
> endpoint behind a feature flag so MVP behaviour is unchanged.

## Known limitations

- **No self-service portal**: Reviewers email us; we don't expose a "delete
  my data" form. Acceptable at MVP volumes per ADR-0006.
- **No undo**: the null is irrevocable from our side. Recovery would require
  re-ingesting the Review from the Source.
- **Case-sensitive display-name match**: `"Jane D"` and `"jane d"` are
  different inputs. If the Reviewer's displayed name has unusual casing,
  prefer `--review-ids` over `--reviewer-name`.
- **One Business per invocation**: if the Reviewer requests deletion across
  multiple Businesses, run the script once per Business.
