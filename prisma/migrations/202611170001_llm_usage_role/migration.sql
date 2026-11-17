ALTER TABLE "llm_usage" ADD COLUMN "role" VARCHAR(12);
CREATE INDEX "llm_usage_tenant_id_role_created_at_idx" ON "llm_usage"("tenant_id", "role", "created_at");
