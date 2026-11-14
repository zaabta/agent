import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';

export const CLOUD_PROVIDERS = ['google', 'openrouter', 'openai'] as const;
export type CloudProvider = typeof CLOUD_PROVIDERS[number];
export type EncryptedCredential = { ciphertext: string; iv: string; authTag: string };

function encryptionKey() {
  const value = process.env.LLM_CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new Error('LLM_CREDENTIALS_ENCRYPTION_KEY_REQUIRED');
  const key = /^[\da-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('LLM_CREDENTIALS_ENCRYPTION_KEY_INVALID');
  return key;
}

export function encryptCredential(secret: string): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decryptCredential(value: EncryptedCredential) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function environmentCredential(provider: CloudProvider) {
  return process.env[provider === 'google' ? 'GEMINI_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'];
}

export async function effectiveCredential(prisma: PrismaService, provider: CloudProvider): Promise<{ key?: string; source: 'database' | 'environment' | 'none' }> {
  const stored = (prisma as any).providerCredential?.findUnique
    ? await (prisma as any).providerCredential.findUnique({ where: { provider } })
    : null;
  if (stored) return { key: decryptCredential(stored), source: 'database' };
  const key = environmentCredential(provider);
  return key ? { key, source: 'environment' } : { source: 'none' };
}

export async function credentialStatus(prisma: PrismaService, provider: CloudProvider) {
  const stored = (prisma as any).providerCredential?.findUnique
    ? await (prisma as any).providerCredential.findUnique({ where: { provider }, select: { provider: true } })
    : null;
  if (stored) return { configured: true, source: 'database' as const };
  return environmentCredential(provider)
    ? { configured: true, source: 'environment' as const }
    : { configured: false, source: 'none' as const };
}
