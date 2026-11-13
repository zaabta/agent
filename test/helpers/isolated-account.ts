import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/** Create an authenticated user only in an explicitly disposable E2E database. */
export async function isolatedAccount(prisma: PrismaClient, baseUrl: string, prefix: string) {
  assert.equal(process.env.CONFIRM_ISOLATED_E2E, 'true', 'Use only an explicitly disposable E2E database');
  const suffix = randomUUID();
  const credentials = { username: `${prefix}-${suffix}`, password: `S!tePilot-${suffix}-secure` };
  const registration = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(registration.status, 201);
  const pending = await registration.json() as { user: { id: string }; status: string };
  assert.equal(pending.status, 'registered');
  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200);
    return { ...await login.json() as { accessToken: string; user: { id: string } }, refreshCookie: login.headers.get('set-cookie')?.split(';')[0] };
  } catch (error) {
    await prisma.user.deleteMany({ where: { id: pending.user.id } }).catch(() => undefined);
    throw error;
  }
}
