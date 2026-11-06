# Document ingestion progress integration

The React frontend is a separate repository. This contract describes how it should display upload and processing progress without treating upload acceptance as indexing completion.

## Upload request

`POST /api/documents/upload` remains authenticated multipart form data and returns `202` with the document/job identifiers. The API receives the entire multipart body before Multer calls the controller. Consequently, the backend's initial `upload` event records the actual `file.size` bytes received, but is not a live upload-network feed. For browser upload progress, use `XMLHttpRequest.upload.onprogress` (or an equivalent transport that exposes upload progress) and display it separately from the backend job progress. Do not interpret HTTP `202` as indexed.

## Job snapshot

`GET /api/jobs/{jobId}` remains tenant scoped and preserves its existing top-level `progress` percentage (nullable). Structured data is added in `progressDetails`:

```json
{
  "progressDetails": {
    "stage": "indexing",
    "status": "processing",
    "stagePercent": null,
    "overallPercent": null,
    "completedUnits": null,
    "totalUnits": null,
    "unit": null,
    "attempt": 1,
    "retryCount": 0,
    "startedAt": "2026-11-06T09:00:00.000Z",
    "finishedAt": null,
    "elapsedMs": 4200,
    "etaMs": null,
    "stages": []
  },
  "queue": { "state": "active", "consistency": "consistent", "attemptsMade": 0, "attemptsMax": 3 }
}
```

The example is illustrative, not a promised live state. `stagePercent`, unit totals and ETA are nullable. `queue.consistency` explicitly labels the Redis/Prisma view as `consistent`, `transitioning` (a write boundary is in flight), or `unknown` (the retained queue record cannot be read). Indexing is owned by TypeGraph SDK, whose installed integration currently does not expose incremental chunk or embedding callbacks; it reports chunk totals only after ingest completes. Thus the UI should show an indeterminate indexing state and must not synthesize percentages or ETA. On completion, the API reports `overallPercent: 100` and keeps the legacy `progress: 100` only after TypeGraph reports complete, structured cells are persisted, and the application document state is committed.

Each `progressDetails.stages[]` item contains a durable `id`, `stage`, `status`, `attempt`, `startedAt`, `finishedAt`, `elapsedMs`, a nullable `stagePercent`, optional measured unit counts, and a sanitized `failureCode`. Current measured stages are received upload bytes, upload-time validation, queue wait, worker integrity verification, parsing, aggregate TypeGraph indexing, commit, and terminal completion. TypeGraph's internal chunking and embedding are not represented as separate stages because no callbacks are exposed at this integration boundary. After ingestion completes, the indexing event includes TypeGraph's measured aggregate embedding duration and a derived chunk/embedding-second rate; this is retrospective and is not used as in-flight progress or ETA.

## SSE

`GET /api/jobs/{jobId}/events` keeps the existing event stream and sends an initial `status` snapshot, `stage` transitions, later `status` snapshots, terminal `completed` / `failed` / `cancelled` snapshots, and comment keepalives. Stage transition events use persisted event UUIDs as SSE IDs. Reconnect with the standard `Last-Event-ID` request header to replay subsequent persisted transitions. If the ID is unknown or has aged out of the bounded snapshot history, the server sends available transitions and a current snapshot; this is not an unlimited event log. Disconnect closes the polling loop. Every lookup is scoped to the authenticated tenant, and payloads do not include document contents.

## Consistency boundary

BullMQ/Redis owns queue execution, locks, retries and stalled-job recovery. Prisma owns tenant-scoped application status and durable stage-transition history. TypeGraph owns document chunks and search indexes. The API treats Prisma state as completed only after the TypeGraph SDK reports complete and the application commit succeeds. Redis progress is an inspectable queue-side snapshot; it is not the durable replay source. If TypeGraph or Prisma is unavailable during a commit, the BullMQ attempt fails and normal retry policy applies. No TypeGraph internal table is read or modified through Prisma.

## UI behavior

- Show browser upload bytes and backend job processing as separate progress sections.
- For `overallPercent: null`, render an indeterminate progress indicator.
- Render stage timestamps/counters from `progressDetails.stages`; show retry attempt and sanitized failure code.
- Confirm “indexed” only for `status: ready` / `stage: completed`.
- Reconnect SSE with `Last-Event-ID`; always reconcile with `GET /api/jobs/{jobId}` after reconnect.

## Administrative monitoring APIs

All `/api/admin/workers/*` routes require a JWT with the explicit `TENANT_ADMIN` or `SUPER_ADMIN` role. They do not accept a caller-supplied tenant ID. Tenant job lists, details, and event history are restricted to the authenticated principal's tenant; only aggregate queue counters and worker process health are global. Worker health does not expose active job IDs.

- `GET /api/admin/workers/overview` — retained queue counts, bounded worker health snapshots, and this tenant's document-state totals.
- `GET /api/admin/workers/health` — worker heartbeat state (`busy`, `idle`, `disconnected`, `stale`, or `unknown`), process CPU/RSS/heap and host memory labels.
- `GET /api/admin/workers/jobs?page=1&limit=25&status=processing` — tenant-scoped, maximum 100 rows per page.
- `GET /api/admin/workers/jobs/{jobId}` — tenant-scoped job and up to 100 sanitized stage records.
- `GET /api/admin/workers/metrics?windowMinutes=60` — retained counts and a bounded sample of up to 1000 completed/failed jobs; window throughput, retries, queue wait, processing duration and failure rate are sample-based. Lifetime totals are unavailable because BullMQ retention removes old jobs.
- `GET /api/admin/workers/events?hours=24` — at most 100 recent tenant-scoped stage events (1–168 hour window).

Worker heartbeats run in a Node worker thread so synchronous parsing on the ingestion event loop does not suppress heartbeat updates. Worker CPU/RSS/heap describe the worker process; free/total memory describe the host. Embedding throughput is only shown retrospectively after TypeGraph returns both a measured embedding duration and final chunk count; it is not an in-flight rate.
