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

The stream is a POST SSE response, so browser clients should use `fetch()` and read `response.body` with a streaming reader. `EventSource` cannot submit POST requests.

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

- `status`: `{status:"started",conversationId}`.
- `step-start`, `step-finish`: safe step index and elapsed/token usage values; prompts and model IDs are omitted.
- `tool-start`: allowlisted `toolName`; arguments are omitted.
- `sources`: citations produced by TypeGraph retrieval.
- `tool-finish`: allowlisted tool name, duration and source count; raw tool output is omitted.
- `text-delta`: `{text,verification:"provisional"}`. Reasoning chunks are suppressed. Clients should replace provisional text with the final `done.answer`.
- `done`: final answer, TypeGraph source references, tool names, citation validation state and request telemetry.
- `error`: safe error code only; no provider error body or credentials. Terminal errors set `discardProvisional:true`.

If citation validation fails or retrieval returns no evidence, the final answer is replaced with a safe fallback and `done.discardProvisional` is true. Because already delivered deltas cannot be retracted, provisional text must not be stored or shown as verified; the final `done` answer is authoritative. Citation validation checks that markers refer to retrieved chunks; it is not an independent fact-checker.

To start a conversation, POST `/api/agent/conversations`; pass its `id` as `conversationId` to `/ask` or `/stream`. GET `/api/agent/conversations/:id` returns the bounded message history. Each turn stores the user message before generation and stores the assistant answer only after successful completion. Tenant and owner scope come from server configuration, never from request content. While auth is the shared development key, all development requests share the configured owner scope.

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
