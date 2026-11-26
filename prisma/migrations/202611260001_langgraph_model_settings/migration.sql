INSERT INTO "runtime_settings" ("key", "value", "updated_by", "updated_at")
SELECT CASE "key"
         WHEN 'MASTRA_PROVIDER' THEN 'AGENT_PROVIDER'
         WHEN 'MASTRA_MODEL' THEN 'AGENT_MODEL'
       END,
       "value", "updated_by", "updated_at"
FROM "runtime_settings"
WHERE "key" IN ('MASTRA_PROVIDER', 'MASTRA_MODEL')
ON CONFLICT ("key") DO NOTHING;

DELETE FROM "runtime_settings"
WHERE "key" IN ('MASTRA_PROVIDER', 'MASTRA_MODEL', 'MASTRA_FALLBACK_MODEL');

UPDATE "runtime_setting_audit"
SET "key" = CASE "key"
              WHEN 'MASTRA_PROVIDER' THEN 'AGENT_PROVIDER'
              WHEN 'MASTRA_MODEL' THEN 'AGENT_MODEL'
            END
WHERE "key" IN ('MASTRA_PROVIDER', 'MASTRA_MODEL');
