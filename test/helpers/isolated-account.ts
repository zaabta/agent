import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { config } from '../../src/config.js';

/** Registration creates a pending user, not a workspace or an access token.
 * This fixture provisions only a new identity in an explicitly disposable DB. */
export async function isolatedAccount(prisma: PrismaClient, baseUrl: string, prefix: string) {
  assert.equal(process.env.CONFIRM_ISOLATED_E2E, 'true', 'Use only an explicitly disposable E2E database');
  const tenantId = config.companyWorkspaceId;
  assert.ok(tenantId, 'Configure the disposable canonical company workspace');
  const suffix = randomUUID();
  const credentials = { email: `${prefix}-${suffix}@example.test`, password: `S!tePilot-${suffix}-secure` };
  const registration = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(registration.status, 201);
  const pending = await registration.json() as { user: { id: string }; status: string };
  assert.equal(pending.status, 'pending_workspace_membership');
  try {
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: 'Disposable E2E company workspace' } });
    await prisma.membership.create({ data: { tenantId, userId: pending.user.id, role: 'TENANT_ADMIN' } });
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200);
    return { ...await login.json() as { accessToken: string; user: { id: string }; tenant: { id: string; role: string } }, refreshCookie: login.headers.get('set-cookie')?.split(';')[0] };
  } catch (error) {
    await prisma.user.deleteMany({ where: { id: pending.user.id } }).catch(() => undefined);
    throw error;
  }
}
