# Improve conversation reliability and contextual multi-document RAG

Conversation history used the LLM context limit as its UI response limit, and Mastra serialization hid provider-error identity. This change separates owned history/list pagination from model context, preserves sanitized 429 metadata, retains failed turns and earlier messages, and passes bounded conversation history into the workflow.

Adaptive retrieval uses up to four focused TypeGraph hybrid queries, RRF fusion, chunk deduplication and document diversity with existing authorization/version filters. Document questions skip redundant structured-schema planning; actual analytics preserve column and aggregation intent. Qwen3 grounded execution uses the correct Ollama reasoning option, removes unused tool schemas, preserves answer language and overrides conflicting tool-oriented instructions. Authorized index metadata restores page/chunk provenance. Verified insufficient-evidence refusals remain valid refusals.

Validation so far:

- Original main: 56 tests passed, 0 failed, 15 skipped.
- Resumed suite: 74 passed, 0 failed, 15 skipped; source/audit TypeScript and Prisma validation passed.
- Actual Nest HTTP/Mastra workflow regressions with mocked inference and in-memory persistence cover 429 retention/retry, pagination/ownership, multilingual context, SSE, cancellation and disconnect completion.
- Real CPU Ollama Qwen3 8B, existing Nomic embeddings, Redis/BullMQ API/worker and disposable PGlite/pgvector processed six formats; earlier raw live attempts preserve both successes and failures. PGlite is not native PostgreSQL16 validation.
- Controlled mocked original/improved workflows: 4→3 model calls for ordinary document questions; injected multi-query plans improve fixture document coverage. This is not a measured production speedup.
- A fresh 33-case actual-inference run is pending; the prior final run was lost with the ephemeral environment. Saved exploratory results are partial. No complete original-main live quality comparison is available.

Run `pnpm install --frozen-lockfile`, `pnpm prisma:generate`, `pnpm typecheck`, `pnpm typecheck:audit`, `pnpm test`, and `pnpm exec prisma validate`. Use the isolated Compose commands and authenticated seed/evaluation commands in `docs/audit/REPORT.md` and `LIVE_VALIDATION.md`; optional `AGENT_E2E_REFRESH_COOKIE` supports tests exceeding access-token lifetime. No new runtime dependency or schema migration is required.

Remaining: native PostgreSQL stress/concurrency, full retry/restart and version-race coverage, context-window calibration, multilingual human review, and complete original-main quality comparison. No production deployment, data reset or merge. GitHub write access currently returns403, so this is a prepared PR description, not an opened PR.
