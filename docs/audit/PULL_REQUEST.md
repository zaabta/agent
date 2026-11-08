# Fix conversation history and add context-aware multi-document RAG

Earlier conversation messages were hidden because the history API used the LLM context limit. Workflow provider errors also lost their class identity during Mastra serialization, causing upstream 429s to become generic 500s. This change adds independent owned-history pagination, preserves safe provider metadata, passes bounded conversation history into planning, and retrieves bounded evidence across multiple focused queries.

Document questions avoid redundant structured-schema replanning. Multi-query search keeps TypeGraph authorization and active-version checks, fuses query-local ranks, deduplicates chunks and diversifies document evidence. Existing citation validation remains; workflow SSE now emits sources. Ingestion, embeddings, auth architecture and storage were preserved.

Validation:

- Baseline: TypeScript passed; 56 tests passed, 0 failed, 15 skipped.
- After frozen pnpm 10.10.0 install: TypeScript and evaluation-script typechecks passed; Prisma schema validation passed; 62 tests passed, 0 failed, 15 skipped.
- Actual Nest HTTP routes and Mastra workflows tested with in-memory Prisma-shaped persistence, test-token identity validation and mocked model methods: 429 history retention/retry, pagination/private ownership, multilingual follow-up context, incremental SSE/reset/sources/final persistence, cancellation and disconnect completion.
- Synthetic Markdown/TXT/PDF/DOCX/CSV/XLSX fixtures parsed successfully.
- Controlled original/updated workflow execution: document questions 4→3 model calls; injected complex plans 1→2 search queries and cited documents. These are mocked execution results, not live answer quality or production latency gains.
- Live quality suite: 33 cases prepared, all 33 skipped before and after. Actual inference, TypeGraph indexing, workers and PostgreSQL durability remain unverified. Docker/PostgreSQL/Redis/Ollama are absent; apt installation failed on container permissions; no real provider credentials supplied.

Run `pnpm prisma:generate`, `pnpm typecheck`, `pnpm typecheck:audit`, `pnpm test`, and `pnpm exec prisma validate`. `pnpm eval:workflow` reproduces the controlled execution comparison. See `docs/audit/REPORT.md` for exact isolated-stack, corpus-seeding, live evaluation and baseline-comparison commands, configuration and limitations. No new runtime dependency or migration is required. `MASTRA_OBSERVABILITY=false` is an optional test-only switch; the default tracing behavior remains enabled.

This PR should stay draft until live ingestion and quality evaluation are completed. No merge or production deployment is requested.
