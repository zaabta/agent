CREATE TABLE "custom_tool_secrets" (
  "id" UUID NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "auth_tag" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "custom_tool_secrets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "custom_tools" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'HTTP_GET',
  "connection_profile" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "query_mappings" JSONB NOT NULL DEFAULT '{}',
  "allowed_result_sources" JSONB NOT NULL DEFAULT '[]',
  "input_schema" JSONB NOT NULL,
  "output_schema" JSONB NOT NULL,
  "auth_header_name" TEXT,
  "auth_prefix" TEXT,
  "auth_secret_id" UUID,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "effect_classification" TEXT NOT NULL DEFAULT 'READ_ONLY',
  "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
  "max_response_bytes" INTEGER NOT NULL DEFAULT 65536,
  "configuration_version" INTEGER NOT NULL DEFAULT 1,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "custom_tools_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "custom_tool_executions" (
  "id" UUID NOT NULL,
  "tool_id" UUID NOT NULL,
  "tool_version" INTEGER NOT NULL,
  "logical_request_id" TEXT NOT NULL,
  "conversation_id" UUID,
  "user_id" TEXT,
  "latency_ms" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "error_category" TEXT,
  "is_test" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "custom_tool_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_tools_name_key" ON "custom_tools"("name");
CREATE UNIQUE INDEX "custom_tools_auth_secret_id_key" ON "custom_tools"("auth_secret_id");
CREATE INDEX "custom_tools_enabled_archived_at_idx" ON "custom_tools"("enabled", "archived_at");
CREATE INDEX "custom_tools_updated_at_idx" ON "custom_tools"("updated_at" DESC);
CREATE INDEX "custom_tool_executions_tool_id_created_at_idx" ON "custom_tool_executions"("tool_id", "created_at" DESC);
CREATE INDEX "custom_tool_executions_logical_request_id_idx" ON "custom_tool_executions"("logical_request_id");
CREATE INDEX "custom_tool_executions_conversation_id_created_at_idx" ON "custom_tool_executions"("conversation_id", "created_at" DESC);
ALTER TABLE "custom_tools" ADD CONSTRAINT "custom_tools_auth_secret_id_fkey" FOREIGN KEY ("auth_secret_id") REFERENCES "custom_tool_secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "custom_tool_executions" ADD CONSTRAINT "custom_tool_executions_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "custom_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
