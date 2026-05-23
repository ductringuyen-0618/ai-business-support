# Test-mode shims

In-process mocks for external SDKs (Anthropic, Resend, Twilio) that activate when `E2E_TEST_MODE=1`.

The production `getDefaultClient()` functions in `src/lib/classifier/anthropic-client.ts`, `src/lib/email/resend.ts`, and `src/lib/sms/twilio.ts` check that env var and lazily `require()` the matching module here. When the var is unset (i.e. real prod / dev) these files are not loaded at all — Next tree-shakes the unreachable branch.

The mocks publish their call log to a JSON-lines file referenced by `E2E_MOCK_RECORDER_PATH`. The Playwright spec process reads that file to assert on shape (subject lines, recipients, etc.) without needing a network round-trip.

See `tests/e2e/setup/global-setup.ts` for the wiring and `tests/e2e/happy-path.spec.ts` for the assertions.
