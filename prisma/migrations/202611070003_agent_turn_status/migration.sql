ALTER TABLE "messages"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN "stage" TEXT;

CREATE INDEX "messages_conversation_id_status_created_at_idx"
  ON "messages"("conversation_id", "status", "created_at");
