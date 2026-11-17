CREATE TABLE "planner_diagnostics" (
  "request_id" VARCHAR(36) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "available_tool_ids" JSONB NOT NULL DEFAULT '[]',
  "selected_operation" VARCHAR(40) NOT NULL,
  "selected_tool_id" VARCHAR(120),
  "schema_validation_outcome" VARCHAR(24) NOT NULL,
  "argument_schema_validation_outcome" VARCHAR(24),
  "fallback_reason" VARCHAR(80),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planner_diagnostics_pkey" PRIMARY KEY ("request_id")
);

CREATE INDEX "planner_diagnostics_tenant_id_created_at_idx" ON "planner_diagnostics"("tenant_id", "created_at" DESC);
CREATE INDEX "planner_diagnostics_created_at_idx" ON "planner_diagnostics"("created_at");
