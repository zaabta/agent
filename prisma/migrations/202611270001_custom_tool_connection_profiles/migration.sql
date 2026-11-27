CREATE TABLE "custom_tool_connection_profiles" (
  "tenant_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "base_url" TEXT NOT NULL,
  "auth_strategy" VARCHAR(40) NOT NULL DEFAULT 'NONE',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_tool_connection_profiles_pkey" PRIMARY KEY ("tenant_id", "id")
);
CREATE INDEX "custom_tool_connection_profiles_tenant_id_enabled_idx" ON "custom_tool_connection_profiles"("tenant_id", "enabled");
