# Live Ollama / Qwen3 8B follow-up validation

This supersedes the earlier first-pass environment blockers in `REPORT.md`. The follow-up obtained portable Redis and Ollama binaries, downloaded real models, and exercised the backend with real inference. The resumed live quality result will be in `quality-live-qwen3-8b-resumed.json`; check its presence and `complete` field before treating the run as finished. The earlier final run was not saved before the ephemeral environment ended, and is not counted.

## Actual test environment

- Ollama 0.40.14, CPU inference, real `qwen3:8b` model (approximately 5.2 GB download).
- Existing `nomic-embed-text`, 768-dimensional embeddings through the existing application embedder. No embedding provider or existing index format was replaced.
- Redis 7.0.15 and actual BullMQ worker/API processes.
- PostgreSQL 18.6 compiled to WASM via PGlite 0.5.15, with pgvector exposed over a TCP PostgreSQL protocol endpoint. This is a **test-only database substitute**, not a production migration or proof of native PostgreSQL 16 concurrency behavior. Its protocol multiplexer required PgBouncer-compatible prepared-statement settings. Connection-pool limitations affected the large-file stress run.
- Container limit 8 GiB RAM, 9 reported logical CPUs, no GPU, no swap. API and worker used bounded Node heaps. Broad unit tests and 8B inference must run in separate phases: running both concurrently contributed to OOM kills during exploration.
- Separate synthetic workspace, real registration, explicit test membership, real JWT login. No company documents, production database, production volumes or external LLM credentials were used.

## Confirmed additional defects and fixes

1. The existing legacy option used `providerOptions.ollama.reasoning_effort`. Mastra's OpenAI-compatible adapter expects **`reasoningEffort`**, which it serializes to HTTP `reasoning_effort`. Workflow planning, generation and validation did not consistently receive the option. A shared helper now applies the correct setting when `OLLAMA_THINK=false`. An actual local HTTP-server test verifies the serialized request body.
2. Grounded synthesis still carried unused tool schemas. `activeTools: []` removes them from requests that already have evidence and explicitly disable tool use. The live recording confirms zero tool definitions on these provider calls; Mastra and actual tool execution remain intact.
3. Qwen sometimes interpreted narrative comparisons as invalid table queries. Planning instructions distinguish narrative comparison from table calculation; an invalid structured plan has a bounded intent recovery, retaining clarification for actual unknown-column analytics.
4. An explicitly referenced follow-up after a cited answer could be classified as ordinary conversation and simply echoed. A conservative AR/TR/EN reference guard sends such turns back to authorized retrieval; old assistant content remains discourse context, never source evidence.
5. Schema refinement could silently change SUM to COUNT. Non-count calculation intent now survives identifier/schema refinement. A uniquely matching authorized dataset may be selected from its actual columns; an arbitrary first dataset is never selected.
6. Replacing the current message with an English standalone question also changed the answer language. The workflow now carries the **original user message separately**, giving it priority for answer language while using the resolved question for evidence operations. Regression tests preserve Arabic originals even when the resolved question is English.
7. Search results from SDK 0.6 project away custom provenance. Stored PDF pages, headings, table cell ranges and logical chunk IDs already existed in the authorized indexed-document metadata, but retrieval discarded them. Search now restores that metadata from the already-enumerated authorized index IDs, after the same active-version checks. Logical chunk indices no longer all collapse to SDK subchunk index zero. This requires no reindex and does not rewrite ingestion.
8. Isolated `TypegraphModule` construction omitted its Prisma dependency. The module now explicitly imports `PrismaModule`, so integration tests do not terminate silently on missing DI providers. Integration setup also disables Nest's abort-on-error behavior to expose failures.
9. The upload E2E assumed registration directly returned a tenant/token. Its fixture now follows pending registration → isolated membership → login. Cleanup no longer deletes the shared company workspace. Version/cancellation E2Es accept a real bearer token and explicit disposable-workspace opt-in; the concurrent-version test ties expected content to its actual upload rather than assuming completion order.
10. A real Arabic question retrieved unrelated English-document evidence with the configured Nomic model. `AGENT_RETRIEVAL_QUERY_LANGUAGE=auto` now asks for English search queries for `nomic-embed-text`, retaining literal names, identifiers and the original response language. `original` and `english` override the behavior. Other embedding model names retain the original-language default. This does not establish multilingual-document embedding quality; the quality corpus is primarily English with AR/TR/EN **questions**.

11. The tool-calling agent's default system instructions demanded exact sourceRef citations while grounded writing received E1/E2 labels and prohibited draft citations. Native English factual questions sometimes failed final validation under that conflicting contract. Grounded writing/verification now uses Mastra's documented per-execution instruction override, leaving the actual agent/tools/model unchanged. An HTTP regression verifies that these instructions replace the tool-calling defaults rather than append to them.
12. Two distinct chunks on the same PDF page can share a sourceRef. Grounding previously kept only the last chunk and rejected repeated supporting references. It now preserves logical chunk identities, maps all returned evidence IDs, and deduplicates only the final citation references. Unknown IDs still fail validation. A regression covers both same-page chunks and repeated evidence IDs.

## Real results already established

- Direct real Qwen3 8B inference answered `17 + 25` with `42`, without reasoning text.
- Markdown, TXT, PDF, DOCX, CSV and XLSX synthetic project files reached `ready` via authenticated upload → Redis/BullMQ worker → parsing/chunking → real Ollama embeddings → TypeGraph/pgvector → version publication. Persisted parsing, smart-chunking, embedding and publication progress was inspected. The extended upload run also reached `ready` for XLS.
- Repeat corpus uploads returned the existing ready document rather than reprocessing its unchanged content.
- Real multi-document inference generated four focused retrieval queries and retrieved requirements, budgets, risks and timeline. It identified both the 120000 base budget and conflicting 150000 proposed budget. Earlier runs also over-included unrelated rows and inferred an unsupported item currency; prompts were tightened and final human-review flags remain necessary.
- A real streamed answer produced exactly one terminal event and its verified final text matched the persisted assistant message. Provisional resets, sources and final content were recorded in `live-qwen-routing-improved.json`.
- The real Redis worker-heartbeat integration test passed, including heartbeat independence from a blocked event loop.
- Observed single budget-question times: 140459 ms before option fixes, 70578 ms with initial option/residency changes, and 36881 / 34452 ms after removing unused tool definitions. These are individual observations under different cache/residency and memory conditions, **not a statistically controlled speedup** or a prediction for a 16 GB company server.

## Stress failures and limits

The 3000-row CSV parsed successfully into 545 smart chunks. An initial 90-second test deadline expired while embeddings had actually completed 320/545 chunks, with measured progress and ETA. The test deadline was extended to 300 seconds. A later PGlite run encountered Prisma connection-pool timeouts with a one-connection client configuration and could not establish a completed stress result. This is recorded as failed/interrupted validation, not a passed upload stress test. Re-run this test on the normal native PostgreSQL/pgvector stack before drawing a production conclusion. Do not reset a database or volume to run it.

The full quality scorer records literal fact checks, permitted translated fact variants, cited-document coverage, reference validity, latency and orchestration call counts. Exact Excel and aggregation cases additionally require the corresponding structured tool; a plausible answer from general retrieval does not pass those checks. `humanReviewRequired` remains true for multilingual and interpretive categories. Public ask responses do not expose the entire raw candidate set, so raw retrieval recall remains unavailable.

Reference validation is not mathematical proof that every claim is entailed. Real small-model runs produced both unsupported answers before fixes and safe citation-validation failures. A refusal is recorded as a failed supported-fact question; it is not counted as a correct answer merely because it avoided hallucinating.

## Reproduce against the normal local stack

Use a disposable workspace and the native PostgreSQL/pgvector + Redis + Ollama setup in `REPORT.md` / `docker-compose.audit.yml`. Do not enable development API-key authentication just to run these tests.

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm typecheck
pnpm typecheck:audit
pnpm test
```

With the API and worker running and a real test user's bearer token:

```bash
export AGENT_E2E_URL=http://127.0.0.1:3320
export DOCUMENT_E2E_URL=http://127.0.0.1:3320
export AGENT_E2E_BEARER='<test login access token>'
export CONFIRM_ISOLATED_E2E=true
CONFIRM_ISOLATED_QUALITY_WORKSPACE=true pnpm eval:seed
pnpm eval:live-audit
EVAL_LABEL=live-qwen3-8b pnpm eval:quality
RUN_DOCUMENT_E2E=true pnpm test:e2e:documents
RUN_DOCUMENT_VERSION_E2E=true pnpm exec tsx --test test/document-versioning.e2e.test.ts
RUN_DOCUMENT_E2E=true pnpm test:e2e:cancellation
RUN_WORKER_MONITORING_E2E=true pnpm exec tsx --test test/worker-monitoring.e2e.test.ts
```

The upload fixture directly provisions only its new test identity's membership through Prisma, so its database URL must point to the same explicitly disposable database as the API. It preserves the canonical workspace. The live-audit and seed commands add synthetic files and do not delete existing documents.

Ollama ran with one parallel request and one loaded model to fit the 8 GiB test limit. That forces embedding/generation model swaps; production latency on 16 GB requires measurement with the actual model residency and context settings. The tested inference context was 4096 tokens. Large evidence/history budgets still need context-window calibration on the deployment model.

## Final evaluation status

The earlier final 33-case run was lost when the ephemeral environment ended. Only the saved partial attempts count as durable evidence. A fresh resumed run is being prepared. No unsaved result is claimed.

## Resumed validation fixes

- A verified `evidenceSufficient=false` response with no evidence IDs now remains a `no-evidence` refusal even when retrieval returned irrelevant candidate passages. Unknown or invalid references still fail validation. A real Mastra workflow regression verifies the Arabic refusal and empty source list.
- The long-running quality and upload harness can use `AGENT_E2E_REFRESH_COOKIE` (the test login cookie pair, passed privately via environment) to rotate an expired bearer token through the existing `/api/auth/refresh` API and retry once. No credential is written to reports. This fixes the harness, not the application authentication design. Without the cookie a 401 remains a visible failure.
- The live SSE reader preserves UTF-8 decoder state across byte chunks. Quality records include available timing/usage fields and require Arabic text for Arabic cases; Turkish language and semantic entailment still require human review.
- Resumed broad checks: 74 passed, 0 failed, 15 skipped (89 total); source and audit-script typechecks and Prisma validation passed.
