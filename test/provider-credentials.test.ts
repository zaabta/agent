import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ApiAuthGuard } from '../src/auth/api-auth.guard.js';
import { INSTALLATION_OWNER_ONLY } from '../src/auth/installation-owner.decorator.js';
import { config } from '../src/config.js';
import { LlmController } from '../src/llm-admin/llm.controller.js';
import { decryptCredential, encryptCredential } from '../src/llm-admin/provider-credentials.js';
import { LlmAdminService } from '../src/llm-admin/llm-admin.service.js';
import { asMastraModel } from '../src/mastra/runtime-model.js';

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

function guardFor(userId?: string, handler: Function = LlmController.prototype.saveCredential) {
  const request: any = { headers: { authorization: 'Bearer test' } };
  const context: any = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => LlmController };
  const auth: any = { validateAccessToken: async () => { if (!userId) throw new UnauthorizedException(); return { userId, tenantId: 'tenant', authMethod: 'jwt' }; } };
  const reflector: any = { getAllAndOverride: (_key: string, targets: Function[]) => targets.some(target => Reflect.getMetadata(INSTALLATION_OWNER_ONLY, target)) };
  return new ApiAuthGuard(auth, reflector).canActivate(context);
}

test('credential endpoints require a JWT from the configured installation owner', async () => {
  const previousOwner = config.installationOwnerUserId;
  (config as any).installationOwnerUserId = 'owner-user';
  for (const handler of [LlmController.prototype.saveCredential, LlmController.prototype.revokeCredential, LlmController.prototype.testCredential]) {
    assert.equal(Reflect.getMetadata(INSTALLATION_OWNER_ONLY, handler), true);
    await assert.rejects(guardFor(undefined, handler), UnauthorizedException);
    await assert.rejects(guardFor('ordinary-user', handler), ForbiddenException);
    assert.equal(await guardFor('owner-user', handler), true);
  }
  (config as any).installationOwnerUserId = undefined;
  await assert.rejects(guardFor('ordinary-user'), ServiceUnavailableException);
  (config as any).installationOwnerUserId = previousOwner;
});

test('credential replacement is encrypted at rest, effective immediately, audited without the key, and excluded from runtime settings', async () => {
  const previous = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const rows = new Map<string, any>(), audits: any[] = [];
  const prisma: any = {
    providerCredential: {
      findUnique: async ({ where }: any) => rows.get(where.provider) ?? null,
      upsert: async ({ where, create, update }: any) => { const row = { ...(rows.get(where.provider) ?? create), ...update }; rows.set(where.provider, row); return row; },
      deleteMany: async ({ where }: any) => ({ count: Number(rows.delete(where.provider)) }),
    },
    runtimeSetting: { findMany: async () => [] },
    runtimeSettingAudit: { create: async ({ data }: any) => { audits.push(data); return data; } },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const service = new LlmAdminService(prisma);
  try {
    const result = await service.saveCredential('openai', 'test-openai-secret', 'super-admin');
    assert.deepEqual(result, { provider: 'openai', configured: true, source: 'database' });
    assert.equal(JSON.stringify(rows.get('openai')).includes('test-openai-secret'), false);
    const settings = await service.settings();
    assert.deepEqual(Object.keys(settings.secrets).sort(), ['geminiConfigured', 'openaiConfigured', 'openrouterConfigured']);
    assert.deepEqual(audits[0], { key: 'CREDENTIAL_OPENAI', oldValue: 'not-configured', newValue: 'configured', updatedBy: 'super-admin' });
    const { effectiveCredential } = await import('../src/llm-admin/provider-credentials.js');
    assert.equal((await effectiveCredential(prisma, 'openai')).key, 'test-openai-secret');
    await assert.rejects(service.updateSettings({ OPENAI_API_KEY: 'test-openai-secret' }, 'super-admin'), BadRequestException);
  } finally {
    if (previous === undefined) delete process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.LLM_CREDENTIALS_ENCRYPTION_KEY = previous;
  }
});

test('OpenAI model IDs create the official chat adapter used for tool and streaming calls', () => {
  const model: any = asMastraModel({ provider: 'openai', model: 'gpt-4.1-mini', ollamaThink: false, apiKey: 'test-only-key' }).primary;
  assert.equal(model.modelId, 'gpt-4.1-mini');
  assert.equal(model.config.provider, 'openai.chat');
  assert.equal(typeof model.doGenerate, 'function');
  assert.equal(typeof model.doStream, 'function');
});
