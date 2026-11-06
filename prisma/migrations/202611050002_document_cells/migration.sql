CREATE TABLE "app_document_cells" (
  "id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "sheet_name" TEXT NOT NULL,
  "row_number" INTEGER NOT NULL,
  "address" TEXT NOT NULL,
  "column_name" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "value_type" TEXT NOT NULL,
  "formula" TEXT,
  CONSTRAINT "app_document_cells_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_document_cells_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "app_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "app_document_cells_document_id_sheet_name_address_key" ON "app_document_cells"("document_id", "sheet_name", "address");
CREATE INDEX "app_document_cells_tenant_id_value_idx" ON "app_document_cells"("tenant_id", "value");
CREATE INDEX "app_document_cells_tenant_id_document_id_sheet_name_row_number_idx" ON "app_document_cells"("tenant_id", "document_id", "sheet_name", "row_number");
