import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service.js';
import { config } from '../src/config.js';

test('company login issues canonical workspace scope only to current workspace members', async () => {
  const previousWorkspaceId = config.companyWorkspaceId;
  const workspaceId = previousWorkspaceId || 'test-company-workspace';
  (config as any).companyWorkspaceId = workspaceId;
  const previousSecret = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = 'test-company-workspace-jwt-secret-32-bytes-minimum';
  const sessions = new Map<string, any>();
  const memberships = new Map([
    ['user-x', [{ tenantId: workspaceId, role: 'TENANT_ADMIN' }]],
    ['user-y', [{ tenantId: workspaceId, role: 'MEMBER' }]],
    ['pending', [{ tenantId: 'another-empty-workspace', role: 'TENANT_ADMIN' }]],
  ]);
  const prisma: any = {
    user: { findUnique: async ({ where }: any) => {
      const id = where.id ?? [...memberships.keys()].find(key => `${key}@company.test` === where.email);
      return id ? { id, email: `${id}@company.test`, disabledAt: null, memberships: memberships.get(id) ?? [] } : null;
    } },
    auditLog: { create: async () => ({}) },
    refreshSession: {
      create: async ({ data }: any) => { sessions.set(data.id, { ...data, revokedAt: null }); return data; },
      findUnique: async ({ where }: any) => sessions.get(where.id) ?? null,
    },
    membership: { findUnique: async ({ where }: any) => memberships.get(where.tenantId_userId.userId)?.find((membership: any) => membership.tenantId === where.tenantId_userId.tenantId) ?? null },
  };
  const service = new AuthService(prisma);
  (service as any).enforceLoginLimit = async () => undefined;
  (service as any).verifyPassword = async () => true;
  try {
    const x = await service.login({ email: 'user-x@company.test', password: 'test-password' }, '127.0.0.1');
    const y = await service.login({ email: 'user-y@company.test', password: 'test-password' }, '127.0.0.1');
    assert.equal(x.tenant.id, workspaceId);
    assert.equal(y.tenant.id, workspaceId);
    assert.equal((await service.validateAccessToken(x.accessToken)).tenantId, workspaceId);
    assert.equal((await service.validateAccessToken(y.accessToken)).tenantId, workspaceId);
    await assert.rejects(
      service.login({ email: 'pending@company.test', password: 'test-password' }, '127.0.0.1'),
      error => error instanceof ForbiddenException && error.message === 'COMPANY_WORKSPACE_ACCESS_REQUIRED',
    );
    await assert.rejects(service.switchTenant({ userId: 'user-x', tenantId: workspaceId, role: 'TENANT_ADMIN', authMethod: 'jwt' }, 'another-empty-workspace'), ForbiddenException);
  } finally {
    await service.onModuleDestroy();
    if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previousSecret;
    (config as any).companyWorkspaceId = previousWorkspaceId;
  }
});

test('registration creates a pending identity without provisioning a workspace or membership', async () => {
  let createdTenant = false;
  let createdMembership = false;
  const tx: any = {
    user: { create: async ({ data }: any) => ({ id: 'pending-user', email: data.email, ...data }) },
    auditLog: { create: async ({ data }: any) => { assert.equal(data.tenantId, null); return data; } },
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
    const result = await service.register({ email: 'pending@example.test', password: 'correct-horse-battery-staple' });
    assert.equal(result.status, 'pending_workspace_membership');
    assert.equal(createdTenant, false);
    assert.equal(createdMembership, false);
  } finally {
    await service.onModuleDestroy();
  }
});
