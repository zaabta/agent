# Atomic per-user connection error

The SitePilot `POST /api/agent/custom-tools/connections/{profile}/connect/atomic` contract accepts `{ "email": string, "password": string }`. It calls Atomic `POST /api/v1/auth/login`, expects `accessToken` and `expiresIn` in JSON, and captures the `refreshToken` HttpOnly `Set-Cookie` header.

In the current SitePilot source, invalid Atomic input returns `INVALID_ATOMIC_CREDENTIALS`; rejected login returns `401 ATOMIC_CREDENTIALS_INVALID`; malformed or incomplete Atomic responses return `502 ATOMIC_CONNECTION_FAILED`. `INVALID_CONNECTION_CREDENTIAL` is emitted by generic OAuth token submission and shared connection credential validation, not by the Atomic per-user route. If it appears on the Atomic route, check that the request reaches a SitePilot process built from the current source and that a proxy is not routing it to a stale/different backend.

The database profile must be enabled with `authStrategy: ATOMIC_COOKIE_REFRESH`; `PER_USER` is the authentication scope on the tool that references the profile. The backend requires a valid `LLM_CREDENTIALS_ENCRYPTION_KEY` and stores resulting access and refresh values encrypted. Do not include credential values in diagnostics.
