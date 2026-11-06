import 'dotenv/config';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}; see .env.example`);
  return v;
}
const modelProvider = process.env.MASTRA_PROVIDER ||
  (process.env.MASTRA_MODEL?.startsWith('openrouter/') ? 'openrouter' : 'ollama');
const model = process.env.MASTRA_MODEL ||
  (modelProvider === 'ollama' ? 'qwen3:8b' : 'openrouter/qwen/qwen3.6-plus:free');
const configuredTypegraphMinScore = Number(process.env.TYPEGRAPH_MIN_SCORE ?? 0.32);

export const config = {
  port: Number(process.env.PORT || 3220),
  databaseUrl: process.env.DATABASE_URL || 'postgres://sitepilot:sitepilot@localhost:5444/sitepilot',
  tenantId: process.env.DEV_TENANT_ID || 'demo-workspace',
  ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  embedDimensions: Number(process.env.OLLAMA_EMBED_DIMENSIONS || 768),
  typegraphRerank: process.env.TYPEGRAPH_RERANK === 'true',
  typegraphGraphExtraction: process.env.TYPEGRAPH_GRAPH_EXTRACTION === 'true',
  typegraphMinScore: Number.isFinite(configuredTypegraphMinScore)
    ? Math.min(1, Math.max(0, configuredTypegraphMinScore))
    : 0.32,
  modelProvider,
  model,
  ollamaThink: process.env.OLLAMA_THINK === 'true',
  maxBytes: Number(process.env.MAX_FILE_BYTES || 10485760),
  uploadDir: process.env.UPLOAD_DIR || '.sitepilot-data/uploads',
  maxBatchFiles: Math.min(20, Math.max(1, Number(process.env.MAX_BATCH_FILES || 10))),
  maxBatchBytes: Number(process.env.MAX_BATCH_BYTES || 52428800),
  maxTenantDocuments: Math.max(1, Number(process.env.MAX_TENANT_DOCUMENTS || 1000)),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6391',
  documentQueue: process.env.DOCUMENT_QUEUE || 'sitepilot-document-processing',
  documentWorkerConcurrency: Math.min(8, Math.max(1, Number(process.env.DOCUMENT_WORKER_CONCURRENCY || 2))),
  documentJobAttempts: Math.min(5, Math.max(1, Number(process.env.DOCUMENT_JOB_ATTEMPTS || 3))),
  agentTimeoutMs: Number(process.env.AGENT_REQUEST_TIMEOUT_MS || 180000),
  conversationOwnerId: process.env.DEV_CONVERSATION_OWNER_ID || 'dev-shared-api-key',
  conversationHistoryMessages: Math.max(0, Number(process.env.AGENT_HISTORY_MESSAGES || 10)),
  conversationHistoryChars: Math.max(256, Number(process.env.AGENT_HISTORY_MESSAGE_CHARS || 3000)),
};
