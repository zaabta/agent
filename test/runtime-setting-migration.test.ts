import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('LangGraph settings migration renames shared model values and audit keys without losing current settings', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TIMESTAMP(3) NOT NULL);
      CREATE TABLE runtime_setting_audit (id UUID PRIMARY KEY, key TEXT NOT NULL, old_value TEXT, new_value TEXT NOT NULL, updated_by TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO runtime_settings VALUES
        ('MASTRA_PROVIDER', 'google', NULL, '2026-01-01'),
        ('MASTRA_MODEL', 'gemini-test', NULL, '2026-01-01'),
        ('MASTRA_FALLBACK_MODEL', 'obsolete-model', NULL, '2026-01-01'),
        ('AGENT_PROVIDER', 'openai', NULL, '2026-02-01');
      INSERT INTO runtime_setting_audit (id, key, new_value) VALUES
        ('00000000-0000-4000-8000-000000000001', 'MASTRA_PROVIDER', 'google'),
        ('00000000-0000-4000-8000-000000000002', 'MASTRA_MODEL', 'gemini-test');
    `);
    await db.exec(await readFile(new URL('../prisma/migrations/202611260001_langgraph_model_settings/migration.sql', import.meta.url), 'utf8'));
    const settings = await db.query<{ key: string; value: string }>('SELECT key, value FROM runtime_settings ORDER BY key');
    assert.deepEqual(settings.rows, [
      { key: 'AGENT_MODEL', value: 'gemini-test' },
      { key: 'AGENT_PROVIDER', value: 'openai' },
    ]);
    const audit = await db.query<{ key: string }>('SELECT key FROM runtime_setting_audit ORDER BY key');
    assert.deepEqual(audit.rows, [{ key: 'AGENT_MODEL' }, { key: 'AGENT_PROVIDER' }]);
  } finally {
    await db.close();
  }
});
