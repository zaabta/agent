ALTER TABLE "messages"
ADD COLUMN "evidence_references" JSONB NOT NULL DEFAULT '[]'::jsonb;
