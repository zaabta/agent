CREATE TABLE "provider_credentials" (
    "provider" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("provider")
);
