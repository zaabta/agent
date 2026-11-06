CREATE TABLE "document_progress_events" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "completed_units" INTEGER,
    "total_units" INTEGER,
    "embedding_duration_ms" INTEGER,
    "unit" TEXT,
    "failure_code" TEXT,
    CONSTRAINT "document_progress_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_progress_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "app_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "document_progress_events_tenant_id_job_id_started_at_idx" ON "document_progress_events"("tenant_id", "job_id", "started_at");
CREATE INDEX "document_progress_events_document_id_attempt_started_at_idx" ON "document_progress_events"("document_id", "attempt", "started_at");
