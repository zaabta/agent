import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendTools } from '../src/agent/backend-tools.js';

const atomicProfile = (tenantId: string, id = 'atomic', baseUrl = 'https://8.8.8.8/') => ({
  tenantId,
  id,
  displayName: 'Atomic',
  baseUrl,
  tokenUrl: null,
  clientId: null,
  authStrategy: 'ATOMIC_COOKIE_REFRESH',
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const definition = (name = 'atomic_records', profile = 'atomic') => ({
  name,
  description: 'Read Atomic records.',
  authScope: 'PER_USER' as const,
  connectionProfile: profile,
  path: '/records',
  parameters: [{ name: 'query', type: 'string' as const }],
});

function environment() {
  const oldNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  return () => {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
  };
}

test('tool create and update accept an enabled, tenant-owned, approved Atomic email/password profile for PER_USER', async () => {
  const restore = environment();
  const profile = atomicProfile('tenant-a');
  let saved: any;
  const db = {
    customToolConnectionProfile: {
      findUnique: async ({ where }: any) => where.tenantId_id.tenantId === profile.tenantId && where.tenantId_id.id === profile.id ? profile : null,
    },
    $transaction: async (run: (tx: any) => Promise<any>) => run({
      customTool: {
        create: async ({ data }: any) => {
          saved = {
            id: '00000000-0000-4000-8000-000000000001',
            configurationVersion: 1,
            enabled: false,
            archivedAt: null,
            authSecretId: null,
            connectionCredentialId: null,
            authHeaderName: null,
            authPrefix: null,
            allowedUserIds: [],
            createdAt: new Date(0),
            updatedAt: new Date(0),
            ...data,
          };
          return saved;
        },
        update: async ({ data }: any) => {
          saved = { ...saved, ...data, configurationVersion: saved.configurationVersion + 1 };
          return saved;
        },
      },
      auditLog: { create: async () => undefined },
    }),
    customTool: { findFirst: async () => saved },
  };
  try {
    const tools = new BackendTools(db as any);
    const created = await tools.createCustomTool(definition(), 'owner', 'tenant-a');
    assert.equal(created.authScope, 'PER_USER');
    assert.equal(saved.connectionProfile, 'atomic');
    assert.equal(saved.authScope, 'PER_USER');
    await tools.updateCustomTool(saved.id, definition('atomic_records_v2'), 'owner', 'tenant-a');
    assert.equal(saved.name, 'atomic_records_v2');
    assert.equal(saved.authScope, 'PER_USER');
    assert.equal(saved.connectionCredentialId, null);
    assert.equal(saved.authSecretId, null);
  } finally {
    restore();
  }
});

test('tool validation rejects disabled Atomic profiles and cross-tenant profile references', async () => {
  const restore = environment();
  const unapproved = { ...atomicProfile('tenant-a', 'other-atomic'), enabled: false };
  const foreign = atomicProfile('tenant-b');
  const profiles = [unapproved, foreign];
  const db = {
    customToolConnectionProfile: {
      findUnique: async ({ where }: any) => profiles.find((row) => row.tenantId === where.tenantId_id.tenantId && row.id === where.tenantId_id.id) ?? null,
    },
    $transaction: async () => { throw new Error('must not write an invalid tool'); },
  };
  try {
    const tools = new BackendTools(db as any);
    await assert.rejects(tools.createCustomTool(definition('unapproved_tool', 'other-atomic'), 'owner', 'tenant-a'), /CONNECTION_PROFILE_UNAVAILABLE/);
    await assert.rejects(tools.createCustomTool(definition('foreign_tool'), 'owner', 'tenant-a'), /CONNECTION_PROFILE_UNAVAILABLE/);
  } finally {
    restore();
  }
});

test('Atomic PER_USER validation does not change NONE, SHARED, or legacy scope inference', async () => {
  const restore = environment();
  const oauth = {
    ...atomicProfile('tenant-a', 'oauth'),
    authStrategy: 'OAUTH2_REFRESH',
    tokenUrl: 'https://8.8.8.8/token',
    clientId: 'public-client',
  };
  const db = {
    customToolConnectionProfile: {
      findUnique: async ({ where }: any) => where.tenantId_id.id === 'oauth' ? oauth : null,
    },
  };
  try {
    const tools = new BackendTools(db as any);
    const none = await (tools as any).validateDefinition({
      name: 'none_tool', description: 'Read records.', connectionProfile: 'oauth', path: '/records', parameters: [],
    }, 'tenant-a');
    const shared = await (tools as any).validateDefinition({
      name: 'shared_tool', description: 'Read records.', connectionProfile: 'oauth', path: '/records',
      parameters: [], auth: { headerName: 'X-API-Key' },
    }, 'tenant-a');
    const legacy = (tools as any).toolAuthScope({ authSecretId: 'legacy-secret' });
    const perUserOAuth = await (tools as any).validateDefinition(definition('oauth_tool', 'oauth'), 'tenant-a');
    assert.equal(none.authScope, 'NONE');
    assert.equal(shared.authScope, 'SHARED');
    assert.equal(legacy, 'SHARED');
    assert.equal(perUserOAuth.authScope, 'PER_USER');
  } finally {
    restore();
  }
});
