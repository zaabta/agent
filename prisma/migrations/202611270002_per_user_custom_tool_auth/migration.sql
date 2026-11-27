ALTER TABLE "custom_tool_connection_profiles"
  ADD COLUMN "token_url" TEXT,
  ADD COLUMN "client_id" TEXT;

ALTER TABLE "custom_tool_connection_credentials"
  ADD COLUMN "tenant_id" TEXT NOT NULL DEFAULT '*',
  ADD COLUMN "user_id" TEXT NOT NULL DEFAULT '*',
  ADD COLUMN "refresh_token_ciphertext" TEXT,
  ADD COLUMN "refresh_token_iv" TEXT,
  ADD COLUMN "refresh_token_auth_tag" TEXT;
ALTER TABLE "custom_tool_connection_credentials"
  ALTER COLUMN "refresh_cookie_ciphertext" DROP NOT NULL,
  ALTER COLUMN "refresh_cookie_iv" DROP NOT NULL,
  ALTER COLUMN "refresh_cookie_auth_tag" DROP NOT NULL;

DROP INDEX "custom_tool_connection_credentials_profile_id_name_key";
CREATE UNIQUE INDEX "custom_tool_connection_credentials_profile_id_name_tenant_id_user_id_key"
  ON "custom_tool_connection_credentials"("profile_id", "name", "tenant_id", "user_id");

ALTER TABLE "custom_tools" ADD COLUMN "auth_scope" VARCHAR(16) NOT NULL DEFAULT 'NONE';
UPDATE "custom_tools" SET "auth_scope" = 'SHARED'
  WHERE "auth_secret_id" IS NOT NULL OR "connection_credential_id" IS NOT NULL;
