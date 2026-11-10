CREATE TABLE "conversation_contexts" (
    "conversation_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "summary" TEXT,
    "evidence_refs" JSONB NOT NULL DEFAULT '[]',
    "active_selection" JSONB,
    "entities" JSONB NOT NULL DEFAULT '[]',
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversation_contexts_pkey" PRIMARY KEY ("conversation_id"),
    CONSTRAINT "conversation_contexts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "conversation_contexts_tenant_id_owner_id_updated_at_idx"
  ON "conversation_contexts"("tenant_id", "owner_id", "updated_at" DESC);

CREATE TABLE "user_memories" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" VARCHAR(500) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_memories_tenant_id_user_id_deleted_at_updated_at_idx"
  ON "user_memories"("tenant_id", "user_id", "deleted_at", "updated_at" DESC);
