import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { BackendTools } from '../src/agent/backend-tools.js';
import { CustomToolError } from '../src/agent/custom-http-tool.js';
import { parseAtomicSession } from '../src/agent/custom-tool-credential-adapters.js';
import { CustomToolsController } from '../src/agent/custom-tools.controller.js';
import { decryptCredential } from '../src/llm-admin/provider-credentials.js';

const principal = { tenantId: 'tenant-a', userId: 'user-a', authMethod: 'jwt' as const };
const envName = 'LLM_CREDENTIALS_ENCRYPTION_KEY';

function withEncryptionKey() {
  const previous = process.env[envName];
  process.env[envName] = Buffer.alloc(32, 9).toString('base64');
  return () => previous === undefined ? delete process.env[envName] : (process.env[envName] = previous);
}

test('Atomic session parser accepts Atomic JSON and refreshToken cookie contract', () => {
  assert.deepEqual(parseAtomicSession({
    statusCode: 200,
    body: { accessToken: 'atomic-access-token', expiresIn: 900, user: { id: 'user-a' } },
    responseHeaders: { 'set-cookie': 'refreshToken=rotated-cookie; HttpOnly; Path=/' },
  }), { accessToken: 'atomic-access-token', refreshToken: 'rotated-cookie', expiresIn: 900 });
});

test('Atomic PER_USER connect encrypts both tokens before persistence', async () => {
  const restore = withEncryptionKey();
  let stored: any;
  const db = {
    customToolConnectionCredential: {
      upsert: async ({ create }: any) => { stored = { id: 'credential-a', ...create }; return stored; },
      findUnique: async () => stored,
    },
  };
  try {
    const tools = new BackendTools(db as any);
    (tools as any).atomicUserAuthProfile = async () => ({ baseUrl: new URL('http://localhost:3000/') });
    (tools as any).atomicCredentials = {
      login: async (_profile: unknown, email: string, password: string) => {
        assert.equal(email, 'person@example.com');
        assert.equal(password, 'one-time-password');
        return { accessToken: 'atomic-access-token', refreshToken: 'rotated-cookie', expiresIn: 900 };
      },
    };
    const result = await tools.connectAtomicUserCredential('atomic-local', 'person@example.com', 'one-time-password', principal);
    assert.equal(result.connected, true);
    assert.equal(stored.tenantId, principal.tenantId);
    assert.equal(stored.userId, principal.userId);
    assert.equal(stored.profileId, 'atomic-local');
    assert.notEqual(stored.accessTokenCiphertext, 'atomic-access-token');
    assert.notEqual(stored.refreshCookieCiphertext, 'rotated-cookie');
    assert.equal(decryptCredential({
      ciphertext: stored.accessTokenCiphertext,
      iv: stored.accessTokenIv,
      authTag: stored.accessTokenAuthTag,
    }), 'atomic-access-token');
    assert.equal(decryptCredential({
      ciphertext: stored.refreshCookieCiphertext,
      iv: stored.refreshCookieIv,
      authTag: stored.refreshCookieAuthTag,
    }), 'rotated-cookie');
    assert.doesNotMatch(JSON.stringify(result), /accessToken|refreshToken|ciphertext|rotated-cookie/i);
  } finally { restore(); }
});

test('invalid Atomic credentials are sanitized and do not persist a session', async () => {
  const restore = withEncryptionKey();
  let upserts = 0;
  try {
    const tools = new BackendTools({ customToolConnectionCredential: { upsert: async () => { upserts++; } } } as any);
    (tools as any).atomicUserAuthProfile = async () => ({ baseUrl: new URL('http://localhost:3000/') });
    (tools as any).atomicCredentials = { login: async () => { throw new CustomToolError('LOGIN_REJECTED', 401); } };
    await assert.rejects(
      tools.connectAtomicUserCredential('atomic-local', 'person@example.com', 'wrong-password', principal),
      (error: unknown) => error instanceof UnauthorizedException && error.message === 'ATOMIC_CREDENTIALS_INVALID',
    );
    assert.equal(upserts, 0);
  } finally { restore(); }
});

test('missing refresh cookies and malformed Atomic JSON are rejected without echoing values', () => {
  for (const response of [
    { statusCode: 200, body: { accessToken: 'access-token', expiresIn: 900 }, responseHeaders: {} },
    { statusCode: 200, body: { accessToken: 12, expiresIn: '900' }, responseHeaders: { 'set-cookie': 'refreshToken=private-cookie; HttpOnly' } },
  ]) {
    assert.throws(
      () => parseAtomicSession(response),
      (error: unknown) => error instanceof CustomToolError && error.category === 'CONNECTION_AUTHENTICATION_FAILED',
    );
  }
});

test('Atomic controller forwards the email/password request to the PER_USER login path', async () => {
  let received: unknown[] = [];
  const controller = new CustomToolsController({
    connectAtomicUserCredential: async (...args: unknown[]) => { received = args; return { connected: true }; },
  } as any, { enforceConnectionLoginLimit: async () => undefined } as any);
  await controller.connectAtomic(
    'atomic-local',
    { email: 'person@example.com', password: 'one-time-password' },
    principal,
    '127.0.0.1',
    { secure: true } as any,
  );
  assert.deepEqual(received, ['atomic-local', 'person@example.com', 'one-time-password', principal]);
});
