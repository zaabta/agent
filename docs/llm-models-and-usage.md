# Runtime LLM models and token usage

All routes require a JWT bearer token. Global provider/model/runtime changes require the configured installation owner (`INSTALLATION_OWNER_USER_ID`); usage reports are scoped to the authenticated user. In local development, Swagger is available at `/api/docs`.

## Frontend Settings page contract

- **Current model:** read `GET /active-model` and show the exact provider, model ID, and fallback. Refresh the displayed selection after `PUT /active-model` succeeds.
- **Local AI (Ollama):** call `POST /models/sync`, then `GET /models`; show only available, compatible Ollama entries as selectable local models. Keep the Ollama endpoint server-side; the browser must not choose an endpoint.
- **Cloud AI:** show `GET /providers` configured flags for Gemini (`google`), OpenRouter, and OpenAI. Save keys with `PUT /providers/{provider}/credential`, test with `POST /providers/{provider}/test`, and never persist or display the submitted key again. Use `POST /models/sync` and `GET /models` to list cloud models, then `PUT /active-model` to select one.
- **Token Usage:** call `/usage/daily` for daily/weekly/monthly/custom totals, `/usage/by-model` for provider plus exact model totals, and `/usage/logs` for invocation details. Show null token counts as unavailable. Buckets use Europe/Istanbul; timestamps/range boundaries are UTC.
- **Authorization:** all provider, credential, model discovery/registration, and selection routes require the installation owner. Handle `403` and `503 INSTALLATION_OWNER_NOT_CONFIGURED`; analytics routes are available to authenticated users and scoped to their own records.

```sh
TOKEN='your-jwt'
BASE='http://localhost:3220/api/llm'

# Check configured provider flags, without exposing credentials
curl -H "Authorization: Bearer $TOKEN" "$BASE/providers"

# Discover Ollama installations, free OpenRouter models, and OpenAI models (requires a configured OpenAI key)
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/models/sync"

# Register a Gemini ID, select any listed compatible model, then read selection
curl -X POST "$BASE/models" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"provider":"google","modelId":"gemini-2.5-flash"}'
curl -X PUT "$BASE/active-model" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"provider":"openrouter","modelId":"provider/model:free"}'
curl -H "Authorization: Bearer $TOKEN" "$BASE/active-model"

# Istanbul-local daily buckets, model totals, and invocation records
curl -H "Authorization: Bearer $TOKEN" "$BASE/usage/daily?period=weekly"
curl -H "Authorization: Bearer $TOKEN" "$BASE/usage/by-model?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z"
curl -H "Authorization: Bearer $TOKEN" "$BASE/usage/logs?provider=ollama&limit=50&offset=0"
```

`PUT /active-model` accepts `{ "provider": "google|openrouter|openai|ollama", "modelId": "exact-provider-id" }`. A change is database-authoritative and read for each new agent request; in-flight requests keep their model snapshot. `GET /usage/daily` accepts `period=daily|weekly|monthly` or both `from` and `to` as ISO timestamps. Analytics are user-scoped and report UTC range boundaries with `Europe/Istanbul` daily buckets. Missing provider usage is null and is counted as `missingUsageCount`; no prompt or document contents are stored.

## Cloud provider credentials and OpenAI

Global model and credential administration requires `Authorization: Bearer $TOKEN` for the configured installation owner. Set `INSTALLATION_OWNER_USER_ID` to that user's database ID; requests fail closed if it is unset. The `apiKey` field is accepted only by the credential endpoint; responses, provider status, and audit rows contain status only. Configure `LLM_CREDENTIALS_ENCRYPTION_KEY` as a base64-encoded random 32-byte key before saving credentials. Keys are encrypted with AES-256-GCM. Existing `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and `OPENAI_API_KEY` remain supported as environment fallbacks. A stored key takes precedence; revoking it re-enables the environment fallback if present.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /providers` | — | `[{id, configured}]`; no key values |
| `PUT /providers/{google\|openrouter\|openai}/credential` | `{"apiKey":"…"}` | `{"provider":"openai","configured":true,"source":"database"}` |
| `DELETE /providers/{google\|openrouter\|openai}/credential` | — | status; environment fallback may remain configured |
| `POST /providers/{provider}/test` | — | `{"provider":"openai","configured":true,"reachable":true,"authenticated":true,"statusCode":200}` |
| `POST /models/sync` | — | registered model list; includes OpenAI catalog when credentials are available |
| `POST /models` | `{"provider":"openai","modelId":"gpt-4.1-mini"}` | registered model; call model test before activation |

Credential errors use `UNSUPPORTED_CLOUD_PROVIDER`, `INVALID_API_KEY`, `PROVIDER_CREDENTIAL_NOT_CONFIGURED`, or encryption-key configuration errors. Model selection rejects unavailable or incompatible entries. Provider tests use fixed official provider endpoints; callers cannot supply endpoints or URLs. OpenAI discovery uses the official `/v1/models` catalog and admits only model families supported by this agent's tool and streaming needs. OpenAI calls use the official chat completions API adapter; streaming and tool calls remain within the existing Mastra agent flow.

```sh
curl -X PUT "$BASE/providers/openai/credential" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"apiKey":"YOUR_OPENAI_KEY"}'
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/providers/openai/test"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/models/sync"
curl -X PUT "$BASE/active-model" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"provider":"openai","modelId":"gpt-4.1-mini"}'
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/providers/openai/credential"
```

Existing compatibility routes under `/api/admin/llm` remain available. Installation-owner authorization is required for global model/settings administration; analytics may be read by any authenticated user and are scoped to that user's records.
