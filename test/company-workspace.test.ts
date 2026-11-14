import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service.js';
import { config } from '../src/config.js';

test('independent users authenticate without workspace memberships and receive the installation scope internally', async () => {
  const previousWorkspaceId = config.companyWorkspaceId;
  const workspaceId = previousWorkspaceId || 'test-company-workspace';
  (config as any).companyWorkspaceId = workspaceId;
  const previousSecret = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = 'test-company-workspace-jwt-secret-32-bytes-minimum';
  const sessions = new Map<string, any>();
  const users = new Map<string, any>(['user-x', 'user-y'].map(id => [id, { id, username: id, displayName: id, disabledAt: null, passwordHash: 'hash' }]));
  const prisma: any = {
    user: { findUnique: async ({ where, select }: any) => {
      const user = where.id ? users.get(where.id) : [...users.values()].find(row => row.username === where.username);
      return user ? (select ? Object.fromEntries(Object.keys(select).map(key => [key, user[key]])) : user) : null;
    } },
    auditLog: { create: async () => ({}) },
    refreshSession: {
      create: async ({ data }: any) => { sessions.set(data.id, { ...data, revokedAt: null }); return data; },
      findUnique: async ({ where }: any) => sessions.get(where.id) ?? null,
    },
  };
  const service = new AuthService(prisma);
  (service as any).enforceLoginLimit = async () => undefined;
  (service as any).verifyPassword = async () => true;
  try {
    const x = await service.login({ username: 'user-x', password: 'test-password' }, '127.0.0.1');
    const y = await service.login({ username: 'user-y', password: 'test-password' }, '127.0.0.1');
    assert.equal(x.user?.id, 'user-x');
    assert.equal(y.user?.id, 'user-y');
    assert.equal('tid' in JSON.parse(Buffer.from(x.accessToken.split('.')[1]!, 'base64url').toString()), false);
    assert.equal((await service.validateAccessToken(x.accessToken)).tenantId, workspaceId);
    assert.equal((await service.validateAccessToken(y.accessToken)).tenantId, workspaceId);
    assert.equal('tenant' in x, false);
    assert.equal('role' in x.user!, false);
    await assert.rejects(service.login({ username: '@invalid', password: 'test-password' }, '127.0.0.1'), UnauthorizedException);
  } finally {
    await service.onModuleDestroy();
    if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previousSecret;
    (config as any).companyWorkspaceId = previousWorkspaceId;
  }
});

test('registration hashes password and creates a username without provisioning tenant records', async () => {
  let createdTenant = false;
  let createdMembership = false;
  let created: any;
  const tx: any = {
    user: { create: async ({ data }: any) => (created = { id: 'new-user', ...data }) },
    auditLog: { create: async () => ({}) },
    tenant: { create: async () => { createdTenant = true; } },
    membership: { create: async () => { createdMembership = true; } },
  };
  const prisma: any = {
    user: { findUnique: async () => null },
    $transaction: async (operation: (value: any) => Promise<any>) => operation(tx),
  };
  const service = new AuthService(prisma);
  (service as any).enforceLoginLimit = async () => undefined;
  try {
    const result = await service.register({ username: 'new-user', password: 'correct-horse-battery-staple' });
    assert.equal(result.status, 'registered');
    assert.equal(result.user.username, 'new-user');
    assert.match(created.passwordHash, /^scrypt\$/);
    assert.equal(JSON.stringify(result).includes('password'), false);
    assert.equal(createdTenant, false);
    assert.equal(createdMembership, false);
  } finally {
    await service.onModuleDestroy();
  }
});
