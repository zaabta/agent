ALTER TABLE "registered_models"
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "local" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "validation_status" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "context_length" INTEGER;
ALTER TABLE "llm_usage" ADD COLUMN "configured_model_id" TEXT;

CREATE TABLE "runtime_setting_audit" (
  "id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "old_value" TEXT,
  "new_value" TEXT NOT NULL,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_setting_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "runtime_setting_audit_key_created_at_idx" ON "runtime_setting_audit"("key", "created_at" DESC);
