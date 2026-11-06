ALTER TABLE "app_documents"
  ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN "progress" INTEGER,
  ADD COLUMN "job_id" TEXT,
  ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "file_size" BIGINT,
  ADD COLUMN "checksum" TEXT,
  ADD COLUMN "storage_key" TEXT,
  ADD COLUMN "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "delete_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "completed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "app_documents_job_id_key" ON "app_documents"("job_id");
CREATE UNIQUE INDEX "app_documents_tenant_id_checksum_key" ON "app_documents"("tenant_id", "checksum");
CREATE INDEX "app_documents_tenant_id_status_created_at_idx" ON "app_documents"("tenant_id", "status", "created_at" DESC);
