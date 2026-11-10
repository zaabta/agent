# Document processing API

The API and worker are separate processes. Both need the same PostgreSQL database, Redis URL, and durable `UPLOAD_DIR` filesystem. In a multi-host deployment, mount that private durable directory at the same path in both processes. Upload bytes and parsed document text are never sent to Redis.

```powershell
pnpm dev
pnpm worker
```

Local Redis is available through Compose at `127.0.0.1:6391`; set `REDIS_URL` if the port differs. The API defaults to a private `.sitepilot-data/uploads` directory, limits one file to `MAX_FILE_BYTES`, and limits batches with `MAX_BATCH_FILES` and `MAX_BATCH_BYTES`. Uploaded objects are named with random opaque identifiers and are not exposed in API responses.

## Upload

`POST /api/documents/upload` accepts multipart field `file`. `POST /api/documents/upload-batch` accepts repeated multipart field `files`. Both require `x-api-key` and return `202 Accepted` with document/job metadata, not file bytes. The batch response contains per-file `accepted` and `rejected` lists. Reuploading the same content for the tenant returns its existing document and job.

```json
{
  "document": {
    "id": "<document UUID>",
    "filename": "pricing.md",
    "fileType": "md",
    "status": "queued",
    "stage": "queued",
    "jobId": "<job UUID>"
  },
  "duplicate": false
}
```

Supported extensions: `.md`, `.txt`, `.docx`, `.pdf`, `.xlsx`, `.xls`, `.csv`. Scanned PDFs fail with `OCR_REQUIRED`; no OCR service is configured. Excel formulas are stored as formulas plus the workbook's cached display value; formulas are never evaluated. CSV and spreadsheet rows/cells are also recorded in Prisma for exact identifier lookup. Semantic and hybrid RAG indexing remains exclusively in TypeGraph.

## Job status and SSE

- `GET /api/jobs/{jobId}` returns the latest tenant-scoped status.
- `GET /api/jobs/{jobId}/events` emits `status`, `completed`, `failed`, and `cancelled` events. Each `data` object contains only job/document IDs, state, stage, measured progress, retry count, failure code, and timestamps. No document text, private path, stack trace, or Redis payload is sent.
- `POST /api/jobs/{jobId}/cancel` removes a waiting job or sets a cancellation request for an active job.
- `DELETE /api/documents/{id}` cancels processing or removes the document's TypeGraph index and Prisma metadata.

`GET /api/documents` and `GET /api/documents/{id}` retain the machine-readable `status` and `stage` fields and add `statusPresentation: { label, detail, tone }` for display. Render this as the primary status; render `versionLabel` separately (for example, `Active version`). A cancelled file is labelled `Cancelled`, never `Processing · cancelled`.

SSE sends the latest snapshot immediately, sends a new event when it changes, uses `id` from `updatedAt`, and accepts reconnects by replaying the current snapshot. It does not retain event history; clients can always refresh from the status endpoint.

## Structured exact lookup

The Mastra `structuredDataLookup` tool is for exact cell values in CSV/Excel data. It is backed by tenant-scoped Prisma cell records and returns the matching row with a source reference. It does not perform semantic or vector retrieval. Other document-content questions use the TypeGraph `documentSearch` tool.

Swagger is available at `http://127.0.0.1:3220/api/docs` outside production. Production disables Swagger. The OpenAPI document describes the API key header, multipart schemas, responses, and SSE event names.
