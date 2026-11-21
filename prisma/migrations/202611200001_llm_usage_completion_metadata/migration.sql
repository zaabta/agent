ALTER TABLE "llm_usage"
  ADD COLUMN "finish_reason" TEXT,
  ADD COLUMN "max_output_tokens" INTEGER;
