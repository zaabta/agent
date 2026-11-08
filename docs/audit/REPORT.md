# SitePilot backend reliability and RAG audit

Baseline: `3cc78e47cce4a0fc741c506f1543a224471ac0c0` (latest main rechecked on November 8). Backend only; no production access, deployment, historical conversation deletion, index removal or volume reset. Existing migrations were executed only against a disposable test database. Read `LIVE_VALIDATION.md` for real Ollama follow-up results; the original skipped benchmark files are historical first-pass artifacts.

## Confirmed causes and changes

1. `getConversation` used `AGENT_HISTORY_MESSAGES` (default 10) as its UI response limit. Earlier messages remained in storage but disappeared from the response once new turns displaced them. The API now defaults to 100 messages (maximum 200), returns `hasMore`/`nextCursor`, and accepts `?limit=&cursor=`. The existing `messages` field remains chronological. The conversation list now also has cursor pagination (default 50, maximum 100), avoiding an inaccessible older-history tail. Cursors are checked against ownership before use. A consumer must follow `nextCursor` to display older pages; no frontend changed.
2. A workflow `ProviderRequestFailure` becomes a plain serialized object. The previous `instanceof` check missed it and a simulated upstream HTTP 429 produced generic HTTP 500. Safe handling now reconstructs allowlisted code/retry metadata and produces HTTP 503 with `PROVIDER_RATE_LIMITED`, preserving existing provider-error semantics. No raw provider response is returned. Failed assistant placeholders are retained as `failed`; earlier rows remain unchanged.
3. Both workflow entry points loaded PostgreSQL history but passed only `{message}`. They now pass recent turns. A total 12,000-character, 10-message workflow budget supplements existing per-message/database limits. Failed/processing assistant turns are excluded. Planning resolves follow-ups into an optional standalone question and search queries in the same planning call. History is explicitly unverified discourse; synthesis and citation validation must use retrieved evidence.
4. Every evidence-seeking request previously discovered structured schemas and replanned, even for document questions. Schema discovery/refinement now applies to structured discovery, aggregation and lookup. Ordinary conversation retains its single planner response. Structured tools, validation, and bounded repair remain intact.
5. Retrieval had a hidden `max(configured threshold, 0.5)` filter above TypeGraph's configured score floor (default 0.32). It is removed; TypeGraph remains responsible for its configured threshold, hybrid search, optional native reranking, authorization and active-version filtering. A regression uses relevant score-0.4 passages successfully. No claim is made that any universal score threshold is calibrated.
6. The planner may emit 2–4 focused queries for complex requests; simple requests use one. Independent searches run concurrently with `allSettled` so failed searches settle before termination. Query-local ranks are fused using RRF, chunks are deduplicated by document/version/chunk identity, and document round-robin selection bounds evidence to 8 complete passages / 18,000 characters. Exact citations are preserved. Existing multilingual empty-result English rewrite recovery remains bounded. This is rank fusion/diversity selection, not a newly trained semantic reranker.
7. Workflow SSE now emits its documented `sources` event. Draft reset, verified final text, citation verification and cancellation remain in place. Synchronous responses expose existing workflow timing/call counters for evaluation.

The entire reported UI disappearance incident cannot be fully attributed without the affected frontend/session and database. The truncation and serialized-error defects are reproduced. No destructive provider-error path was found. Authentication still validates the existing private owner identity; it was not redesigned.

## Verification

Initial baseline: TypeScript passed; **56 passed, 0 failed, 15 skipped** out of 71 tests.

Initial updated suite: **62 passed, 0 failed, 15 skipped** out of 77 tests. The resumed suite now reports **74 passed, 0 failed, 15 skipped** out of 89; application and evaluation-script typechecks and Prisma validation passed. Additional tests cover Ollama wire options, projected provenance, routing recovery, legitimate insufficient-evidence replies, and long-running audit session refresh.

The added HTTP regression starts a real Nest listener with the actual controller, auth guard, service, Mastra workflow and tools. It uses a test-token identity validator, an in-memory Prisma-shaped store and mocked Mastra model methods. It verifies:

- unauthorized access rejection and private owner/cursor isolation;
- successful turns beyond the old history limit, upstream 429, failed-turn status, unchanged earlier messages, conversation listing, recovery;
- non-overlapping message pages and conversation-list pages beyond 50 entries;
- Arabic, Turkish and English history reaching the planner;
- scoped concurrent multi-query evidence, score-0.4 citations and three model calls;
- incremental provisional deltas, reset, sources, one done event and exact final/persisted content equality;
- terminal provider SSE error without done, explicit cancellation/interrupted persistence, and completion after transport disconnect.

Parser tests additionally validate a generated Markdown/TXT/PDF/DOCX/CSV/XLSX Orion corpus. Existing deterministic tests continue to cover chunking, structured tools, provider retries, version isolation, embedding behavior and run-registry cleanup.

These tests do **not** prove PostgreSQL transaction durability, actual JWT/session refresh, live provider inference, pgvector retrieval relevance, distributed worker recovery, or production performance.

### Execution-path comparison

`workflow-before.json` runs the original workflow source from the baseline commit. `workflow-after.json` runs the updated workflow. Both use injected deterministic plans, model drafts, validators and search results. Their wall times are local harness timings, not production latency.

| Controlled case | Before model calls | After model calls | Before searches / cited documents | After searches / cited documents |
| --- | ---: | ---: | --- | --- |
| Simple document question | 4 | 3 | 1 / 1 | 1 / 1 |
| Multi-document question | 4 | 3 | 1 / 1 | 2 / 2 |
| Follow-up (each of AR/TR/EN) | 4 | 3 | 1 / 1 | 2 / 2 |

History was absent in the original planner and present in the updated planner. This demonstrates execution behavior with injected plans, **not** autonomous decomposition accuracy or real answer-quality improvement. Citation checks verify references and expected fixture facts; semantic entailment still needs human review.

### Live quality benchmark

`test/quality/cases.json` contains 33 cases: 11 categories × Arabic/Turkish/English. Categories include factual retrieval, costs, risk, timeline, synthesis, follow-up, Excel lookup, aggregation, missing evidence, conflict and citation checks. `quality-before.json` and `quality-after.json` record the first-pass skipped execution. Subsequent `quality-live-*.json` files contain actual inference; distinguish complete runs from partial checkpoints. The ephemeral environment ended before its earlier final run was saved, so that unsaved result is unavailable. See `LIVE_VALIDATION.md` for the current status. There is no complete original-main live benchmark, so no controlled original-main quality gain is claimed.

The live runner stores question, expected facts/documents, actual answer, cited documents, citation validity, latency, available call counts, pass/fail and human-review flags. Raw retrieved documents are `null` because the public ask response exposes cited sources, not the complete retrieval set. Do not equate cited-document coverage with raw retrieval recall. Lexical fact checks can miss translated synonyms, so multilingual failures require review.

## Limits and outstanding validation

- Docker/Podman and native PostgreSQL remain unavailable. Portable Redis/Ollama and PGlite/pgvector enabled real six-format ingestion and local inference, with the database-concurrency limits recorded in `LIVE_VALIDATION.md`. Docker configuration is supplied but was not executed.
- Fifteen service-dependent tests skip in the broad unit command. Separately executed live checks must be counted individually, never as passing all skipped E2Es. Full native PostgreSQL stress, worker retry/restart recovery and all version-race scenarios remain incomplete.
- No real OpenRouter quota or credentials were used. Synthetic upstream HTTP 429 exercises the provider-error path. Real inference uses local Qwen3 8B and existing Nomic embeddings.
- Native TypeGraph reranking remains opt-in. Large evidence/history budgets need calibration against the server context window. Citation identity checks and lexical expected facts do not prove semantic entailment.
- GitHub reads work, but branch creation returns HTTP 403 `Resource not accessible by integration`. No remote feature branch or PR has been created.
- Request cancellation is process-local, as before. A disconnected transport continues backend persistence by design. No distributed cancellation platform was introduced.

## Reproduction

Use the repository's Node >=22.18 and pnpm 10.10.0. No new runtime dependencies or schema migrations are required.

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm typecheck
pnpm typecheck:audit
pnpm test
pnpm exec prisma validate
pnpm eval:workflow
pnpm eval:quality
```

Without `AGENT_E2E_URL` and `AGENT_E2E_BEARER`, the quality command records skipped results. To reproduce the controlled baseline comparison from this branch:

```bash
git show 3cc78e47cce4a0fc741c506f1543a224471ac0c0:src/agent/agent.workflow.ts > src/agent/original-workflow.ts
EVAL_LABEL=before WORKFLOW_COMPARISON_MODULE=../src/agent/original-workflow.ts pnpm eval:workflow
rm src/agent/original-workflow.ts
EVAL_LABEL=after pnpm eval:workflow
```

Disposable live stack (all resources are project-prefixed and separate from the normal compose file):

1. Copy `.env.example` to `.env.audit`; use a random test-only JWT secret, `COMPANY_WORKSPACE_ID=sitepilot-disposable-audit`, `PORT=3220`, and `DOCUMENT_QUEUE=sitepilot-disposable-audit`. Keep workflow mode enabled and local Ollama generation/embeddings. The ignored test environment prepared during this audit contains no production credentials.
2. Start isolated services and provision approved local models:

```bash
docker compose -p sitepilot-audit -f docker-compose.audit.yml up -d db redis ollama
docker compose -p sitepilot-audit -f docker-compose.audit.yml exec ollama ollama pull nomic-embed-text
docker compose -p sitepilot-audit -f docker-compose.audit.yml exec ollama ollama pull qwen3:8b
docker compose -p sitepilot-audit -f docker-compose.audit.yml run --rm api pnpm prisma:deploy
docker compose -p sitepilot-audit -f docker-compose.audit.yml run --rm api pnpm typegraph:deploy
docker compose -p sitepilot-audit -f docker-compose.audit.yml up -d api worker
```

3. Register a disposable user and provision its membership in this disposable workspace using the existing auth/membership administration process. Registration intentionally leaves identities pending; this audit does not bypass that requirement. Obtain its bearer token via login. Export `AGENT_E2E_URL=http://127.0.0.1:3320` and `AGENT_E2E_BEARER` in the test shell. Host-side service E2Es also require `DATABASE_URL=postgres://audit:audit-test-only@localhost:55444/sitepilot_audit`, `REDIS_URL=redis://127.0.0.1:56391` and a reachable local Ollama endpoint; the audit Ollama endpoint is `http://127.0.0.1:11435`. Review each E2E's opt-in variables before running; never point them at company data.
4. Seed and await indexing, then evaluate:

```bash
CONFIRM_ISOLATED_QUALITY_WORKSPACE=true pnpm eval:seed
EVAL_LABEL=after pnpm eval:quality
```

Run the same corpus/questions with baseline main in a separate disposable environment for genuine before/after inference results. Retain JSON outputs. Review multilingual synonyms, missing-evidence answers, conflicts and citation entailment manually. The seed tool adds test documents; it never deletes existing data.

## Future external tools

Keep existing Mastra `createTool` and tenant-bound factory closures. Add a small service adapter per backend with a Zod input/output schema and `execute({principal, signal, input})`. For `listUsers`, `getEmployee`, `getViolations`, require current authorization, enforce tenant scope server-side, propagate cancellation/timeouts and expose only necessary fields. Never accept tenant identity from a model argument. Tool results are data, not instructions.

For `createViolation`/`updateEmployee`, a separate server action should validate role/resource permission and schema, issue an expiring confirmation bound to actor+tenant+exact payload, then revalidate that confirmation and permissions on execution with an idempotency key and audit event. Model-generated text is not confirmation. No external mutations or new plugin framework were implemented.

## Delivery status

Two implementation/evaluation commits were prepared locally on `feat/agent-rag-quality-and-reliability`. Publishing was attempted: `git push` failed because the shell has no GitHub credentials, and the connected GitHub integration returned HTTP 403 `Resource not accessible by integration` for both Git-tree writes and branch creation. Consequently no remote branch or pull request was created. `PULL_REQUEST.md` contains the complete prepared PR description. The delivered mail-format patch preserves the commits and can be applied with `git am` on the requested branch, then pushed with an account/integration granted repository Contents write access. Do not merge automatically.
