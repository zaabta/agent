# SitePilot AI — LangGraph Agent Capabilities

This inventory describes the active NestJS agent path after the LangGraph migration. No Atomic production database or API integration is registered in this phase.

## Orchestration

`AgentService.ask()` and `AgentService.stream()` create the same request-scoped LangGraph graph. Its order is `router`, optional `planner`, `tool_executor`, `evidence_collection`, `source_resolution`, `evidence_validation`, `answer_provider`, and deterministic `finalization`. There is no Mastra runtime fallback.

The router sends ordinary conversation directly to tool execution (which does no operation for ordinary chat) and sends workspace/follow-up requests through planning. The planner returns a validated structured operation and never executes tools itself. All evidence is collected, source identities resolved, and tenant/scope/provenance validated before the answer model runs. The model returns structured claims with evidence IDs; finalization only serializes claims and attaches already resolved sources. There is no post-answer evidence check or repair call.

## Registered capabilities

| Capability                  | Existing implementation                  | Authorization/provenance                                                                                                                    |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `document_search`           | `TypegraphService.searchDocuments`       | Tenant and authenticated user are closed over by the graph. TypeGraph retains active-version filtering and stable source references.        |
| `list_documents`            | `TypegraphService.listDocuments`         | Tenant and user scope are passed by the server.                                                                                             |
| `dataset_discovery`         | `StructuredDataService.discoverDatasets` | Tenant-scoped, authorized dataset metadata only.                                                                                            |
| `structured_data_lookup`    | `StructuredDataService.lookup`           | Tenant-scoped exact-cell lookup with source rows.                                                                                           |
| `structured_data_analytics` | `StructuredDataService.aggregate`        | Bounded read-only operations over validated schema columns and tenant-scoped active versions.                                               |
| `structured_row_lookup`     | `StructuredDataService.lookupRows`       | Bounded filters over actual columns, tenant-scoped active versions.                                                                         |
| registered read tools       | `BackendTools.catalog/execute`           | Authorization and argument schemas are rechecked at execution; configured read-only HTTP tools retain version checks and output validation. |

The Phase 1 `AtomicToolRegistration` contract reserves a future read-only registration shape. It is not connected to production systems.

## Model boundaries and verification

Planner and answer models are resolved independently through the existing LLM runtime settings. One `@langchain/openai` model factory selects OpenAI, OpenRouter, Ollama, or Google/Gemini's OpenAI-compatible chat endpoint. It validates the selected provider, model ID, credentials, and output budget before constructing the model; retries and provider substitution are disabled.

A request-scoped masker covers user text, bounded history, planner catalog text, prior structured selections, retrieved/tool evidence, and answer inputs before model calls. Replacements stay in the request-local masker and are restored only for authorized tool execution and final answer text; source metadata is masked in the result. The masker targets common emails, phone numbers, bearer/JWT/API tokens and credential assignments; it cannot recognize every possible personal or confidential value.

Evidence validation checks evidence scope, stable evidence identities, source provenance, and structured numeric result provenance before generation. Semantic entailment is not automatically verified; workspace answers are marked `unverified` and carry explicit evidence-ID references. Missing required evidence bypasses answer generation and returns a deterministic insufficiency response.

## SSE and persistence

The existing authenticated controller and persistence services remain in place. LangGraph stage progress is streamed; resolved sources and one assembled final-answer delta follow answer generation. No provisional answer is sent. On model failure, the controller emits a safe error and the pending assistant message is marked failed/interrupted. Completed turns persist through existing Prisma conversation and context services.
