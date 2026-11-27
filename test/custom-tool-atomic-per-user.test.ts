import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { BackendTools } from '../src/agent/backend-tools.js';
import { CustomToolError } from '../src/agent/custom-http-tool.js';
import { parseAtomicSession } from '../src/agent/custom-tool-credential-adapters.js';
import { CustomToolsController } from '../src/agent/custom-tools.controller.js';
import { ApiAuthGuard } from '../src/auth/api-auth.guard.js';
import { INSTALLATION_OWNER_ONLY } from '../src/auth/installation-owner.decorator.js';
import { decryptCredential, encryptCredential } from '../src/llm-admin/provider-credentials.js';

const principal = (userId = 'user-a') => ({ userId, tenantId: 'tenant-a', authMethod: 'jwt' as const });
const atomicProfile = {
  id: 'atomic',
  tenantId: 'tenant-a',
  displayName: 'Atomic',
  baseUrl: 'https://8.8.8.8/',
  authStrategy: 'ATOMIC_COOKIE_REFRESH',
  enabled: true,
};
const env = [
  'LLM_CREDENTIALS_ENCRYPTION_KEY',
  'NODE_ENV',
] as const;

function setAtomicEnv() {
  const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]));
  process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  return () =>
    env.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]!),
    );
}

test('Atomic email/password login parses the JWT response and captures its rotating HttpOnly refresh cookie', () => {
  assert.deepEqual(
    parseAtomicSession({
      statusCode: 200,
      body: { accessToken: 'atomic-access-token', tokenType: 'Bearer', expiresIn: 900 },
      responseHeaders: {
        'set-cookie': [
          'other=value; Path=/',
          'refreshToken=refresh%3Dpart; HttpOnly; Secure; SameSite=Strict',
        ],
      },
    }),
    { accessToken: 'atomic-access-token', refreshToken: 'refresh%3Dpart', expiresIn: 900 },
  );
  assert.throws(
    () =>
      parseAtomicSession({
        statusCode: 401,
        body: { message: 'invalid credentials' },
        responseHeaders: {},
      }),
    (error: unknown) => error instanceof CustomToolError && error.statusCode === 401,
  );
});

test('Atomic connect encrypts a tenant/user/profile session and disconnect only removes that user', async () => {
  const restore = setAtomicEnv();
  let stored: any;
  let deletedWhere: any;
  const db = {
    customToolConnectionProfile: { findUnique: async () => atomicProfile },
    customToolConnectionCredential: {
      upsert: async (args: any) => {
        stored = { id: 'credential', ...args.create };
        return stored;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return stored?.id === where.id ? stored : null;
        const key = where.profileId_name_tenantId_userId;
        return stored && key.tenantId === stored.tenantId && key.userId === stored.userId ? stored : null;
      },
      deleteMany: async ({ where }: any) => {
        deletedWhere = where;
        stored = null;
        return { count: 1 };
      },
    },
  };
  try {
    const tools = new BackendTools(db as any);
    (tools as any).atomicCredentials = {
      login: async (_profile: any, email: string, password: string) => {
        assert.equal(email, 'person@example.com');
        assert.equal(password, 'never-store-this');
        return { accessToken: 'atomic-access-token', refreshToken: 'atomic-refresh-cookie', expiresIn: 900 };
      },
    };
    const status = await tools.connectAtomicUserCredential(
      'atomic',
      'person@example.com',
      'never-store-this',
      principal(),
    );
    assert.deepEqual(status, {
      connected: true,
      authStatus: 'ACTIVE',
      tokenExpiresAt: stored.tokenExpiresAt,
      lastRefreshedAt: stored.lastRefreshedAt,
    });
    assert.deepEqual(
      {
        tenantId: stored.tenantId,
        userId: stored.userId,
        profileId: stored.profileId,
        authStrategy: stored.authStrategy,
      },
      {
        tenantId: 'tenant-a',
        userId: 'user-a',
        profileId: 'atomic',
        authStrategy: 'ATOMIC_COOKIE_REFRESH',
      },
    );
    assert.equal(
      decryptCredential({
        ciphertext: stored.accessTokenCiphertext,
        iv: stored.accessTokenIv,
        authTag: stored.accessTokenAuthTag,
      }),
      'atomic-access-token',
    );
    assert.equal(
      decryptCredential({
        ciphertext: stored.refreshCookieCiphertext,
        iv: stored.refreshCookieIv,
        authTag: stored.refreshCookieAuthTag,
      }),
      'atomic-refresh-cookie',
    );
    const restartedTools = new BackendTools(db as any);
    assert.equal(
      await (restartedTools as any).refreshConnectionCredential(stored, false, 'tenant-a'),
      'atomic-access-token',
    );
    assert.equal(stored.refreshTokenCiphertext, null);
    assert.doesNotMatch(JSON.stringify(stored), /never-store-this|atomic-access-token|atomic-refresh-cookie/);
    assert.doesNotMatch(
      JSON.stringify(status),
      /never-store-this|atomic-access-token|atomic-refresh-cookie|ciphertext/i,
    );
    assert.equal((await tools.userCredentialStatus('atomic', principal('user-b'))).connected, false);
    await tools.disconnectUserCredential('atomic', principal());
    assert.deepEqual(deletedWhere, {
      profileId: 'atomic',
      name: 'per-user',
      tenantId: 'tenant-a',
      userId: 'user-a',
    });
  } finally {
    restore();
  }
});

test('Atomic PER_USER execution queries only the caller session and never falls back to a shared row', async () => {
  const sharedCredential = {
    id: 'shared-session',
    authStrategy: 'ATOMIC_COOKIE_REFRESH',
    authStatus: 'ACTIVE',
  };
  let credentialWhere: any;
  const tools = new BackendTools({
    customTool: {
      findUnique: async () => ({
        id: '00000000-0000-4000-8000-000000000001',
        enabled: true,
        archivedAt: null,
        authScope: 'PER_USER',
        connectionProfile: 'atomic',
        endpointUrl: null,
        path: '/things',
        connectionCredentialId: null,
        authSecretId: null,
        authHeaderName: null,
        allowedUserIds: [],
        configurationVersion: 1,
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        queryMappings: {},
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, additionalProperties: true },
        connectionCredential: sharedCredential,
      }),
    },
    customToolConnectionProfile: { findUnique: async () => atomicProfile },
    customToolConnectionCredential: {
      findUnique: async ({ where }: any) => {
        credentialWhere = where;
        return null;
      },
    },
    customToolExecution: { create: async () => undefined },
  } as any);
  await assert.rejects(
    tools.execute({ id: 'custom_00000000000040008000000000000001', args: {} }, principal('user-b')),
    (error: unknown) => error instanceof CustomToolError && error.category === 'PER_USER_CREDENTIAL_REQUIRED',
  );
  assert.deepEqual(credentialWhere.profileId_name_tenantId_userId, {
    profileId: 'atomic',
    name: 'per-user',
    tenantId: 'tenant-a',
    userId: 'user-b',
  });
});

test('Atomic bad-password responses are sanitized and do not create credentials', async () => {
  const restore = setAtomicEnv();
  let upserts = 0;
  const tools = new BackendTools({
    customToolConnectionProfile: { findUnique: async () => atomicProfile },
    customToolConnectionCredential: {
      upsert: async () => {
        upserts++;
      },
    },
  } as any);
  (tools as any).atomicCredentials = {
    login: async () => {
      throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED', 401);
    },
  };
  try {
    await assert.rejects(
      tools.connectAtomicUserCredential('atomic', 'person@example.com', 'wrong-password', principal()),
      (error: unknown) => {
        assert.ok(error instanceof UnauthorizedException);
        assert.match(error.message, /ATOMIC_CREDENTIALS_INVALID/);
        assert.doesNotMatch(error.message, /wrong-password|connection_authentication_failed/i);
        return true;
      },
    );
    assert.equal(upserts, 0);
  } finally {
    restore();
  }
});

test('Atomic connect rejects disabled or non-Atomic database profiles', async () => {
  const restore = setAtomicEnv();
  let logins = 0;
  const otherOrigin = { ...atomicProfile, authStrategy: 'NONE' };
  const tools = new BackendTools({
    customToolConnectionProfile: { findUnique: async () => otherOrigin },
    customToolConnectionCredential: { upsert: async () => undefined },
  } as any);
  (tools as any).atomicCredentials = {
    login: async () => {
      logins++;
      return {};
    },
  };
  try {
    await assert.rejects(
      tools.connectAtomicUserCredential('atomic', 'person@example.com', 'valid-password', principal()),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match(error.message, /ATOMIC_ORIGIN_NOT_APPROVED/);
        return true;
      },
    );
    assert.equal(logins, 0);
  } finally {
    restore();
  }
});

test('Atomic local login uses the database profile approval and is blocked in production', async () => {
  const restore = setAtomicEnv();
  process.env.NODE_ENV = 'development';
  const localProfile = { ...atomicProfile, baseUrl: 'http://localhost:3000/', allowLocalHttp: true };
  let saved: any;
  const tools = new BackendTools({
    customToolConnectionProfile: { findUnique: async () => localProfile },
    customToolConnectionCredential: {
      upsert: async ({ create }: any) => (saved = { id: 'credential', ...create }),
      findUnique: async () => saved,
    },
  } as any);
  (tools as any).atomicCredentials = {
    login: async (profile: any) => {
      assert.equal(profile.loopbackOnly, true);
      return { accessToken: 'access-token', refreshToken: 'refresh-cookie', expiresIn: 900 };
    },
  };
  try {
    const result = await tools.connectAtomicUserCredential('atomic', 'person@example.com', 'valid-password', principal());
    assert.equal(result.connected, true);
    process.env.NODE_ENV = 'production';
    await assert.rejects(
      tools.connectAtomicUserCredential('atomic', 'person@example.com', 'valid-password', principal()),
      /AUTH_ENDPOINT_NOT_ALLOWED/,
    );
  } finally {
    restore();
  }
});

test('expired Atomic refresh sessions are marked expired after refresh rejection', async () => {
  const restore = setAtomicEnv();
  const encryptedRefresh = encryptCredential('atomic-refresh-cookie');
  const row: any = {
    id: 'credential',
    profileId: 'atomic',
    tenantId: 'tenant-a',
    userId: 'user-a',
    authStrategy: 'ATOMIC_COOKIE_REFRESH',
    authStatus: 'ACTIVE',
    credentialVersion: 1,
    tokenExpiresAt: new Date(0),
    refreshCookieCiphertext: encryptedRefresh.ciphertext,
    refreshCookieIv: encryptedRefresh.iv,
    refreshCookieAuthTag: encryptedRefresh.authTag,
  };
  const db = {
    customToolConnectionCredential: {
      findUnique: async () => ({ ...row }),
      updateMany: async ({ where, data }: any) => {
        if (where.OR) {
          Object.assign(row, data);
          return { count: 1 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    customToolConnectionProfile: { findUnique: async () => atomicProfile },
  };
  const tools = new BackendTools(db as any);
  (tools as any).atomicCredentials = {
    refresh: async () => {
      throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED', 401);
    },
  };
  try {
    await assert.rejects(
      (tools as any).refreshConnectionCredential(row, false, 'tenant-a'),
      /CONNECTION_AUTHENTICATION_FAILED/,
    );
    assert.equal(row.authStatus, 'EXPIRED');
  } finally {
    restore();
  }
});

test('Atomic user connect is authenticated but not installation-owner-only', () => {
  assert.ok((Reflect.getMetadata('__guards__', CustomToolsController) ?? []).includes(ApiAuthGuard));
  assert.equal(
    Reflect.getMetadata(INSTALLATION_OWNER_ONLY, CustomToolsController.prototype.connectAtomic),
    undefined,
  );
});

test('Atomic connect requires HTTPS except for explicitly configured loopback development requests', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  let rateLimited = false;
  let connected = false;
  const controller = new CustomToolsController(
    {
      connectAtomicUserCredential: async () => {
        connected = true;
        return { connected: true };
      },
    } as any,
    {
      enforceConnectionLoginLimit: async () => {
        rateLimited = true;
      },
    } as any,
  );
  await assert.rejects(
    controller.connectAtomic(
      'atomic',
      { email: 'person@example.com', password: 'valid-password' },
      principal(),
      '127.0.0.1',
      { secure: false, socket: { remoteAddress: '10.0.0.5' } } as any,
    ),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(rateLimited, false);
  assert.equal(connected, false);
  assert.deepEqual(
    await controller.connectAtomic(
      'atomic',
      { email: 'person@example.com', password: 'valid-password' },
      principal(),
      '127.0.0.1',
      { secure: false, socket: { remoteAddress: '127.0.0.1' } } as any,
    ),
    { connected: true },
  );
  assert.equal(rateLimited, true);
  assert.equal(connected, true);
  rateLimited = false;
  connected = false;
  assert.deepEqual(
    await controller.connectAtomic(
      'atomic',
      { email: 'person@example.com', password: 'valid-password' },
      principal(),
      '127.0.0.1',
      { secure: true } as any,
    ),
    { connected: true },
  );
  assert.equal(rateLimited, true);
  assert.equal(connected, true);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});
