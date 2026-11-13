# SitePilot — NestJS + Mastra + TypeGraph + Prisma

Isolated development backend. The legacy SitePilot backend, database and volumes are not used or modified.

## Architecture

- NestJS exposes authenticated HTTP endpoints.
- Mastra `Agent.stream()` runs the agent and its `documentSearch` and `listDocuments` tools.
- TypeGraph owns document ingestion, embeddings, pgvector, semantic/BM25 hybrid retrieval and source chunks.
- Prisma stores application metadata, conversation state, LLM runtime settings, registered models, and redacted per-invocation usage metadata.
- Ollama provides local `qwen3:8b` inference and `nomic-embed-text` 768-dimensional embeddings.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm prisma:generate
docker compose up -d db
pnpm prisma:deploy
pnpm typegraph:deploy
pnpm typecheck
pnpm test
pnpm dev
```

Choose the active provider/model and add cloud API keys in the LLM Settings page. The backend needs `LLM_CREDENTIALS_ENCRYPTION_KEY` to encrypt UI-managed keys. Existing `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, and model-selection environment values remain supported as backward-compatible fallbacks/bootstrap, but are no longer listed in `.env.example`. `pnpm prisma:deploy` applies additive migrations; it does not reset the database.

Default API: `http://127.0.0.1:3220`. Development database: `postgres://sitepilot:sitepilot@localhost:5444/sitepilot`.

### Runtime model registry and token analytics

`MASTRA_PROVIDER`, `MASTRA_MODEL`, `MASTRA_FALLBACK_MODEL`, and `OLLAMA_THINK` (plus the optional history, timeout, and TypeGraph threshold settings) seed database runtime settings without overwriting existing database values. Each new agent request reads one immutable model snapshot from PostgreSQL, so separate API instances see installation-owner changes on the next request. Ollama discovery reads the trusted `OLLAMA_BASE_URL` and confirms tool capability through `/api/show`; OpenRouter free models are read from its public model catalog and require tool plus structured-output support; Gemini remains available from `GEMINI_API_KEY` or an encrypted installation-owner-managed credential. OpenAI models are discovered from the official model catalog when an `OPENAI_API_KEY` fallback or encrypted credential is configured. Only API keys stay backend-only. UI-managed credentials require `LLM_CREDENTIALS_ENCRYPTION_KEY` (32 random bytes encoded as base64) and are encrypted with AES-256-GCM; environment keys remain supported as fallbacks. Embedding and TypeGraph ingestion configuration remains independent.

Global provider/model/runtime endpoints require a JWT for the configured installation owner (`INSTALLATION_OWNER_USER_ID`). User usage analytics is authenticated and scoped to the caller:

```text
GET  /api/admin/llm/settings
POST /api/admin/llm/settings
GET  /api/admin/llm/models
POST /api/admin/llm/models                 {"provider":"google","modelId":"google/gemini-3.6-flash"}
GET  /api/admin/llm/usage?period=today|yesterday|daily|weekly|last7days|monthly|last30days
GET  /api/admin/llm/usage?from=<ISO>&to=<ISO>&groupBy=date|provider|model&provider=<provider>&modelId=<exact-id>
```

Example switching and reporting requests:

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3220/api/admin/llm/models
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"MASTRA_PROVIDER":"ollama","MASTRA_MODEL":"qwen3:8b"}' http://127.0.0.1:3220/api/admin/llm/settings
curl -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:3220/api/admin/llm/usage?period=last7days&groupBy=model'
```

Settings return `{settings, secrets:{geminiConfigured,openrouterConfigured}}`; model results preserve exact provider/model identifiers. Usage results return `timezone`, UTC `from`/`to`, `groupBy`, and grouped `data` with invocation count, input/output/total/cached/reasoning tokens, missing usage count, and average latency. Provider usage values are recorded when returned by Mastra; unavailable token counts remain null. No prompt or document contents and no prices/costs are stored. The new additive migration is `202611130001_runtime_llm_registry_usage`; run `pnpm prisma:generate` then `pnpm prisma:deploy` after reviewing the migration in the target environment. Do not run the deploy command against production without the normal production approval.

## API

Protected routes require a valid bearer JWT. Register with `{ "username", "password" }` and log in with the same fields at `/api/auth/register` and `/api/auth/login`. Registration does not issue a session; login returns an access token and an HttpOnly refresh cookie. Existing users are assigned a stable username by the additive migration and may continue to log in by their existing email during frontend migration. The API no longer accepts workspace selection, membership management, roles, or shared development API keys.

Global LLM settings, credentials, model selection, and worker administration fail closed until `INSTALLATION_OWNER_USER_ID` is set to the selected user's database ID. Find that ID locally with `SELECT id FROM users WHERE username = '<username>';`, set it in the backend environment, and restart the API. The owner is a single installation-level trust anchor; tenant/member role records remain in PostgreSQL for data preservation but are no longer used for API authorization.

Conversation history is bounded by `AGENT_HISTORY_MESSAGES` and `AGENT_HISTORY_MESSAGE_CHARS`. Conversations, memories, and usage logs are scoped to the authenticated user. Documents retain their existing shared installation workspace behavior; retrieval continues to use server-side authorization filters. Verified document references and active selections are persisted per conversation and revalidated against the authenticated user on retrieval. Personal memory is explicit and user-managed (it is not extracted from every message): use `GET/POST /api/agent/memories` and `PATCH/DELETE /api/agent/memories/:id`. Entries are bounded and reject credential-like content. Conversation summaries and evidence references are context hints only; document content remains untrusted and must be retrieved and authorized again.

### Build and tests

```bash
pnpm prisma:generate
pnpm lint
pnpm build
pnpm typecheck
pnpm test:unit
pnpm test
```

The test harness also exposes `pnpm test:integration` for opt-in `*.e2e.test.ts` files; run it only with the isolated service environment and variables documented by each test. Named scripts include `pnpm test:e2e:stream`, `pnpm test:e2e:documents`, and `pnpm test:e2e:typegraph`. These suites require PostgreSQL, Redis, TypeGraph, worker, and local model services as applicable. Live Gemini checks consume quota and should be run only when quota is available. GitHub Actions runs lint, typecheck, build, and the non-E2E regression suite on pushes and pull requests.

```bash
curl -X POST http://127.0.0.1:3220/api/agent/ask \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"message":"What are the document requirements?"}'

curl -N -X POST http://127.0.0.1:3220/api/agent/stream \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"message":"What are the document requirements?"}'
```

The stream is a POST SSE response, so browser clients should use `fetch()` and read `response.body` with a streaming reader. `EventSource` cannot submit POST requests. Aborting the browser fetch disconnects only the SSE transport; the backend continues generation and persists the result.

Provider retries are bounded to two retries for transient planning and grounded-answer model calls, with exponential jitter and a capped safe `Retry-After`. Optional `MASTRA_FALLBACK_MODEL` is disabled by default; if configured, it must be an already-approved model from the same provider and support this agent's tool/structured-output needs. Ollama fallbacks stay on Ollama, so `MASTRA_PROVIDER=ollama` remains Local AI Only. This service has no separate tenant egress-policy registry; cloud-provider fallback is therefore restricted to the already-selected provider.

```js
const response = await fetch('/api/agent/stream', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ message, conversationId }),
  signal: abortController.signal,
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  handleSseText(decoder.decode(value, { stream: true }));
}
```

Client reducer guidance: append provisional `text-delta` values to a draft buffer; clear that buffer on every `text-reset`; replace visible text with a verified delta; always replace it with `done.answer` on `done`. On `error` or `cancelled`, clear the draft when requested and stop treating the turn as active. Retain the `runId` from `status`; the cancel button should POST the cancel route with the same bearer token. Do not treat `AbortController.abort()` on the stream request as cancellation of backend work.

### SSE event contract

Frames use standard `event: <name>` and `data: <JSON>` lines.

Example safe frames (IDs and answer text are illustrative):

```text
event: status
data: {"status":"started","runId":"<opaque-uuid>","conversationId":"<owned-conversation-uuid>"}

event: tool-start
data: {"toolName":"documentSearch"}

event: text-delta
data: {"text":"Draft fragment","verification":"provisional"}

event: text-reset
data: {"reason":"citation-verification"}

event: text-delta
data: {"text":"Citation-verified answer","verification":"verified"}

event: done
data: {"answer":"Citation-verified answer","sources":[],"citationValidation":"valid","discardProvisional":false}
```

- `status`: `{status:"started",runId,conversationId,turnId}`. `runId` is opaque and is used by the authenticated cancel endpoint. Workflow mode also includes `orchestration:"workflow"`.
- `stage`: `{stage,status,message,toolName?}` reports workflow progress. Current stage IDs are `planning`, `discovering`, `searching`, `executing`, `composing`, `validating`, and `completed`; `status` is `in_progress` or `completed`. `toolName` is present when a backend tool is running.
- `step-start`, `step-finish`: safe step index and elapsed/token usage values; prompts and model IDs are omitted.
- `tool-start`: allowlisted `toolName`; arguments are omitted.
- `sources`: citations produced by TypeGraph retrieval.
- `tool-finish`: allowlisted tool name, duration and source count; raw tool output is omitted.
- `text-delta`: workflow answer-generation chunks arrive as `{text,verification:"provisional"}`. Hidden reasoning chunks are suppressed. Workflow mode then sends one `{text,verification:"verified"}` delta after citation validation. Legacy mode may send only provisional chunks; in either mode `done.answer` is authoritative.
- `text-reset`: `{reason:"provider-retry"}` clears partial provisional text before a bounded retry; `{reason:"citation-verification"}` clears the completed draft before the verified answer is sent. Keep provisional text in a separate buffer and never append the verified answer to it.
- `done`: final answer, TypeGraph source references, tool names, citation validation state and request telemetry.
- `error`: safe error code only; no provider error body or credentials. Terminal errors set `discardProvisional:true`.
- `cancelled`: `{runId,status:"cancelled",executionSettled:true,providerStopConfirmed:false,ackLatencyMs}` means the local Mastra execution settled after its abort signal. It does not assert that a remote provider stopped computation.

The initial `status` event includes an opaque `runId`. An authenticated owner can call `POST /api/agent/runs/:runId/cancel`. The route is idempotent and returns `status:"cancelling"` until the local execution settles, `cancelled` when it settles, `finishing` if the verified answer is already being persisted, or the existing terminal state. A foreign or unknown run returns the same `404` response. The in-memory registry is bounded to 48 concurrent runs per API process and 2 per user; terminal records expire after two minutes. Cancellation propagates `AbortSignal` to Mastra, model streams, and TypeGraph search where SDK APIs support it. The provider may continue remote computation after the client abort; this API does not claim otherwise.

On `done`, set the rendered assistant content to `done.answer` as the authoritative value (replace, do not append). If `done.discardProvisional` is true, discard any provisional content. On `error`, discard provisional text when `discardProvisional` is true and render the safe error code. On `cancelled`, clear provisional content and render a cancelled/interrupted state, not a completed answer. Preserve text exactly as delivered so Arabic/RTL and Markdown are not corrupted; render Markdown only after applying the event protocol. A network disconnect or browser fetch abort does not cancel generation; use the cancel endpoint while connected or reload the persisted conversation after a disconnect. API restart drops process-local run IDs. Graceful shutdown aborts active execution and waits at most 1.5 seconds for local calls to settle; there is no cross-process cancellation recovery. If multiple API replicas are introduced, route cancellation to the originating replica or add authenticated Redis Pub/Sub coordination keyed by opaque run ID and owner identity. Citation validation checks that markers refer to retrieved chunks; it is not an independent fact-checker.

To start a conversation, POST `/api/agent/conversations`; pass its `id` as `conversationId` to `/ask` or `/stream`. GET `/api/agent/conversations` lists recent owned conversations and each latest message; GET `/api/agent/conversations/:id` returns the bounded message history. Each turn stores the user message and a pending assistant message before generation. Assistant messages include `status` (`processing`, `completed`, `interrupted`, or `failed`) and `stage` (`thinking`, `planning`, `searching`, `executing`, `composing`, `validating`, etc.). Disconnecting the SSE client does not cancel the turn; generation continues and persists its final answer. A process crash is reconciled to `interrupted` when its request timeout has elapsed. Tenant and owner scope come from server authentication, never from request content. While auth is the shared development key, all development requests share the configured owner scope.

### Document catalog pagination and conversation scroll

- `GET /api/documents?page=1&limit=20&search=Orion&status=ready&fileType=pdf` returns `{ documents, meta }`. This replaces the previous bare document array. Search is a literal case-insensitive filename substring; status/type filters and totals are tenant-scoped. `meta` includes page, limit, count, total, totalPages and next/previous-page flags.
- `GET /api/agent/conversations?limit=50&cursor=<nextCursor>` returns owned conversations and `meta { limit, count, hasMore, nextCursor, direction: "older" }`.
- `GET /api/agent/conversations/:id?limit=100&cursor=<nextCursor>` returns conversation fields, a chronological batch of messages and the same cursor metadata. Prepend older message batches when scrolling upward. Existing top-level `hasMore`/`nextCursor` remain available.
- The frontend owns scroll events. Pagination does not send additional model context or add persistent memory. See the [Arabic API contract and integration notes](docs/PAGINATION_API_AR.md) for request/response examples, limits, reset rules and error behavior.

### Document versions

The existing `POST /api/documents/upload` remains the first-version upload API and still returns `{ document, duplicate, version }`. Version uploads use `POST /api/documents/:id/versions` with multipart `file` and optional `reason` (up to 500 characters). Repeated content within the same logical document returns `duplicate: true` and the existing version.

- `GET /api/documents/:id/versions?page=1&limit=20` returns `{ documentId, activeVersionId, page, limit, total, versions }`.
- `GET /api/documents/:id/versions/:versionId` returns immutable version metadata and an `active` flag.
- `POST /api/documents/:id/versions/:versionId/restore` reindexes retained historical bytes in a fresh generation, then switches the active pointer only after indexing succeeds. It returns a queued job shape.
- `POST /api/documents/:id/versions/:versionId/reindex` queues an idempotent new index generation and returns `{ documentId, versionId, jobId, indexGeneration, status }`.
- `POST /api/documents/:id/versions/:versionId/cancel` requests cancellation of that version job. The usual `/api/jobs/:jobId` endpoint reports per-version progress.

Version records include `id`, `documentId`, `versionNumber`, `filename`, `checksum`, `fileSize`, `mimeType`, `uploadedAt`, `uploadedBy`, `status`, `indexedChunkCount`, `chunkingStrategy`, `chunkerVersion`, `embeddingModel`, `embeddingDimensions`, `replacementReason`, and index-generation values. Internal storage paths are not returned. Version status is `queued`, `processing`, `ready`, `failed`, or `cancelled`; a failed replacement never changes `activeVersionId`.

The installed TypeGraph SDK 0.6.0 accepts a document’s text and document-level metadata but does not expose pre-chunked input or per-chunk metadata. SitePilot therefore writes each generated chunk as a deterministic TypeGraph document, with `documentId`, `documentVersionId`, `indexGeneration`, `chunkId`, `chunkIndex`, `chunkCount`, `contentHash`, and source-location metadata. Citations preserve version and chunk identity. Search filters to the active version and generation; after a successful pointer switch, superseded vectors are pruned. The current SDK has no metadata filter in its public search options, so the service fetches a bounded candidate set before applying the active-version check. Pruning is best effort after publication; if cleanup fails, stale candidates remain hidden by the active-version check and a retry/reconciliation may be needed to reclaim index space.

Chunk limits can be tuned with `SITEPILOT_CHUNK_MAX_TOKENS`, `SITEPILOT_CHUNK_TARGET_TOKENS`, `SITEPILOT_CHUNK_MIN_TOKENS`, and `SITEPILOT_CHUNK_OVERLAP_TOKENS`. Counts use a conservative local estimator rather than a model tokenizer; no paid tokenizer or LLM is required. Existing legacy indexes remain searchable until their document receives a versioned replacement.

## Retrieval and safety

- TypeGraph is the only RAG engine. Do not add Prisma chunk/vector tables or custom ranking SQL.
- TypeGraph uses the server-configured tenant ID; tool arguments cannot choose a tenant.
- Prisma migrations create application tables only; TypeGraph deployment remains separate.
- The stream uses Mastra's native `Agent.stream()`/`fullStream`. It forwards only allowlisted lifecycle, tool progress, safe citation metadata and user-facing text events. Reasoning and raw events are not sent.
- Request timeout defaults to 180 seconds. Client disconnects abort Mastra's run. Incomplete assistant turns are not persisted.
- Qwen3 `think` is controlled with `OLLAMA_THINK` (default false in `.env.example`). Set true to enable reasoning. Local model and hardware performance varies.
- Telemetry reports provider-reported token counts when available; otherwise counts, tokens/second and model load time are `null`. Model inference duration is summed from Mastra step start/finish events; TTFT is measured to the first user-visible text delta.

## Tests

`pnpm test` runs the unit suite. For a running local API, installed local Ollama models and the synthetic pricing fixture already indexed in the isolated development TypeGraph, run:

```bash
AGENT_E2E_URL=http://127.0.0.1:3220 AGENT_E2E_BEARER="$TOKEN" pnpm test:e2e:stream
```

This real integration test checks Mastra tool events, multiple text deltas before `done`, a verified citation and persisted conversation messages.

The synchronous `/ask` compatibility and two-turn history test is available as `pnpm test:e2e:ask` under the same environment requirements.

### Excel ranking and drawing evidence

The workflow accepts requests such as “Top five employees by violation count in
2025” and “How many safety violations do they have?”. A ranked result from a single
sheet can be reused in a later turn of the same conversation. Its sheet, version,
selected values and applicable filters are used to constrain the SQL query. Apply
the additive migration with `npm run prisma:deploy` against your development
database before starting the updated API.

Set `OLLAMA_VISION_MODEL` on the document worker to an installed local Ollama
vision model. Upload PNG/JPEG files normally. PDF pages are checked for
extractable-text coverage; sparse or image-only pages are rendered and sent to
the local model for OCR, while searchable pages keep normal text extraction.
Mixed PDFs therefore retain native text and OCR text with their physical page
numbers. Files ending in `.drawing.pdf` continue to use the drawing-specific
vision extraction and remain limited to eight physical pages. If a scanned PDF
needs OCR and no local vision model is configured, the job fails with
`OCR_VISION_NOT_CONFIGURED` rather than retrying text parsing. Room schedules
are searchable text and do not enter the SQL analytics tables.

To compare revisions, upload them as separately named documents and mention both
names in the question. The comparison requires citations from both documents.
The workflow keeps ordinary active-version filtering. Visual readings, including
printed dimensions and schedule cells, are marked unverified and should be checked
against the original. The workflow does not calculate dimensions from image scale.

### Registering a read-only backend tool

Inject the exported `BackendTools` provider from `AgentModule` into the owning
Nest provider and register the tool during module initialization.

```ts
backendTools.register({
  id: 'employee_count',
  description: 'Count registered employees in a department.',
  input: z.strictObject({ department: z.string().min(1).max(80) }),
  authorize: principal => principal.userId === config.installationOwnerUserId,
  execute: async ({ department }, principal, signal) => {
    const count = await directory.countEmployees(principal.tenantId, department, signal);
    return `Registered employees: ${count}`;
  },
});
```

The handler must independently enforce resource authorization and use the
server-provided principal for user scoping. It must honor the abort signal.
The registry is intended for read-only handlers. Tool summaries are displayed
verbatim and are kept separate from document evidence. The existing planner can
select a registered tool alone or pair it with TypeGraph retrieval.
# LLM administration API (backend contract)

All global routes below require a JWT in `Authorization: Bearer <token>` for the configured installation owner. Usage analytics is available to authenticated users and is scoped to the caller's user ID. Swagger documents these routes at `/api/docs` outside production.

```http
GET  /api/admin/llm/settings
POST /api/admin/llm/settings
GET  /api/admin/llm/models
POST /api/admin/llm/models
GET  /api/admin/llm/usage?period=daily|weekly|monthly
GET  /api/admin/llm/usage?from=2026-11-01T00:00:00Z&to=2026-11-14T00:00:00Z&groupBy=date|provider|model
```

Example requests:

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:3220/api/admin/llm/settings
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"MASTRA_PROVIDER":"ollama","MASTRA_MODEL":"qwen3:8b"}' http://localhost:3220/api/admin/llm/settings
curl -H "Authorization: Bearer $TOKEN" http://localhost:3220/api/admin/llm/models
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:3220/api/admin/llm/usage?period=monthly&groupBy=model'
```

`POST /settings` accepts only `MASTRA_PROVIDER`, `MASTRA_MODEL`, `MASTRA_FALLBACK_MODEL`, `OLLAMA_THINK`, `AGENT_HISTORY_MESSAGES`, `AGENT_HISTORY_MESSAGE_CHARS`, `AGENT_REQUEST_TIMEOUT_MS`, and `TYPEGRAPH_MIN_SCORE`. Secret values are never returned; settings response includes configured flags for Gemini, OpenRouter, and OpenAI. Credential save, revoke, and connection-test endpoints are documented in `docs/llm-models-and-usage.md`; generic runtime settings cannot write credentials. Usage responses contain token counts only and use Europe/Istanbul date buckets.

On an offline Windows workstation with Prisma engines already installed in pnpm's store, generation can use the local 6.19.3 binaries rather than fetching checksums:

```powershell
$env:PRISMA_SCHEMA_ENGINE_BINARY = (Resolve-Path 'node_modules/.pnpm/@prisma+engines@6.19.3/node_modules/@prisma/engines/schema-engine-windows.exe').Path
$env:PRISMA_QUERY_ENGINE_LIBRARY = (Resolve-Path 'node_modules/.pnpm/@prisma+engines@6.19.3/node_modules/@prisma/engines/query_engine-windows.dll.node').Path
$env:PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING = '1'
node node_modules/prisma/build/index.js validate
node node_modules/prisma/build/index.js generate
```

If Node cannot spawn `tsx`/esbuild workers in a restricted shell, emit tests locally and run them in-process (E2E tests remain skipped unless their documented services and flags are configured):

```powershell
node node_modules/typescript/bin/tsc --noEmit false --outDir .test-build --declaration false
node --test --test-isolation=none .test-build/test/*.test.js
```
