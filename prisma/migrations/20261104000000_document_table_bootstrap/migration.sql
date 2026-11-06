-- Phase 4's additive metadata migration has a timestamp before the original
-- app_documents creation migration. Create the base table conditionally so a
-- fresh database can safely apply that earlier migration first. The original
-- init migration uses IF NOT EXISTS and remains authoritative for this schema.
CREATE TABLE IF NOT EXISTS "app_documents" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "file_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "app_documents_tenant_id_created_at_idx" ON "app_documents"("tenant_id", "created_at" DESC);
