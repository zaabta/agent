ALTER TABLE "conversations"
  ADD COLUMN "title" VARCHAR(120),
  ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "conversations_tenant_id_owner_id_deleted_at_updated_at_idx"
  ON "conversations"("tenant_id", "owner_id", "deleted_at", "updated_at" DESC);

DROP INDEX IF EXISTS "conversations_tenant_id_owner_id_updated_at_idx";
