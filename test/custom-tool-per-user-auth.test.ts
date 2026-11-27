import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendTools } from '../src/agent/backend-tools.js';
import { decryptCredential, encryptCredential } from '../src/llm-admin/provider-credentials.js';

const principal = (userId: string, tenantId = 'tenant-a') => ({
  userId,
  tenantId,
  authMethod: 'jwt' as const,
});

test('per-user connection writes are scoped by tenant and user and return metadata only', async () => {
  const previousKey = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
  let stored: any;
  let where: any;
  const db = {
    customToolConnectionProfile: {
      findUnique: async () => ({ enabled: true, authStrategy: 'OAUTH2_REFRESH' }),
    },
    customToolConnectionCredential: {
      upsert: async (args: any) => {
        where = args.where;
        stored = { id: 'credential', ...args.create };
        return stored;
      },
      findUnique: async ({ where: key }: any) =>
        key.profileId_name_tenantId_userId.tenantId === stored?.tenantId &&
        key.profileId_name_tenantId_userId.userId === stored?.userId
          ? stored
          : null,
    },
  };
  try {
    const tools = new BackendTools(db as any);
    const status = await tools.connectUserCredential(
      'crm',
      {
        accessToken: 'user-access-token',
        refreshToken: 'user-refresh-token',
        expiresIn: 3600,
      },
      principal('user-a'),
    );
    assert.deepEqual(where.profileId_name_tenantId_userId, {
      profileId: 'crm',
      name: 'per-user',
      tenantId: 'tenant-a',
      userId: 'user-a',
    });
    assert.equal(status.connected, true);
    assert.doesNotMatch(
      JSON.stringify(status),
      /ciphertext|accessToken|refreshToken|user-access-token|user-refresh-token/i,
    );
    assert.equal(
      decryptCredential({
        ciphertext: stored.accessTokenCiphertext,
        iv: stored.accessTokenIv,
        authTag: stored.accessTokenAuthTag,
      }),
      'user-access-token',
    );
    assert.deepEqual(await tools.userCredentialStatus('crm', principal('user-b')), {
      connected: false,
      authStatus: 'DISCONNECTED',
      tokenExpiresAt: null,
      lastRefreshedAt: null,
    });
  } finally {
    if (previousKey === undefined) delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  }
});

test('expired per-user OAuth credentials rotate under the refresh lease', async () => {
  const previousKey = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  const oldAccess = encryptCredential('expired-access-token');
  const oldRefresh = encryptCredential('old-refresh-token');
  const row: any = {
    id: 'credential',
    profileId: 'crm',
    tenantId: 'tenant-a',
    userId: 'user-a',
    authStrategy: 'OAUTH2_REFRESH',
    authStatus: 'ACTIVE',
    credentialVersion: 1,
    tokenExpiresAt: new Date(0),
    accessTokenCiphertext: oldAccess.ciphertext,
    accessTokenIv: oldAccess.iv,
    accessTokenAuthTag: oldAccess.authTag,
    refreshTokenCiphertext: oldRefresh.ciphertext,
    refreshTokenIv: oldRefresh.iv,
    refreshTokenAuthTag: oldRefresh.authTag,
  };
  const db = {
    customToolConnectionCredential: {
      findUnique: async () => ({ ...row }),
      updateMany: async ({ where, data }: any) => {
        if (where.OR) {
          if (row.credentialVersion !== where.credentialVersion || row.refreshLeaseUntil) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
        if (
          where.credentialVersion === row.credentialVersion &&
          row.refreshLeaseId === where.refreshLeaseId
        ) {
          if (data.credentialVersion?.increment) row.credentialVersion += data.credentialVersion.increment;
          const { credentialVersion: _increment, ...changes } = data;
          Object.assign(row, changes);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    customToolConnectionProfile: {
      findUnique: async () => ({
        enabled: true,
        authStrategy: 'OAUTH2_REFRESH',
        tokenUrl: 'https://8.8.8.8/token',
        clientId: 'client',
      }),
    },
  };
  try {
    const tools = new BackendTools(db as any);
    (tools as any).oauthCredentials = {
      refresh: async (_profile: any, refresh: string) => {
        assert.equal(refresh, 'old-refresh-token');
        return {
          accessToken: 'rotated-access-token',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 3600,
        };
      },
    };
    assert.equal(
      await (tools as any).refreshConnectionCredential(row, false, 'tenant-a'),
      'rotated-access-token',
    );
    assert.equal(row.credentialVersion, 2);
    assert.equal(
      decryptCredential({
        ciphertext: row.refreshTokenCiphertext,
        iv: row.refreshTokenIv,
        authTag: row.refreshTokenAuthTag,
      }),
      'rotated-refresh-token',
    );
  } finally {
    if (previousKey === undefined) delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  }
});

test('revoked credential sessions fail closed and legacy auth fields infer SHARED', async () => {
  const tools = new BackendTools({
    customToolConnectionCredential: {
      findUnique: async () => ({
        id: 'credential',
        tenantId: 'tenant-a',
        userId: 'user-a',
        authStatus: 'REVOKED',
        credentialVersion: 1,
      }),
    },
  } as any);
  await assert.rejects(
    (tools as any).refreshConnectionCredential(
      {
        id: 'credential',
        tenantId: 'tenant-a',
        userId: 'user-a',
        credentialVersion: 1,
      },
      false,
      'tenant-a',
    ),
    /CONNECTION_AUTHENTICATION_FAILED/,
  );
  assert.equal((tools as any).toolAuthScope({ authSecretId: 'legacy-secret' }), 'SHARED');
  assert.equal(
    (tools as any).toolAuthScope({ connectionCredentialId: 'legacy-shared-credential' }),
    'SHARED',
  );
  assert.equal((tools as any).toolAuthScope({}), 'NONE');
});
