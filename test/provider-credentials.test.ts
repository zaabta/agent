import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type Type,
} from '@nestjs/common';
import { ApiAuthGuard } from '../src/auth/api-auth.guard.js';
import { INSTALLATION_OWNER_ONLY } from '../src/auth/installation-owner.decorator.js';
import { config } from '../src/config.js';
import { LlmController } from '../src/llm-admin/llm.controller.js';
import { CustomToolsController } from '../src/agent/custom-tools.controller.js';
import {
  credentialEncryptionAvailable,
  decryptCredential,
  encryptCredential,
} from '../src/llm-admin/provider-credentials.js';
import { LlmAdminService, supportsOpenAITools } from '../src/llm-admin/llm-admin.service.js';

test('cloud API credentials encrypt and decrypt with AES-GCM and reject tampering', () => {
  const previous = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const encrypted = encryptCredential('test-provider-secret');
    assert.notEqual(encrypted.ciphertext, 'test-provider-secret');
    assert.equal(decryptCredential(encrypted), 'test-provider-secret');
    assert.throws(() => decryptCredential({ ...encrypted, authTag: Buffer.alloc(16).toString('base64') }));
  } finally {
    if (previous === undefined) delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = previous;
  }
});

test('credential encryption readiness is safe and limited to the installation owner', () => {
  const previous = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  try {
    delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    assert.equal(credentialEncryptionAvailable(), false);
    assert.throws(() => encryptCredential('not-persisted'), /LLM_CREDENTIALS_ENCRYPTION_KEY_REQUIRED/);
    assert.deepEqual(new CustomToolsController({} as any, {} as any).connectionEncryptionStatus(), { available: false });
    process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = 'not-a-key';
    assert.equal(credentialEncryptionAvailable(), false);
    process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    assert.equal(credentialEncryptionAvailable(), true);
    assert.deepEqual(new CustomToolsController({} as any, {} as any).connectionEncryptionStatus(), { available: true });
    assert.equal(Reflect.getMetadata(INSTALLATION_OWNER_ONLY, CustomToolsController.prototype.connectionEncryptionStatus), true);
  } finally {
    if (previous === undefined) delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = previous;
  }
});

type RouteHandler = (...args: any[]) => any;
function guardFor(
  userId?: string,
  handler: RouteHandler = LlmController.prototype.saveCredential,
  controller: Type = LlmController,
) {
  const request: any = { headers: { authorization: 'Bearer test' } };
  const context: any = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controller,
  };
  const auth: any = {
    validateAccessToken: async () => {
      if (!userId) throw new UnauthorizedException();
      return { userId, tenantId: 'tenant', authMethod: 'jwt' };
    },
  };
  const reflector: any = {
    getAllAndOverride: (_key: string, targets: object[]) =>
      targets.some((target) => Reflect.getMetadata(INSTALLATION_OWNER_ONLY, target)),
  };
  return new ApiAuthGuard(auth, reflector).canActivate(context);
}

test('credential endpoints require a JWT from the configured installation owner', async () => {
  const previousOwner = config.installationOwnerUserId;
  (config as any).installationOwnerUserId = 'owner-user';
  for (const handler of [
    LlmController.prototype.saveCredential,
    LlmController.prototype.revokeCredential,
    LlmController.prototype.testCredential,
  ]) {
    assert.equal(Reflect.getMetadata(INSTALLATION_OWNER_ONLY, handler), true);
    await assert.rejects(guardFor(undefined, handler), UnauthorizedException);
    await assert.rejects(guardFor('ordinary-user', handler), ForbiddenException);
    assert.equal(await guardFor('owner-user', handler), true);
  }
  (config as any).installationOwnerUserId = undefined;
  await assert.rejects(guardFor('ordinary-user'), ServiceUnavailableException);
  (config as any).installationOwnerUserId = previousOwner;
});

test('custom tool management routes reject non-owner accounts', async () => {
  const previousOwner = config.installationOwnerUserId;
  (config as any).installationOwnerUserId = 'owner-user';
  try {
    const handlers = Object.getOwnPropertyNames(CustomToolsController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => (CustomToolsController.prototype as any)[name] as RouteHandler)
      .filter((handler) => Reflect.getMetadata(INSTALLATION_OWNER_ONLY, handler) === true);
    for (const handler of handlers) {
      assert.equal(Reflect.getMetadata(INSTALLATION_OWNER_ONLY, handler), true);
      await assert.rejects(guardFor(undefined, handler, CustomToolsController), UnauthorizedException);
      await assert.rejects(guardFor('ordinary-user', handler, CustomToolsController), ForbiddenException);
      assert.equal(await guardFor('owner-user', handler, CustomToolsController), true);
    }
  } finally {
    (config as any).installationOwnerUserId = previousOwner;
  }
});

test('credential replacement is encrypted at rest, effective immediately, audited without the key, and excluded from runtime settings', async () => {
  const previous = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const rows = new Map<string, any>(),
    audits: any[] = [];
  const prisma: any = {
    providerCredential: {
      findUnique: async ({ where }: any) => rows.get(where.provider) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const row = { ...(rows.get(where.provider) ?? create), ...update };
        rows.set(where.provider, row);
        return row;
      },
      deleteMany: async ({ where }: any) => ({ count: Number(rows.delete(where.provider)) }),
    },
    runtimeSetting: { findMany: async () => [] },
    runtimeSettingAudit: {
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      },
    },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const service = new LlmAdminService(prisma);
  try {
    const result = await service.saveCredential('openai', 'test-openai-secret', 'super-admin');
    assert.deepEqual(result, { provider: 'openai', configured: true, source: 'database' });
    assert.equal(JSON.stringify(rows.get('openai')).includes('test-openai-secret'), false);
    const settings = await service.settings();
    assert.deepEqual(Object.keys(settings.secrets).sort(), [
      'geminiConfigured',
      'openaiConfigured',
      'openrouterConfigured',
    ]);
    assert.deepEqual(audits[0], {
      key: 'CREDENTIAL_OPENAI',
      oldValue: 'not-configured',
      newValue: 'configured',
      updatedBy: 'super-admin',
    });
    const { effectiveCredential } = await import('../src/llm-admin/provider-credentials.js');
    assert.equal((await effectiveCredential(prisma, 'openai')).key, 'test-openai-secret');
    await assert.rejects(
      service.updateSettings({ OPENAI_API_KEY: 'test-openai-secret' }, 'super-admin'),
      BadRequestException,
    );
  } finally {
    if (previous === undefined) delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = previous;
  }
});

test('GPT-6 model family is recognized as compatible during catalog discovery and model testing', () => {
  for (const modelId of ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra'])
    assert.equal(supportsOpenAITools(modelId), true, modelId);
  assert.equal(supportsOpenAITools('gpt-5.6-sol'), true);
  assert.equal(supportsOpenAITools('text-embedding-3-large'), false);
});
