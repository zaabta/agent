import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendTools } from '../src/agent/backend-tools.js';
import { CustomToolsController } from '../src/agent/custom-tools.controller.js';
import { INSTALLATION_OWNER_ONLY } from '../src/auth/installation-owner.decorator.js';
import { ApiAuthGuard } from '../src/auth/api-auth.guard.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const ownerRoute = (name: string) =>
  Reflect.getMetadata(INSTALLATION_OWNER_ONLY, (CustomToolsController.prototype as any)[name]);
const profile = (id: string, tenantId: string, baseUrl = 'https://8.8.8.8/v1') => ({
  id,
  tenantId,
  displayName: `Profile ${id}`,
  baseUrl,
  allowLocalHttp: false,
  authStrategy: 'NONE',
  tokenUrl: null,
  clientId: null,
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

test('connection profile CRUD scopes reads and writes to the authenticated tenant and returns metadata only', async () => {
  const rows = new Map<string, any>();
  const db = {
    customToolConnectionProfile: {
      create: async ({ data }: any) => {
        rows.set(`${data.tenantId}:${data.id}`, {
          enabled: true,
          ...data,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        });
        return rows.get(`${data.tenantId}:${data.id}`);
      },
      findUnique: async ({ where }: any) =>
        rows.get(`${where.tenantId_id.tenantId}:${where.tenantId_id.id}`) ?? null,
      findMany: async ({ where }: any) => [...rows.values()].filter((row) => row.tenantId === where.tenantId),
      update: async ({ where, data }: any) => {
        const row = rows.get(`${where.tenantId_id.tenantId}:${where.tenantId_id.id}`);
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: any) => rows.delete(`${where.tenantId_id.tenantId}:${where.tenantId_id.id}`),
    },
    customTool: { count: async () => 0 },
    customToolConnectionCredential: { count: async () => 0 },
  };
  const tools = new BackendTools(db as unknown as PrismaService);
  const created = await tools.createConnectionProfile(
    { id: 'crm', displayName: 'CRM', baseUrl: 'https://8.8.8.8/v1' },
    'tenant-a',
  );
  assert.deepEqual(created, {
    id: 'crm',
    displayName: 'CRM',
    baseUrl: 'https://8.8.8.8/v1',
    allowLocalHttp: false,
    tokenUrl: null,
    clientId: null,
    authStrategy: 'NONE',
    enabled: true,
    authenticationCapabilities: { atomicPerUserLogin: false, oauth2Refresh: false },
    host: '8.8.8.8',
    trustedInternal: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  assert.doesNotMatch(JSON.stringify(created), /ciphertext|secret|accessToken|refreshToken/i);
  await assert.rejects(tools.getConnectionProfile('crm', 'tenant-b'), /CONNECTION_PROFILE_NOT_FOUND/);
  const updated = await tools.updateConnectionProfile(
    'crm',
    { displayName: 'CRM v2', enabled: false },
    'tenant-a',
  );
  assert.equal(updated.displayName, 'CRM v2');
  assert.equal(updated.enabled, false);
  assert.deepEqual(await tools.deleteConnectionProfile('crm', 'tenant-a'), { id: 'crm', deleted: true });
});

test('connection profile CRUD routes retain bearer authentication and installation-owner authorization', () => {
  assert.ok((Reflect.getMetadata('__guards__', CustomToolsController) ?? []).includes(ApiAuthGuard));
  for (const name of [
    'connections',
    'createConnection',
    'getConnection',
    'updateConnection',
    'deleteConnection',
  ])
    assert.equal(ownerRoute(name), true);
  assert.equal(ownerRoute('availableConnections'), undefined);
  for (const name of ['connectUser', 'disconnectUser', 'userConnectionStatus'])
    assert.equal(ownerRoute(name), undefined);
});

test('profile capabilities come from enabled database configuration and ordinary users get metadata only', async () => {
  const rows = [
    { ...profile('atomic', 'tenant-a', 'https://8.8.8.8/'), authStrategy: 'ATOMIC_COOKIE_REFRESH' },
    { ...profile('atomic-disabled', 'tenant-a', 'https://8.8.8.8/'), authStrategy: 'ATOMIC_COOKIE_REFRESH', enabled: false },
    { ...profile('not-allowlisted', 'tenant-a', 'https://8.8.8.8/'), authStrategy: 'ATOMIC_COOKIE_REFRESH' },
    { ...profile('wrong-origin', 'tenant-a', 'https://1.1.1.1/'), authStrategy: 'ATOMIC_COOKIE_REFRESH' },
    {
      ...profile('oauth', 'tenant-a', 'https://8.8.8.8/'),
      authStrategy: 'OAUTH2_REFRESH',
      tokenUrl: 'https://8.8.8.8/token',
      clientId: 'public-client',
    },
  ];
  const db = {
    customToolConnectionProfile: {
      findMany: async ({ where }: any) => rows.filter((row) => row.tenantId === where.tenantId),
      findUnique: async ({ where }: any) => rows.find((row) => row.tenantId === where.tenantId_id.tenantId && row.id === where.tenantId_id.id) ?? null,
    },
  };
  const tools = new BackendTools(db as unknown as PrismaService);
  const listed = await tools.listConnectionProfiles('tenant-a');
  const byId = Object.fromEntries(listed.map((row: any) => [row.id, row]));
  assert.deepEqual(byId.atomic.authenticationCapabilities, { atomicPerUserLogin: true, oauth2Refresh: false });
  assert.deepEqual(byId['atomic-disabled'].authenticationCapabilities, { atomicPerUserLogin: false, oauth2Refresh: false });
  assert.deepEqual(byId['not-allowlisted'].authenticationCapabilities, { atomicPerUserLogin: true, oauth2Refresh: false });
  assert.deepEqual(byId['wrong-origin'].authenticationCapabilities, { atomicPerUserLogin: true, oauth2Refresh: false });
  assert.deepEqual(byId.oauth.authenticationCapabilities, { atomicPerUserLogin: false, oauth2Refresh: true });
  const detail = await tools.getConnectionProfile('atomic', 'tenant-a');
  assert.deepEqual(detail.authenticationCapabilities, byId.atomic.authenticationCapabilities);
  assert.doesNotMatch(JSON.stringify(listed), /ciphertext|secret|accessToken|refreshToken/i);
  const available = await tools.listAvailableUserConnections('tenant-a');
  assert.deepEqual(available.map((item: any) => item.id), ['atomic', 'not-allowlisted', 'wrong-origin', 'oauth']);
  assert.doesNotMatch(JSON.stringify(available), /baseUrl|tokenUrl|clientId|allowLocalHttp|ciphertext|secret/i);
  assert.deepEqual(await tools.listAvailableUserConnections('tenant-b'), []);
});

test('local Atomic profile approval is stored in PostgreSQL and ignored in production', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const rows = new Map<string, any>();
  const db = {
    customToolConnectionProfile: {
      create: async ({ data }: any) => {
        const row = { ...data, enabled: true, createdAt: new Date(0), updatedAt: new Date(0) };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => where.tenantId_id.tenantId === 'tenant-a'
        ? rows.get(where.tenantId_id.id) ?? null
        : null,
      findMany: async () => [...rows.values()],
    },
  };
  try {
    const tools = new BackendTools(db as unknown as PrismaService);
    const created = await tools.createConnectionProfile({
      id: 'atomic-local',
      displayName: 'Atomic local',
      baseUrl: 'http://localhost:3000',
      allowLocalHttp: true,
      authStrategy: 'ATOMIC_COOKIE_REFRESH',
    }, 'tenant-a');
    assert.equal(created.authenticationCapabilities.atomicPerUserLogin, true);
    assert.equal(created.allowLocalHttp, true);
    assert.equal((await (tools as any).resolveConnectionProfile('atomic-local', 'tenant-a')).loopbackOnly, true);
    process.env.NODE_ENV = 'production';
    await assert.rejects(
      tools.createConnectionProfile({
        id: 'atomic-prod', displayName: 'Atomic prod', baseUrl: 'http://localhost:3000', authStrategy: 'ATOMIC_COOKIE_REFRESH',
      }, 'tenant-a'),
      /INVALID_ENDPOINT/,
    );
    assert.equal((await tools.listConnectionProfiles('tenant-a'))[0].authenticationCapabilities.atomicPerUserLogin, false);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('two custom tools can resolve the same tenant-owned database profile', async () => {
  const rows = ['first_tool', 'second_tool'].map((name, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name,
    displayName: name,
    description: 'Use CRM',
    connectionProfile: 'crm',
    endpointUrl: null,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    configurationVersion: 1,
    enabled: true,
    archivedAt: null,
  }));
  const tools = new BackendTools({
    customToolConnectionProfile: {
      findMany: async ({ where }: any) => (where.tenantId === 'tenant-a' ? [profile('crm', 'tenant-a')] : []),
    },
    customTool: { findMany: async () => rows },
  } as unknown as PrismaService);
  assert.deepEqual(
    (await tools.catalog({ userId: 'user-a', tenantId: 'tenant-a', authMethod: 'jwt' })).map(
      (tool) => tool.name,
    ),
    ['first_tool', 'second_tool'],
  );
  assert.deepEqual(await tools.catalog({ userId: 'user-b', tenantId: 'tenant-b', authMethod: 'jwt' }), []);
});

test('profile references resolve only from the database and reject private URLs', async () => {
  const savedProfile = profile('crm', 'tenant-a');
  const tools = new BackendTools({
    customToolConnectionProfile: {
      findUnique: async ({ where }: any) => where.tenantId_id.tenantId === 'tenant-a' ? savedProfile : null,
    },
  } as unknown as PrismaService);
  const resolved = await (tools as any).resolveConnectionProfile('crm', 'tenant-a');
  assert.equal(resolved.baseUrl.href, 'https://8.8.8.8/v1');
  assert.equal(await (tools as any).resolveConnectionProfile('crm', 'tenant-b'), undefined);
  await assert.rejects(
    tools.createConnectionProfile(
      { id: 'internal', displayName: 'Internal', baseUrl: 'https://127.0.0.1/admin' },
      'tenant-a',
    ),
    /ADDRESS_NOT_ALLOWED/,
  );
});
