CREATE TABLE "app_document_versions" (
  "id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "version_number" INTEGER NOT NULL,
  "filename" TEXT NOT NULL,
  "checksum" TEXT,
  "file_size" BIGINT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploaded_by" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "indexed_chunk_count" INTEGER NOT NULL DEFAULT 0,
  "chunking_strategy" TEXT,
  "chunker_version" TEXT,
  "embedding_model" TEXT,
  "embedding_dimensions" INTEGER,
  "storage_key" TEXT,
  "job_id" TEXT,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT FALSE,
  "publish_requested" BOOLEAN NOT NULL DEFAULT FALSE,
  "replacement_reason" TEXT,
  "index_generation" INTEGER NOT NULL DEFAULT 1,
  "active_index_generation" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_document_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "app_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "app_document_versions_document_id_version_number_key" ON "app_document_versions"("document_id", "version_number");
CREATE UNIQUE INDEX "app_document_versions_document_id_checksum_key" ON "app_document_versions"("document_id", "checksum");
CREATE UNIQUE INDEX "app_document_versions_job_id_key" ON "app_document_versions"("job_id");
CREATE INDEX "app_document_versions_tenant_id_document_id_uploaded_at_idx" ON "app_document_versions"("tenant_id", "document_id", "uploaded_at" DESC);

ALTER TABLE "app_documents" ADD COLUMN "active_version_id" UUID;

-- Existing documents receive immutable version 1 metadata without changing their indexing state.
INSERT INTO "app_document_versions" (
  "id", "document_id", "tenant_id", "version_number", "filename", "checksum", "file_size", "mime_type",
  "uploaded_at", "status", "indexed_chunk_count", "chunking_strategy", "chunker_version", "created_at", "updated_at"
)
SELECT gen_random_uuid(), d."id", d."tenant_id", 1, d."filename", d."checksum",
       COALESCE(d."file_size", 0), CASE WHEN d."file_type" = 'pdf' THEN 'application/pdf' ELSE 'application/octet-stream' END,
       d."created_at", d."status", 0, 'legacy', 'legacy-0', d."created_at", d."updated_at"
FROM "app_documents" d;

UPDATE "app_documents" d SET "active_version_id" = v."id"
FROM "app_document_versions" v WHERE v."document_id" = d."id" AND d."status" = 'ready';

ALTER TABLE "app_document_cells" ADD COLUMN "version_id" UUID;
UPDATE "app_document_cells" c SET "version_id" = d."active_version_id"
FROM "app_documents" d WHERE d."id" = c."document_id";
DROP INDEX "app_document_cells_document_id_sheet_name_address_key";
CREATE UNIQUE INDEX "app_document_cells_document_id_version_id_sheet_name_address_key"
  ON "app_document_cells"("document_id", "version_id", "sheet_name", "address");
DROP INDEX "app_document_cells_tenant_id_document_id_sheet_name_row_number_idx";
CREATE INDEX "app_document_cells_tenant_id_document_id_version_id_sheet_name_row_number_idx"
  ON "app_document_cells"("tenant_id", "document_id", "version_id", "sheet_name", "row_number");
