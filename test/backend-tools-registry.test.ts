import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendTools } from '../src/agent/backend-tools.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { decryptCredential } from '../src/llm-admin/provider-credentials.js';

const toolId = 'f9237c78-64ae-40df-91c7-21e0915d2f15';
const dbTool = () => ({
  id: toolId, name: 'customer_search', displayName: 'Search customers', description: 'Search authorized CRM customers.',
  connectionProfile: 'crm', path: '/customers', queryMappings: { q: 'query' },
  inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  authHeaderName: null, authPrefix: null, authSecretId: 'secret-ref', authSecret: null,
  enabled: true, archivedAt: null, configurationVersion: 4, timeoutMs: 1000, maxResponseBytes: 4096,
  createdAt: new Date(0), updatedAt: new Date(0), createdBy: 'owner', updatedBy: 'owner',
});
const principal = { userId: 'user-1', tenantId: 'tenant-1', authMethod: 'jwt' as const };

test('custom catalog discovers enabled integrations independently of request keywords', async () => {
  const previous = process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
  process.env.CUSTOM_TOOL_CONNECTION_PROFILES = JSON.stringify({ crm: { baseUrl: 'https://api.example.com/v1', allowedHosts: ['api.example.com'] } });
  const rows = [
    dbTool(),
    { ...dbTool(), id: '11111111-1111-4111-8111-111111111111', name: 'disabled_tool', enabled: false },
    { ...dbTool(), id: '22222222-2222-4222-8222-222222222222', name: 'exchange_rate', description: 'Retrieve foreign exchange rates between currency codes.' },
  ];
  const prisma = { customTool: { findMany: async ({ where }: any) => rows.filter(row => (!where.enabled || row.enabled) && (!where.archivedAt || !row.archivedAt)) } };
  try {
    const tools = new BackendTools(prisma as unknown as PrismaService);
    const catalog = await tools.catalog(principal);
    assert.deepEqual(catalog.map(item => item.id), ['custom_f9237c7864ae40df91c721e0915d2f15', 'custom_22222222222242228222222222222222']);
    assert.equal((catalog[0] as any).version, 4);
    assert.equal(JSON.stringify(catalog).includes('secret-ref'), false);
    assert.equal(await tools.hasEnabledTools(principal), true);
    rows[1]!.enabled = true;
    assert.equal((await tools.catalog(principal)).length, 3);
    const empty = new BackendTools({ customTool: { findMany: async () => [] } } as unknown as PrismaService);
    assert.deepEqual(await empty.catalog(principal), []);
  } finally {
    if (previous === undefined) delete process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
    else process.env.CUSTOM_TOOL_CONNECTION_PROFILES = previous;
  }
});

test('custom execution rechecks enabled/version and logs only bounded metadata on validation failure', async () => {
  const previous = process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
  process.env.CUSTOM_TOOL_CONNECTION_PROFILES = JSON.stringify({ crm: { baseUrl: 'https://api.example.com/v1', allowedHosts: ['api.example.com'] } });
  const row = dbTool();
  const history: any[] = [];
  const prisma = {
    customTool: { findUnique: async () => row },
    customToolExecution: { create: async ({ data }: any) => history.push(data) },
  };
  const tools = new BackendTools(prisma as unknown as PrismaService);
  const call = { id: 'custom_f9237c7864ae40df91c721e0915d2f15', args: { query: 'private', extra: 'must-not-log' } };
  try {
    row.enabled = false;
    assert.equal(await tools.execute(call, principal), undefined);
    row.enabled = true;
    await assert.rejects(tools.execute(call, principal, undefined, undefined, { snapshotVersion: 3 }), /TOOL_CONFIGURATION_CHANGED/);
    const validation: string[] = [];
    await assert.rejects(tools.execute(call, principal, undefined, undefined, {
      logicalRequestId: 'request-1', conversationId: '00000000-0000-4000-8000-000000000001', snapshotVersion: 4,
      onSchemaValidation: outcome => validation.push(outcome),
    }), /INVALID_ARGUMENTS/);
    assert.deepEqual(validation, ['invalid']);
    assert.equal(history.length, 1);
    assert.equal(history[0].success, false);
    assert.equal(history[0].errorCategory, 'INVALID_ARGUMENTS');
    assert.equal(history[0].arguments, undefined);
    assert.equal('args' in history[0], false);
    assert.equal('output' in history[0], false);
  } finally {
    if (previous === undefined) delete process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
    else process.env.CUSTOM_TOOL_CONNECTION_PROFILES = previous;
  }
});

test('custom execution persists only schema-validated, redacted arguments with the request id', async () => {
  const previous = process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
  process.env.CUSTOM_TOOL_CONNECTION_PROFILES = JSON.stringify({ crm: { baseUrl: 'https://api.example.com/v1', allowedHosts: ['api.example.com'] } });
  const row = { ...dbTool(), inputSchema: {
    type: 'object', properties: {
      q: { type: 'string', maxLength: 100 }, apiKey: { type: 'string' }, contact: { type: 'string' },
    }, required: ['q', 'apiKey', 'contact'], additionalProperties: false,
  }, queryMappings: { q: 'q' }, path: '/../invalid', authSecretId: null };
  const history: any[] = [];
  const prisma = {
    customTool: { findUnique: async () => row },
    customToolExecution: { create: async ({ data }: any) => history.push(data) },
  };
  try {
    const tools = new BackendTools(prisma as unknown as PrismaService);
    const query = 'ابحث عن cafés في İstanbul';
    const call = { id: 'custom_f9237c7864ae40df91c721e0915d2f15', args: { q: query, apiKey: 'private-key-value', contact: 'user@example.com' } };
    await assert.rejects(tools.execute(call, principal, undefined, undefined, { logicalRequestId: 'request-ar-1' }), /INVALID_PATH/);
    assert.equal(history.length, 1);
    assert.equal(history[0].logicalRequestId, 'request-ar-1');
    assert.deepEqual(history[0].arguments, { q: query, apiKey: '[redacted]', contact: '[redacted]' });
    assert.equal(JSON.stringify(history[0]).includes('private-key-value'), false);
  } finally {
    if (previous === undefined) delete process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
    else process.env.CUSTOM_TOOL_CONNECTION_PROFILES = previous;
  }
});

test('owner-created full-endpoint tools generate parameter schemas and encrypt optional credentials', async () => {
  const previousKey = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const stored: any = { secrets: [], tool: null };
  const prisma = {
    $transaction: async (run: (tx: any) => Promise<any>) => run({
      customToolSecret: { create: async ({ data }: any) => stored.secrets.push(data) },
      customTool: { create: async ({ data }: any) => {
        stored.tool = { ...dbTool(), ...data, id: toolId, authSecretId: stored.secrets[0]?.id ?? null, enabled: false };
        return stored.tool;
      } },
      auditLog: { create: async () => undefined },
    }),
  };
  try {
    const tools = new BackendTools(prisma as unknown as PrismaService);
    const result = await tools.createCustomTool({
      name: 'weather_lookup', description: 'Look up current weather.', endpoint: 'https://8.8.8.8/v1/weather',
      parameters: [{ name: 'city', type: 'string', required: true, description: 'City to look up', queryParameter: 'q' }],
      auth: { headerName: 'X-API-Key', secret: 'test-secret-value-123' },
    }, 'owner');
    assert.equal(stored.tool.endpointUrl, 'https://8.8.8.8/v1/weather');
    assert.deepEqual(stored.tool.inputSchema.required, ['city']);
    assert.deepEqual(stored.tool.queryMappings, { q: 'city' });
    assert.equal(stored.tool.outputSchema.additionalProperties, true);
    assert.equal(decryptCredential(stored.secrets[0]), 'test-secret-value-123');
    assert.equal(stored.secrets[0].ciphertext.includes('test-secret-value-123'), false);
    assert.deepEqual((tools as any).redactCredential({ response: 'echo test-secret-value-123' }, 'test-secret-value-123'), { response: 'echo [redacted]' });
    assert.equal(result.authSecretConfigured, true);
    assert.equal(JSON.stringify(result).includes('test-secret-value-123'), false);
  } finally {
    if (previousKey === undefined) delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  }
});

test('direct endpoint tools remain discoverable without connection-profile configuration', async () => {
  const previous = process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
  process.env.CUSTOM_TOOL_CONNECTION_PROFILES = 'invalid-json';
  const row = { ...dbTool(), endpointUrl: 'https://api.example.com/weather', connectionProfile: 'direct' };
  const prisma = { customTool: { findMany: async () => [row] } };
  try {
    const tools = new BackendTools(prisma as unknown as PrismaService);
    const catalog = await tools.catalog(principal);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]?.id, 'custom_f9237c7864ae40df91c721e0915d2f15');
  } finally {
    if (previous === undefined) delete process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
    else process.env.CUSTOM_TOOL_CONNECTION_PROFILES = previous;
  }
});

test('tool catalogs stay within entry and UTF-8 prompt-size bounds', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    ...dbTool(), id: `a${String(index).padStart(7, '0')}-1111-4111-8111-111111111111`,
    name: `tool_${String(index).padStart(3, '0')}`, endpointUrl: 'https://api.example.com/test', connectionProfile: 'direct',
  }));
  const tools = new BackendTools({ customTool: { findMany: async () => rows } } as unknown as PrismaService);
  const catalog = await tools.catalog(principal);
  assert.ok(catalog.length <= 48);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog), 'utf8') <= 24_000);
});
