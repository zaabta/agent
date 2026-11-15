# SitePilot AI — Existing Agent Tools Inventory

**Scope:** read-only inspection of the current backend implementation, registrations and workflow dispatch. No application behavior, schema, configuration, database, or frontend code was changed. GitNexus lists the `agent` repository but its index is one commit behind, so graph findings were checked against the current source. No tools were invoked through a running application.

## Executive inventory

- **Unique executable tools:** **6** Mastra `createTool()` registrations.
- **Planner operations:** **6 currently enabled** (`aggregate`, `lookup`, `retrieve`, `discover`, `list`, `respond`), plus a conditional `backend_tool` operation whose registry has **no current registrations**. If counting defined operation variants, there are 7; if counting available planner operations today, there are 6.
- **Tools exposed on the Agent:** **6** are attached to the `SitePilot RAG Agent` created by `createSitePilotAgent`. The workflow obtains the same six from `agent.listTools()` and invokes them in code. The separate workflow planner itself has no callable tool definitions; it receives operation schemas and an authorized backend-tool catalog in prompt text.
- **Currently enabled:** all six factory tools. No registered backend tools.
- **Write-capable Agent tools:** none. The six tools perform read/search/list operations.
- **External HTTP/API callable tools:** none found. External provider model-discovery fetches in `src/llm-admin/llm-admin.service.ts` are admin functionality, not registered Agent tools.

## Complete executable tool inventory

`createTool({ id })` is the Mastra registration. “Tool key” is the property name attached to the Agent. A human-readable display name is not separately configured in source; the table gives a suggested label based on the exact ID/key.

| ID / Agent key | Suggested display name | Description provided to LLM | Category | Input contract | Output contract | Source / execution service | Permissions, enabled, exposure, effects, errors/timeouts |
|---|---|---|---|---|---|---|---|
| `document-search` / `documentSearch` | Search workspace documents | “Search authorized workspace documents for evidence relevant to the user’s request. Use semantic search for any document-grounded question, including novel topics and paraphrases. Returns retrieved passages with source references for citations.” | Document retrieval | `{ query: string (min 2), topK?: integer 1..8 }` | `{ query: string, hits: unknown[], timing: { embeddingMs, retrievalMs, searchMs } }` | `src/mastra/factory.ts:createSitePilotAgent`; `TypegraphService.searchDocuments` | Enabled; attached to direct Agent and available to workflow toolset; not callable by planner as a native Mastra tool. Authenticated Agent request; tenant and actor passed to TypeGraph, active-version/document scopes enforced. Read-only. Workflow forwards abort signal; TypeGraph passes it to search/embedding. No per-tool timeout in factory; overall request timeout applies. Exceptions propagate to workflow tool error handling. |
| `list-documents` / `listDocuments` | List workspace documents | “Return the names and metadata of documents indexed in this authenticated workspace. Use only when the user asks what documents/files are available or asks to list them. This does not search document contents.” | Document inventory | `{}` | `{ documents: unknown, durationMs: number }` | `src/mastra/factory.ts:createSitePilotAgent`; `TypegraphService.listDocuments` | Enabled; direct Agent and workflow toolset; not a callable planner tool. Authenticated Agent request; tenant plus actor passed to TypeGraph; filters to active published document IDs. Read-only. No dedicated timeout or AbortSignal in tool execute/service call; overall request timeout applies. Exceptions propagate. |
| `structured-data-lookup` / `structuredDataLookup` | Find exact cell value | “Find authorized CSV/Excel rows containing a supplied exact cell value. Returns complete matching source rows and citations. For analytical operations use structuredDataAnalytics.” | Spreadsheet/CSV lookup | `{ value: string (1..250) }` | `{ query: string, hits: unknown[], durationMs: number }` | `src/mastra/factory.ts:createSitePilotAgent`; `StructuredDataService.lookup` → exact-cell lookup | Enabled; direct Agent and workflow toolset; workflow uses for exact value lookups. Authenticated Agent request; `tenantId` scope and ready/active document versions. Read-only. No AbortSignal/timeout passed by factory; overall request timeout applies. Exceptions propagate. |
| `dataset-discovery` / `datasetDiscovery` | Discover dataset schema | “Inspect authorized structured datasets to discover document names, sheet names, and actual column names. Use this before analytics when the relevant dataset or column is unclear. Returns schema metadata only, not row contents.” | Spreadsheet/CSV schema | `{ documentId?: string }` | `{ datasets: { documentId, filename, sheets: { sheetName, columns: string[] }[] }[] }` | `src/mastra/factory.ts:createSitePilotAgent`; `StructuredDataService.discoverDatasets` | Enabled; direct Agent and workflow toolset; invoked by workflow before structured validation and also for `discover`. Authenticated Agent request; tenant and optional document filter; ready active CSV/XLS/XLSX versions. Read-only. No AbortSignal/timeout passed by factory; overall request timeout applies. Exceptions propagate. |
| `structured-data-analytics` / `structuredDataAnalytics` | Analyze spreadsheet data | “Run tenant-scoped operations on ready CSV/Excel source rows: COUNT, SUM, AVG, MIN, MAX, GROUP_BY, or DISTINCT. Use the actual column names from datasetDiscovery; optionally scope by documentId, sheetName, and row filters. All values are treated as parameters; this tool cannot execute SQL. Results include source-row provenance.” | Spreadsheet/CSV analytics | `{ operation: COUNT\|SUM\|AVG\|MIN\|MAX\|GROUP_BY\|DISTINCT, columnName?: string (1..250), documentId?: UUID, sheetName?: string (max 250), selection?: structuredSelectionSchema, groupLimit?: integer 1..100, filters?: up to 8 { columnName (1..250), operator: EQ\|CONTAINS\|GT\|GTE\|LT\|LTE, value (max 1000) } }` | `Record<string, unknown>` (actual results include operation/value or groups, provenance sources, duration and sometimes selected group) | `src/mastra/factory.ts:createSitePilotAgent`; `StructuredDataService.aggregate` / `countRecords` | Enabled; direct Agent and workflow toolset. Workflow validates discovered columns and invokes for aggregate. Authenticated Agent request; tenant, ready active documents, parameterized filters. Read-only; does not execute arbitrary SQL. No AbortSignal/timeout passed by factory; overall request timeout applies. Validation/database errors propagate. |
| `structured-row-lookup` / `structuredRowLookup` | Find spreadsheet rows | “Find rows in authorized CSV/Excel data using one or more exact, contains, numeric, or ISO date filters over actual schema columns. Returns bounded source rows and citations.” | Spreadsheet/CSV row lookup | `{ documentId?: UUID, sheetName?: string (max 250), filters: 1..8 { columnName (1..250), operator: EQ\|CONTAINS\|GT\|GTE\|LT\|LTE, value (max 1000) }, limit?: integer 1..25 }` | `{ records: unknown[], sources: unknown[] }` | `src/mastra/factory.ts:createSitePilotAgent`; `StructuredDataService.lookupRows` | Enabled; direct Agent and workflow toolset; workflow invokes for filtered row lookups. Authenticated Agent request; tenant, ready active CSV/XLS/XLSX versions, optional document/sheet. Read-only, bounded to 25 rows by schema and service. No AbortSignal/timeout passed by factory; overall request timeout applies. Validation/database errors propagate. |

Input/output schemas above are from the actual Mastra tool declarations. Some output schemas intentionally use `z.unknown()` or `z.record(...)`; the underlying service has richer runtime objects but the declared LLM contract is broad.

## Planner operations (not additional executable tools)

The workflow’s `planSchema` is a validated discriminated union in `src/agent/agent.workflow.ts:createPlanSchema`. It routes intent to the six registered tool implementations or returns a conversational response. Operations themselves are **not** six additional `createTool()` registrations.

| Operation | Meaning and execution path | Current status / callable? |
|---|---|---|
| `retrieve` | Semantic content retrieval; calls `documentSearch`, potentially once per generated retrieval query, then evidence grounding/citation logic. Drawing revision comparison is a specialized retrieve path. | Available in active workflow; planner selects operation, not direct tool invocation. |
| `list` | Explicit file inventory; invokes `listDocuments`. | Available in active workflow. |
| `discover` | Dataset/sheet/column schema; workflow invokes `datasetDiscovery` and formats schema. | Available in active workflow. |
| `aggregate` | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `GROUP_BY`, `DISTINCT`; workflow validates against discovered data then invokes `structuredDataAnalytics`. May combine a document question with retrieval. | Available in active workflow. |
| `lookup` | Exact cell value invokes `structuredDataLookup`; filter criteria invoke `structuredRowLookup`. Exact-value recovery may be performed by internal workflow logic. | Available in active workflow. |
| `respond` | Ordinary conversation not grounded in workspace data; uses planner `reply` directly and calls no workspace tool. | Available in active workflow; this is a route/outcome, not an executable tool. |
| `backend_tool` | Calls `BackendTools.execute` for `backendCall.id` and arguments. The registry catalog is included in the planning prompt only for authorized registered entries. | Defined but **not reachable for any current named tool**: source search found no `BackendTools.register(...)` call. `BackendTools` remains an empty map unless a runtime caller registers an entry; none was found in app source. |

The schema declarations include workflow-only fields such as `standaloneQuestion`, `retrievalQueries`, `documentQuestion`, `compareDrawingRevisions`, `searchRankedGroups`, and previous-selection flags. These are planner routing/context fields, not independent tool parameters.

## Tool execution architecture

1. **Discover/build:** `createSitePilotAgent` in `src/mastra/factory.ts` constructs six Mastra tools on every Agent construction and attaches them under the six camelCase object keys. There is no persisted or dynamic tool registry for them.
2. **Choose:** In the active workflow (`src/agent/agent.workflow.ts:createAgentWorkflow`), a separate `SitePilot constrained planner` Mastra `Agent` has no `tools` property. The LLM chooses one schema-validated operation. Hardcoded instructions in this file define routing semantics, including when to retrieve/list/discover/aggregate/lookup/respond. `operationDescription` repeats a compact operation policy in Zod descriptions. `explicitAnalytics()` also hardcodes deterministic spreadsheet patterns and can override the model’s plan for explicit spreadsheet requests.
3. **Validate:** Mastra structured output uses `planLLMSchema` when the backend catalog has entries and `planLLMSchemaWithoutBackendTools` when empty. The generated result is parsed again using the runtime `planSchema`; invalid planner output falls back to `retrieve`. Workflow then checks discovered dataset/column metadata and validates tool arguments with each tool’s `inputSchema.parse` before execution.
4. **Execute:** The workflow obtains the factory Agent’s tools with `agent.listTools()`, then its `invoke(key,args)` helper parses the schema and calls `tool.execute(input,{abortSignal})`. Workflow operation code maps planner routes to these keys. `BackendTools.execute` is separate: it checks registration and per-principal authorization, validates input with the registered Zod schema, enforces argument/output length limits, and combines caller abort with a 15-second timeout.
5. **Receive/use result:** `invoke` stores tool output and timing, returns it to the workflow step; retrieval results are grounded and citation-validated, structured results are formatted from their source rows/schema/results, and the final step emits answer, sources, tool names, and outcome. The final response generation is not always an LLM call; `respond`, list and discovery can be formatted directly, while retrieved evidence may be passed to grounding generation.

### Direct/legacy path distinction

The non-workflow `AgentService.ask` path creates `createSitePilotAgent` and gives its six tools directly to the `SitePilot RAG Agent`, which can issue native Mastra tool calls. `AgentService.ask` selects workflow vs legacy using `config.agentOrchestration`. The workflow is the active path only when configured as such; source inventory cannot prove a particular deployment’s runtime setting. Streaming has corresponding workflow/direct paths.

### Timeout and error handling notes

- The API request/agent has an overall configured timeout. Workflow tool invocation checks abort before and after execution and records tool failures, but the structured-data services do not receive the workflow signal through the factory’s execute closures; a database query already running may therefore outlive cancellation. TypeGraph search does receive the signal.
- The six factory tools set no explicit per-tool timeout. Their service errors are not converted to a typed result in `factory.ts`; they propagate into Agent/workflow error handling.
- `BackendTools` entries, if later registered, receive a 15-second abort timeout plus parent cancellation, validate arguments and output, and return `undefined` for absent/unauthorized IDs. A tool implementation must honor the signal for cancellation to stop its own work.

## Duplicated or overlapping functionality

- `structuredDataLookup` and `structuredRowLookup` both return spreadsheet row evidence. They are distinct contracts: exact-cell value search vs one-or-more schema-column filters. Planner `lookup` unifies the intent and selects one of them. A Tool Registry should retain the distinction or present them as one UI group, not pretend they are identical.
- `structuredDataAnalytics` supports COUNT and filtered/grouped calculations; `structuredRowLookup` retrieves records. The planner includes a `lookup` vs `aggregate` distinction, while workflow code has recovery and deterministic heuristics that may revise a plan. This is layered routing, not duplicate executable tools.
- Document retrieval is called through native tool name `documentSearch` and workflow helper `searchDocuments`; the latter performs multi-query fan-out, merge and grounding. This is one underlying search capability with workflow orchestration, not an additional tool.
- `listDocuments` is a `TypegraphService` method; it is not equivalent to document search and remains one tool.
- `BackendTools` is a second registry mechanism, separate from Mastra `createTool()`, but it currently has no registered concrete tools.

## Internal-only and unreachable surfaces

- **Unreachable as a currently registered callable tool:** `backend_tool` operation, since no backend registration appears in app source and `BackendTools` starts empty. Its branch is implemented, but only a future registered item can pass its catalog/authorization checks and execute.
- **Planner-only, not executable:** operation names and routing fields; `respond` is a direct response mode, not a tool.
- **Internal services, not Agent tools:** `TypegraphService.deleteDocument*` methods are write operations for document lifecycle/admin use and are not included in `createSitePilotAgent`; never expose them as Agent actions without a separate authorization/product review. Spreadsheet ingestion, parsing, embeddings, conversation persistence and final response/citation logic are services, not tools.
- **External HTTP integrations:** no HTTP/API tool registration or dynamic tool loader is present. Admin model discovery requests to Ollama/OpenRouter/OpenAI are not reachable via the Agent tool list.

## Proposed Agent Studio integration (recommendation only)

### What can be configurable

- Present the six current tools as built-in read-only capabilities with stable IDs, grouped as **Documents** (`document-search`, `list-documents`) and **Structured data** (`dataset-discovery`, `structured-data-analytics`, `structured-data-lookup`, `structured-row-lookup`). Use source-backed descriptions and contracts shown above.
- Allow tenant/workspace owners to enable or disable each capability only after a per-tenant allowlist/configuration is implemented. Today enablement is code-defined: all six are always attached by the factory, and workflow `invoke` assumes they exist. There is no no-code enable/disable control today.
- Descriptions could be editable as *planner-facing metadata* after separating trusted policy/security rules from descriptive text. Current `factory.ts` descriptions and system instructions are source code. Do not allow edits to replace tenant scoping, authorization, evidence/citation rules, input validation, or operation mapping.
- Display `respond` and planner operations as routing capabilities, not tools. Show the empty `backend_tool` mechanism as “extension point” only if useful; do not display a fake configured tool.

### What must remain built-in

Keep tenant scoping, active-version checks, actor context, Zod validation, SQL parameterization, output bounds, authorization and timeout/error policy in trusted code. Keep destructive document APIs and other write operations internal unless they receive separate scoped authorization, confirmation and audit controls. A future tool UI can toggle policy-controlled availability, but cannot be the security boundary.

### Future dynamic HTTP/API tools

Use a typed registry record with immutable ID/version, display metadata, input/output JSON Schema, connection/secret reference, allowed host/method/path policy, tenant scope, permission policy, timeout/rate/body limits, and audit metadata. Store secrets in a secret manager, never registry JSON or prompts. Validate model arguments against schema, authorize the principal, construct requests from allowlisted endpoints, block arbitrary URLs/private-network SSRF, redact credentials and payloads from logs, validate/limit responses, and return bounded data. Register approved definitions as Mastra tools (or adapt into the existing `BackendTools` abstraction) so normal Mastra/workflow execution stays intact. Provide per-tenant enablement, versioning, test/preview, audit trail and safe rollout. Do not permit arbitrary code execution or arbitrary URL fetching as the initial tool type.

## Files and functions inspected

- `src/mastra/factory.ts` — `createSitePilotAgent`, six `createTool()` declarations, descriptions/schemas, Agent tool attachment and direct-agent instructions.
- `src/agent/agent.workflow.ts` — `createPlanSchema`, `planSchema`, `planLLMSchema`, `explicitAnalytics`, `createAgentWorkflow`, planner prompt, `request-context-and-plan`, `authorized-discovery-execution-evidence`, `invoke`, search/grounding/finalization dispatch.
- `src/agent/backend-tools.ts` — `backendCallSchema`, `backendCallLLMSchema`, `BackendTools.register`, `.catalog`, `.execute`.
- `src/agent/agent.service.ts` — `AgentService.ask`, `askWorkflow`, `stream`, direct/legacy Agent creation and workflow selection.
- `src/agent/agent.controller.ts` — bearer-authenticated `/api/agent/ask` and `/api/agent/stream` routes.
- `src/agent/agent.module.ts` — registers `BackendTools` as a provider and exports it; no concrete tool registration found.
- `src/typegraph/typegraph.service.ts` — `searchDocuments`, `listDocuments`, active-version and tenant/actor filtering; also internal document deletion services not exposed as Agent tools.
- `src/documents/structured-data.service.ts` — `discoverDatasets`, `lookup`, `lookupRows`, `aggregate`, `countRecords`; tenant/active-version-scoped read queries.
- `src/agent/structured-selection.ts` — selection and cell filter schemas.
- `src/llm-admin/llm-admin.service.ts` — provider model discovery, not callable by the Agent.

## GitNexus notes

Registered repository: `agent` at `/Users/ali/Desktop/agent`; index is one commit behind. GitNexus query surfaced `createAgentWorkflow`, `BackendTools`, `TypegraphService`, and `StructuredDataService` execution paths, supporting the source trace. Because the index is stale, negative conclusions (notably “no dynamic loader”) were confirmed using repository-wide `rg` for `createTool(`, `BackendTools.register`, tool IDs, and HTTP client usage under `src/agent` and `src/mastra`.
