# SitePilot — NestJS + Mastra + TypeGraph + Prisma

Isolated development backend. The legacy SitePilot backend, database and volumes are not used or modified.

## Architecture

- NestJS exposes authenticated HTTP endpoints.
- Mastra `Agent.stream()` runs the agent and its `documentSearch` and `listDocuments` tools.
- TypeGraph owns document ingestion, embeddings, pgvector, semantic/BM25 hybrid retrieval and source chunks.
- Prisma stores application document metadata and conversation messages only.
- Ollama provides local `qwen3:8b` inference and `nomic-embed-text` 768-dimensional embeddings.

## Setup

```bash
pnpm install
pnpm prisma:generate
docker compose up -d db
pnpm prisma:deploy
pnpm typegraph:deploy
pnpm typecheck
pnpm test
pnpm dev
```

Default API: `http://127.0.0.1:3220`. Development database: `postgres://sitepilot:sitepilot@localhost:5444/sitepilot`.

## API

All routes require the development `x-api-key` except `/health`.

```bash
curl -X POST http://127.0.0.1:3220/api/agent/ask \
  -H 'x-api-key: YOUR_DEV_API_KEY' -H 'content-type: application/json' \
  -d '{"message":"What are the document requirements?"}'

curl -N -X POST http://127.0.0.1:3220/api/agent/stream \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"message":"What are the document requirements?"}'
```

The stream is a POST SSE response, so browser clients should use `fetch()` and read `response.body` with a streaming reader. `EventSource` cannot submit POST requests. Aborting the browser fetch disconnects only the SSE transport; the backend continues generation and persists the result.

Provider retries are bounded to two retries for transient planning and grounded-answer model calls, with exponential jitter and a capped safe `Retry-After`. Optional `MASTRA_FALLBACK_MODEL` is disabled by default; if configured, it must be an already-approved model from the same provider and support this agent's tool/structured-output needs. Ollama fallbacks stay on Ollama, so `MASTRA_PROVIDER=ollama` remains Local AI Only. This service has no separate tenant egress-policy registry; cloud-provider fallback is therefore restricted to the already-selected provider.

```js
const response = await fetch('/api/agent/stream', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
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

### SSE event contract

Frames use standard `event: <name>` and `data: <JSON>` lines.

- `status`: `{status:"started",conversationId,turnId}`. Workflow mode also includes `orchestration:"workflow"`.
- `stage`: `{stage,status,message,toolName?}` reports workflow progress. Current stage IDs are `planning`, `discovering`, `searching`, `executing`, `composing`, `validating`, and `completed`; `status` is `in_progress` or `completed`. `toolName` is present when a backend tool is running.
- `step-start`, `step-finish`: safe step index and elapsed/token usage values; prompts and model IDs are omitted.
- `tool-start`: allowlisted `toolName`; arguments are omitted.
- `sources`: citations produced by TypeGraph retrieval.
- `tool-finish`: allowlisted tool name, duration and source count; raw tool output is omitted.
- `text-delta`: `{text,verification:"provisional"}` for streamed workflow answers. Reasoning chunks are suppressed. Clients should replace provisional text with the final `done.answer`; if `done.discardProvisional` is true, discard the streamed draft entirely. Non-generative workflow answers are sent as one `verification:"verified"` delta.
- `text-reset`: `{reason:"provider-retry"}` tells the client to clear partial provisional text before a bounded provider retry.
- `done`: final answer, TypeGraph source references, tool names, citation validation state and request telemetry.
- `error`: safe error code only; no provider error body or credentials. Terminal errors set `discardProvisional:true`.

If citation validation fails or retrieval returns no evidence, the final answer is replaced with a safe fallback and `done.discardProvisional` is true. Because already delivered deltas cannot be retracted, provisional text must not be stored or shown as verified; the final `done` answer is authoritative. Citation validation checks that markers refer to retrieved chunks; it is not an independent fact-checker.

To start a conversation, POST `/api/agent/conversations`; pass its `id` as `conversationId` to `/ask` or `/stream`. GET `/api/agent/conversations` lists recent owned conversations and each latest message; GET `/api/agent/conversations/:id` returns the bounded message history. Each turn stores the user message and a pending assistant message before generation. Assistant messages include `status` (`processing`, `completed`, `interrupted`, or `failed`) and `stage` (`thinking`, `planning`, `searching`, `executing`, `composing`, `validating`, etc.). Disconnecting the SSE client does not cancel the turn; generation continues and persists its final answer. A process crash is reconciled to `interrupted` when its request timeout has elapsed. Tenant and owner scope come from server authentication, never from request content. While auth is the shared development key, all development requests share the configured owner scope.

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
AGENT_E2E_URL=http://127.0.0.1:3220 DEV_API_KEY="$API_KEY" pnpm test:e2e:stream
```

This real integration test checks Mastra tool events, multiple text deltas before `done`, a verified citation and persisted conversation messages.

The synchronous `/ask` compatibility and two-turn history test is available as `pnpm test:e2e:ask` under the same environment requirements.
