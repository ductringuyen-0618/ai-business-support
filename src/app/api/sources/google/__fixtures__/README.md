# Google OAuth callback fixtures (slice 8)

Recorded responses from Google's token endpoint
(`https://oauth2.googleapis.com/token`) used by `oauth-callback.test.ts`.

We deliberately do not record against the live Google API in tests — the
endpoint requires a valid `client_secret` and a freshly-issued (one-shot)
authorization code, both of which are awkward to keep current in a repo.
Instead the integration tests stub `fetch` with these fixtures via the
`fetchImpl` injection point on `exchangeGoogleAuthCode`.

## Files

- `token-success.json` — shape Google returns on a healthy
  `grant_type=authorization_code` exchange. The `access_token` /
  `refresh_token` are obviously not real, but the schema matches what
  `GoogleTokenResponse` decodes (access_token, refresh_token, expires_in,
  scope, token_type).
- `token-error.json` — shape Google returns on `invalid_grant` (the most
  common cause of token-exchange failure: the auth code was already used or
  expired). The handler maps any non-2xx body to a `GoogleOAuthError` which
  surfaces as the `google_exchange_failed` flash on the dashboard.
