CREATE TABLE "custom_tool_connection_credentials" (
    "id" UUID NOT NULL,
    "profile_id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "auth_strategy" VARCHAR(40) NOT NULL,
    "access_token_ciphertext" TEXT NOT NULL,
    "access_token_iv" TEXT NOT NULL,
    "access_token_auth_tag" TEXT NOT NULL,
    "refresh_cookie_ciphertext" TEXT NOT NULL,
    "refresh_cookie_iv" TEXT NOT NULL,
    "refresh_cookie_auth_tag" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "last_refreshed_at" TIMESTAMP(3),
    "credential_version" INTEGER NOT NULL DEFAULT 1,
    "refresh_lease_id" UUID,
    "refresh_lease_until" TIMESTAMP(3),
    "auth_status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "custom_tool_connection_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "custom_tool_connection_credentials_profile_id_name_key" ON "custom_tool_connection_credentials"("profile_id", "name");
CREATE INDEX "custom_tool_connection_credentials_profile_id_auth_status_idx" ON "custom_tool_connection_credentials"("profile_id", "auth_status");
ALTER TABLE "custom_tools" ADD COLUMN "connection_credential_id" UUID, ADD COLUMN "allowed_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "custom_tools_connection_credential_id_idx" ON "custom_tools"("connection_credential_id");
ALTER TABLE "custom_tools" ADD CONSTRAINT "custom_tools_connection_credential_id_fkey" FOREIGN KEY ("connection_credential_id") REFERENCES "custom_tool_connection_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;