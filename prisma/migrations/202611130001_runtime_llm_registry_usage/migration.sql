CREATE TABLE "runtime_settings" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "updated_by" TEXT,
  CONSTRAINT "runtime_settings_pkey" PRIMARY KEY ("key")
);
CREATE TABLE "registered_models" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "display_name" TEXT,
  "compatible" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "available" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "registered_models_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "registered_models_provider_model_id_key" ON "registered_models"("provider", "model_id");
CREATE INDEX "registered_models_provider_available_compatible_idx" ON "registered_models"("provider", "available", "compatible");
CREATE TABLE "llm_usage" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "total_tokens" INTEGER,
  "cached_tokens" INTEGER,
  "reasoning_tokens" INTEGER,
  "usage_source" TEXT,
  "accuracy" TEXT NOT NULL DEFAULT 'unavailable',
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT,
  "conversation_id" UUID,
  "logical_request_id" TEXT NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "latency_ms" INTEGER,
  "error_category" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "llm_usage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "llm_usage_invocation_id_key" ON "llm_usage"("invocation_id");
CREATE INDEX "llm_usage_tenant_id_created_at_idx" ON "llm_usage"("tenant_id", "created_at");
CREATE INDEX "llm_usage_provider_model_id_created_at_idx" ON "llm_usage"("provider", "model_id", "created_at");
