# Document ingestion progress integration

The React frontend is a separate repository. This contract describes how it should display upload and processing progress without treating upload acceptance as indexing completion.

## Upload request

`POST /api/documents/upload` remains authenticated multipart form data and returns `202` with `{ document, duplicate, version }`; use `version.jobId` (or `document.jobId` for compatibility) to track the job. The API receives the entire multipart body before Multer calls the controller. Consequently, the backend's initial `upload` event records the actual `file.size` bytes received, but is not a live upload-network feed. For browser upload progress, use `XMLHttpRequest.upload.onprogress` (or an equivalent transport that exposes upload progress) and display it separately from the backend job progress. Do not interpret HTTP `202` as indexed.

## Job snapshot

`GET /api/jobs/{jobId}` remains tenant scoped. `progress` is the same coarse overall estimate as `progressDetails.overallPercent`; it is no longer null during known processing stages. `progressDetails.stagePercent` is measured only when the current stage has unit counters. A stage without counters is indeterminate, not unavailable. Example:

```json
{
  "progressDetails": {
    "stage": "indexing",
    "status": "processing",
    "stagePercent": 64,
    "stageProgressMode": "measured",
    "overallPercent": 65,
    "overallProgressMode": "estimated",
    "completedUnits": 64,
    "totalUnits": 100,
    "remainingUnits": 36,
    "unit": "chunks",
    "unitsPerSecond": 8.4,
    "stageRemainingPercent": 36,
    "remainingPercent": 35,
    "attempt": 1,
    "retryCount": 0,
    "startedAt": "2026-11-06T09:00:00.000Z",
    "finishedAt": null,
    "elapsedMs": 4200,
    "etaMs": 4286,
    "stages": []
  },
  "queue": { "state": "active", "consistency": "consistent", "attemptsMade": 0, "attemptsMax": 3 }
}
```

The example is illustrative. `stagePercent`, unit totals, speed, remaining units and ETA are nullable when the current phase does not expose measurable counters. `stageProgressMode` is `measured` or `indeterminate`; `overallProgressMode` is `estimated`, `indeterminate`, or `complete`. Overall percentage maps pipeline stages to coarse ranges and is explicitly an estimate, not a byte-accurate fraction of all remaining work. `remainingPercent` is overall estimated work remaining; `stageRemainingPercent` is current-stage remaining. ETA and units/second are derived from measured counters after at least two seconds of elapsed stage time. `queue.consistency` labels the Redis/Prisma view as `consistent`, `transitioning` (a write boundary is in flight), or `unknown` (the retained queue record cannot be read). TypeGraph progress callbacks report its fetch, hash-check, embed, store, and prune phases; the worker persists updates at phase changes and coalesces frequent updates to roughly 5% or two-second intervals. Parsing and chunk construction do not expose incremental counters, so show their stage label with indeterminate stage progress while the coarse overall estimate advances by pipeline stage. On completion, the API reports `overallPercent: 100` and `progress: 100` only after TypeGraph reports complete, structured cells are persisted, and the application document state is committed.

Each `progressDetails.stages[]` item contains a durable `id`, `stage`, `status`, `attempt`, `startedAt`, `finishedAt`, `elapsedMs`, nullable `stagePercent` and counters, optional unit/speed/remaining data, and a sanitized `failureCode`. Upload bytes are only confirmed once the request body reaches the backend; the browser owns live transfer progress. Indexing counters and ETA are available when TypeGraph/embedding callbacks expose totals.

PDF ingestion reports `parsing` while it measures per-page extractable-text coverage. Pages below the text-coverage threshold report `pdf_rendering` and `vision_extraction` with page counters when `OLLAMA_VISION_MODEL` is configured; searchable pages retain native text without OCR. OCR configuration and model errors are terminal failures rather than queue retries. Successful OCR text keeps its physical `Page N` marker and flows through the same Smart Chunking and TypeGraph indexing stages as searchable PDF text.

## SSE

`GET /api/jobs/{jobId}/events` keeps the existing event stream and sends an initial `status` snapshot, `stage` transitions, later `status` snapshots, terminal `completed` / `failed` / `cancelled` snapshots, and comment keepalives. Stage transition events use persisted event UUIDs as SSE IDs. Reconnect with the standard `Last-Event-ID` request header to replay subsequent persisted transitions. If the ID is unknown or has aged out of the bounded snapshot history, the server sends available transitions and a current snapshot; this is not an unlimited event log. Disconnect closes the polling loop. Every lookup is scoped to the authenticated tenant, and payloads do not include document contents.

## Consistency boundary

BullMQ/Redis owns queue execution, locks, retries and stalled-job recovery. Prisma owns tenant-scoped application status and durable stage-transition history. TypeGraph owns document chunks and search indexes. The API treats Prisma state as completed only after the TypeGraph SDK reports complete and the application commit succeeds. Redis progress is an inspectable queue-side snapshot; it is not the durable replay source. If TypeGraph or Prisma is unavailable during a commit, the BullMQ attempt fails and normal retry policy applies. No TypeGraph internal table is read or modified through Prisma.

## UI behavior

- Show browser upload bytes and backend job processing as separate progress sections.
- Use browser upload-byte progress during transfer, then switch to the job snapshot after HTTP 202.
- Render `progress` / `overallPercent` as an explicitly estimated pipeline percentage; use `stagePercent` when measured and an indeterminate stage indicator when `stageProgressMode` is `indeterminate`.
- Show `completedUnits / totalUnits`, `unitsPerSecond`, `remainingUnits`, and `etaMs` only when non-null. Never present a null value as a permanent “progress unavailable” error.
- Render stage timestamps/counters from `progressDetails.stages`; show retry attempt and sanitized failure code.
- Confirm “indexed” only for `status: ready` / `stage: completed`.
- Reconnect SSE with `Last-Event-ID`; always reconcile with `GET /api/jobs/{jobId}` after reconnect.

## Administrative monitoring APIs

All `/api/admin/workers/*` routes require a JWT for the configured installation owner (`INSTALLATION_OWNER_USER_ID`). They do not accept a caller-supplied workspace identifier. Job lists, details, and event history remain scoped to the authenticated installation workspace; only aggregate queue counters and worker process health are global. Worker health does not expose active job IDs.

- `GET /api/admin/workers/overview` — retained queue counts, bounded worker health snapshots, and this tenant's document-state totals.
- `GET /api/admin/workers/health` — worker heartbeat state (`busy`, `idle`, `disconnected`, `stale`, or `unknown`), process CPU/RSS/heap and host memory labels.
- `GET /api/admin/workers/jobs?page=1&limit=25&status=processing` — tenant-scoped, maximum 100 rows per page.
- `GET /api/admin/workers/jobs/{jobId}` — tenant-scoped job and up to 100 sanitized stage records.
- `GET /api/admin/workers/metrics?windowMinutes=60` — retained counts and a bounded sample of up to 1000 completed/failed jobs; window throughput, retries, queue wait, processing duration and failure rate are sample-based. Lifetime totals are unavailable because BullMQ retention removes old jobs.
- `GET /api/admin/workers/events?hours=24` — at most 100 recent tenant-scoped stage events (1–168 hour window).

Worker heartbeats run in a Node worker thread so synchronous parsing on the ingestion event loop does not suppress heartbeat updates. Worker CPU/RSS/heap describe the worker process; free/total memory describe the host. Embedding throughput is only shown retrospectively after TypeGraph returns both a measured embedding duration and final chunk count; it is not an in-flight rate.
