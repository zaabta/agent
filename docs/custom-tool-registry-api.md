# Custom Tool Registry API

This documents the implementation in `src/agent/custom-tools.controller.ts`, `src/agent/backend-tools.ts`, `src/agent/custom-tool-credential-adapters.ts`, and `prisma/schema.prisma`. All routes require the standard bearer-authenticated `ApiAuthGuard` and are rooted at `/api/agent/custom-tools`.

## Authorization

Connection Profile CRUD, Custom Tool CRUD, testing/history, and shared credential operations require the configured installation owner (`INSTALLATION_OWNER_USER_ID`) via `InstallationOwnerOnly`. Non-owner requests receive `403 INSTALLATION_OWNER_REQUIRED`; an unset owner receives `503 INSTALLATION_OWNER_NOT_CONFIGURED`. `GET /connections/available` is available to any authenticated user and returns only enabled per-user integration metadata.

Per-user connect, status, and disconnect are available to any signed-in principal and scope credentials to that principal's tenant, user, and profile. Atomic login is rate-limited through the existing auth login limiter. HTTPS is required except for an explicitly database-approved development loopback profile accessed from a loopback peer. Runtime does not fall back between per-user and shared credentials.

## Connection Profiles

Profiles are tenant-owned records. IDs match `^[a-z][a-z0-9_-]{0,63}$`; `displayName` is required (1–120 characters); `baseUrl` is validated HTTPS by default. `allowLocalHttp` (default `false`) is an owner-managed database policy that permits HTTP only for `localhost`, `127.0.0.0/8`, or `::1` in non-production environments; every resolved address must remain loopback. Production ignores this flag. It never permits other private addresses. `authStrategy` is one of `NONE`, `SHARED`, `ATOMIC_COOKIE_REFRESH`, `OAUTH2_REFRESH` (default `NONE`). `OAUTH2_REFRESH` requires a valid `tokenUrl` and non-empty `clientId` (max 512 characters); the same endpoint policy applies to the token URL. `enabled` defaults true.

Authentication scope is stored per Custom Tool in the existing registry (`NONE`, `SHARED`, or `PER_USER`), so tools sharing a profile can choose their own supported scope without duplicating profile records.

| Method/path | Access | Success response |
| --- | --- | --- |
| `GET /connections` | Owner | Profile DTO array, includes disabled records |
| `GET /connections/encryption-status` | Owner | `{ "available": boolean }`; reports only whether a valid backend encryption key is configured |
| `GET /connections/available` | Any authenticated user | Safe enabled per-user integration metadata array |
| `POST /connections` | Owner | Created profile DTO |
| `GET /connections/{profile}` | Owner | Profile DTO |
| `PUT /connections/{profile}` | Owner | Updated profile DTO; body is partial |
| `DELETE /connections/{profile}` | Owner | `{ "id": string, "deleted": true }` |

Create body fields: `{ id, displayName, baseUrl, allowLocalHttp?, authStrategy?, tokenUrl?, clientId? }`; the service ignores `enabled` on create, so created profiles use the database default `true`. Update fields are `{ displayName?, baseUrl?, allowLocalHttp?, authStrategy?, tokenUrl?, clientId?, enabled? }`; all are optional. Omitted values retain their existing value; null is not a documented clearing operation.

Profile response DTO:

```json
{
  "id": "atomic_main",
  "displayName": "Atomic",
  "baseUrl": "https://atomic.example.com/",
  "allowLocalHttp": false,
  "tokenUrl": null,
  "clientId": null,
  "host": "atomic.example.com",
  "trustedInternal": false,
  "authStrategy": "ATOMIC_COOKIE_REFRESH",
  "enabled": true,
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

`allowLocalHttp` is returned only from owner-managed profile routes. It is an administrative setting; production still rejects HTTP.

Every profile response now includes a server-computed `authenticationCapabilities` object. It appears consistently in list, detail, create, and update responses:

```json
"authenticationCapabilities": {
  "atomicPerUserLogin": true,
  "oauth2Refresh": false
}
```

`atomicPerUserLogin` is true when the profile is enabled, uses `ATOMIC_COOKIE_REFRESH`, and its database-stored URL passes the endpoint policy. The profile ID and base URL origin themselves identify the approved login target; there are no integration-specific environment allowlists. This capability means Atomic `EMAIL_PASSWORD` login for `PER_USER` connections: the backend submits email/password and stores the resulting JWT access token plus rotating HttpOnly refresh cookie. Atomic does not use OAuth/OAuth2 authorization or consent flows. `oauth2Refresh` is a separate generic capability for an enabled `OAUTH2_REFRESH` profile with a valid token URL and client ID. Safe user metadata from `/connections/available` contains only ID, display name, and capabilities. Profile list/detail routes remain owner-only.

Available integration DTO: `{ id, displayName, authenticationCapabilities: { atomicPerUserLogin, oauth2Refresh } }`. It omits URLs, client IDs, local endpoint settings, and credentials.

Delete is hard deletion only when no non-archived profile-backed tool and no credential references the profile; otherwise `409 CONNECTION_PROFILE_IN_USE`.

## Shared credentials

Shared credentials use wildcard tenant/user IDs and are owner-managed. Authentication endpoints resolve an enabled, tenant-owned database profile and apply its stored endpoint policy.

| Method/path | Access | Success response |
| --- | --- | --- |
| `GET /connections/{profile}/credentials` | Owner | Array of credential metadata |
| `POST /connections/{profile}/credentials/login` | Owner | Upserted credential metadata |

Login body: `{ "name": string, "email": string, "password": string }`. Name follows the profile ID pattern, email is at most 254 characters, password at most 1024. Backend performs Atomic login, encrypts tokens, and returns no password or token.

Metadata DTO: `{ id, profileId, name, authStrategy, tokenExpiresAt, lastRefreshedAt, credentialVersion, authStatus }`. List is sorted by name. No shared-credential delete endpoint exists; profile deletion is blocked while credentials exist.

## Per-user connections

| Method/path | Access | Request | Success response |
| --- | --- | --- | --- |
| `POST /connections/{profile}/connect` | Signed-in user | `{ accessToken, refreshToken, expiresIn }` | Status DTO |
| `POST /connections/{profile}/connect/atomic` | Signed-in user, HTTPS; development loopback HTTP only when profile `allowLocalHttp` is true and request peer is loopback | `{ email, password }` | Status DTO |
| `GET /connections/{profile}/status` | Signed-in user | None | Status DTO |
| `DELETE /connections/{profile}/disconnect` | Signed-in user | None | Status DTO after deletion |

Status DTO: `{ connected, authStatus, tokenExpiresAt, lastRefreshedAt }`. Missing row returns `{ connected: false, authStatus: "DISCONNECTED", tokenExpiresAt: null, lastRefreshedAt: null }`. There is no separate proactive expired state; refresh and use can change status or fail.

Generic OAuth connect accepts enabled `OAUTH2_REFRESH` profiles; access/refresh token strings must each be 8–8192 characters without control chars and `expiresIn` must be integer 1–86400. Atomic connect is a distinct email/password flow and requires an enabled `ATOMIC_COOKIE_REFRESH` profile whose database-stored base URL passes endpoint validation. It sends credentials only to that profile origin's `/api/v1/auth/login`; the returned JWT access token and rotating HttpOnly `refreshToken` cookie are encrypted and stored. Password is request-only. No OAuth authorization or consent flow is used for Atomic.

Atomic errors: `400 AUTH_ENDPOINT_NOT_ALLOWED`, `400 ATOMIC_ORIGIN_NOT_APPROVED`, `400 INVALID_ATOMIC_CREDENTIALS`, `403 HTTPS_REQUIRED`, `401 ATOMIC_CREDENTIALS_INVALID`, `502 ATOMIC_CONNECTION_FAILED`; login rate limiting returns 429. Other validation includes `400 PER_USER_AUTH_UNAVAILABLE` and `400 INVALID_CONNECTION_CREDENTIAL`.

## Custom Tools

Registry operations are owner-only. Built-in Agent tools are excluded. Tools are disabled on create and execute HTTP GET only. Unknown/archived IDs return `404 CUSTOM_TOOL_NOT_FOUND`.

| Method/path | Request | Success response |
| --- | --- | --- |
| `GET /` | None | Newest-first tool DTO array |
| `POST /` | Create DTO | Tool DTO, `enabled: false` |
| `GET /{id}` | None | Tool DTO |
| `PUT /{id}` | Update DTO | Tool DTO |
| `PATCH /{id}/enabled` | `{ "enabled": boolean }` | Updated tool DTO |
| `DELETE /{id}` | None | `{ "id": uuid, "archived": true }` |
| `POST /{id}/test` | `{ "sampleInput": object }` | Test result DTO |
| `GET /{id}/executions?limit=50&offset=0` | Optional pagination | Execution array |

Create/update DTO fields: `name`, `displayName?`, `description`, `endpoint?`, `parameters?`, `connectionProfile?`, `path?`, `queryMappings?`, `inputSchema?`, `outputSchema?`, `auth?`, `connectionCredentialId?`, `allowedUserIds?`, `authScope?`, `timeoutMs?`, `maxResponseBytes?`. `auth` is `{ headerName: "Authorization" | "X-API-Key", prefix?: string, secret?: string }` or null. Secret is write-only.

Parameter DTO: `{ name, type, required?, description?, queryParameter? }`; max 20, types `string|number|integer|boolean`, names match `^[A-Za-z][A-Za-z0-9_]{0,63}$`, description max 300, query parameter max 80. Use parameters OR advanced `inputSchema` plus `queryMappings`, not both. Schemas are restricted JSON Schema objects. `timeoutMs` range is 500–30000; `maxResponseBytes` 256–1000000. Defaults are 10000 and 65536.

Use a full HTTPS `endpoint` alone or `connectionProfile` plus fixed relative `path`. Endpoint and profile/path fields cannot be combined. Profile-backed target must resolve to an enabled tenant profile. Endpoint safety is rechecked at registration, enable, and execution; redirects are rejected and time/response size bounded.

Tool response fields: `id`, `name`, `displayName`, `description`, `type`, `endpoint`, `parameters`, `connectionProfile`, `path`, `queryMappings`, `inputSchema`, `outputSchema`, `authHeaderName`, `authPrefix`, `authScope`, `connectionCredentialId`, `allowedUserIds`, `authSecretRef`, `authSecretConfigured`, `enabled`, `effectClassification`, `timeoutMs`, `maxResponseBytes`, `configurationVersion`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`. No secret or ciphertext is returned. Profile-backed `endpoint` may be null when its profile cannot resolve.

### Authentication scopes

`authScope` is `NONE`, `SHARED`, or `PER_USER`. If omitted, it defaults to `SHARED` when `auth` or `connectionCredentialId` is supplied, else `NONE`.

- `NONE`: rejects `auth` and `connectionCredentialId`.
- `SHARED`: supports static `auth` or a shared `connectionCredentialId`. Static credentials are encrypted; on update, omit `auth` to preserve it, send header/prefix without secret to keep the saved secret, send a new secret to rotate, or set null to remove. Shared connection credentials must be ACTIVE, have wildcard tenant/user, match the tool profile, and require non-empty `allowedUserIds`; runtime restricts use to those UUIDs. Static shared secrets do not currently require `allowedUserIds`.
- `PER_USER`: requires a profile/path target; rejects direct endpoint, `auth`, and `connectionCredentialId`. Runtime uses only the current user's encrypted session, with no shared fallback.

Saved connection credential and static `auth` conflict (`STATIC_AND_SHARED_AUTH_CONFLICT`). Changes increment `configurationVersion`.

Tool create/update validation accepts `PER_USER` only with a valid existing tenant-owned enabled profile that supports the selected connection type: approved Atomic email/password profiles with `atomicPerUserLogin: true`, or configured generic OAuth profiles with `oauth2Refresh: true`. Unapproved, disabled, cross-tenant, unsupported, or incomplete profiles are rejected (`CONNECTION_PROFILE_UNAVAILABLE` or `PER_USER_AUTH_UNAVAILABLE`). Runtime uses only the current user's credential and never falls back to shared credentials.

### Test and execution responses

Test response is `{ success, durationMs, errorCategory, sampleOutput? }`; failures return safe `errorCategory` and omit sample output. Tests may run while disabled. Execution fields are `id`, `toolId`, `toolVersion`, `logicalRequestId`, `arguments`, `conversationId`, `userId`, `latencyMs`, `success`, `errorCategory`, `isTest`, `createdAt`. The implementation currently returns `arguments` although the route summary describes metadata-only history; clients should treat it as potentially sensitive. Test output is bounded and sensitive-looking keys redacted.

Archive disables the tool, removes its static secret, increments its configuration version, and preserves history. Enablement revalidates target policy.

## Errors

Implemented validation errors return 400, including `INVALID_CONNECTION_PROFILE`, `INVALID_CONNECTION_PROFILE_ID`, `INVALID_CONNECTION_PROFILE_NAME`, `INVALID_CONNECTION_PROFILE_AUTH`, `INVALID_LOCAL_HTTP_POLICY`, `INVALID_OAUTH_CONFIGURATION`, `INVALID_ENDPOINT`, `INVALID_ENABLED_VALUE`, `INVALID_AUTH_SCOPE`, `AUTH_SCOPE_CONFIGURATION_MISMATCH`, `INVALID_TOOL_NAME`, `INVALID_DISPLAY_NAME`, `INVALID_TOOL_DESCRIPTION`, `INVALID_ENDPOINT_CONFIGURATION`, `CONNECTION_PROFILE_UNAVAILABLE`, `INVALID_PATH`, `INVALID_PARAMETERS`, `INVALID_PARAMETER`, `INVALID_QUERY_PARAMETER`, `INVALID_PARAMETER_CONFIGURATION`, `INVALID_SCHEMA`, `INVALID_QUERY_MAPPINGS`, `INVALID_AUTH_CONFIGURATION`, `INVALID_TIMEOUT`, and `INVALID_RESPONSE_LIMIT`.

Other statuses include `401 ATOMIC_CREDENTIALS_INVALID`; `403 INSTALLATION_OWNER_REQUIRED` or `HTTPS_REQUIRED`; `404 CONNECTION_PROFILE_NOT_FOUND` or `CUSTOM_TOOL_NOT_FOUND`; `409 CONNECTION_PROFILE_EXISTS`, `CONNECTION_PROFILE_IN_USE`, or `TOOL_NAME_EXISTS`; `429` auth rate limit; `502 ATOMIC_CONNECTION_FAILED`; and `503 INSTALLATION_OWNER_NOT_CONFIGURED` or `CUSTOM_TOOL_ENCRYPTION_NOT_CONFIGURED`. Runtime tool-test failures are returned in `errorCategory`, not thrown as HTTP errors. Network failures are transport errors, with no separate network DTO.

## Atomic security configuration

Atomic login and refresh use the enabled tenant-owned `ATOMIC_COOKIE_REFRESH` database profile. Login posts to `/api/v1/auth/login`; refresh uses `/api/v1/auth/refresh` and the saved refresh cookie. Non-production HTTP requires the profile's `allowLocalHttp` approval and loopback-only DNS results; production always requires HTTPS. If TLS terminates at a proxy, configure `TRUST_PROXY_HOPS` correctly and ensure the proxy overwrites forwarded-protocol headers.

Credentials/tokens are AES-256-GCM encrypted at rest with `LLM_CREDENTIALS_ENCRYPTION_KEY`, shared with encrypted LLM provider credentials. This deployment-level secret is not stored in PostgreSQL. For local development, generate it once with `openssl rand -base64 32`, save it only in the backend's ignored `.env` file, and restrict that file to the local account (for example `chmod 600 .env`). Keep the same value across restarts and backups; changing it makes existing encrypted credentials unreadable unless they are re-encrypted first. Production should provide the same variable through its secret manager. Never put this key in frontend configuration. The owner-only encryption-status endpoint returns only `{ "available": true|false }`. Passwords are request-only; access tokens, refresh tokens, cookies, secrets, and ciphertext are not returned in DTOs.
