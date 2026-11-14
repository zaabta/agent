import { BadRequestException } from '@nestjs/common';

export const memoryCategories = ['preference', 'fact', 'project', 'decision'] as const;
export type MemoryCategory = typeof memoryCategories[number];

const sensitivePattern = /(?:api[\s_-]*key|password|passcode|secret|private[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|bearer\s+[a-z0-9._~+/-]{12,}|\bcredential\b)/iu;

/** Validate small user-authored notes; document excerpts and secrets are not memories. */
export function validateUserMemory(content: unknown, category: unknown): { content: string; category: MemoryCategory } {
  if (typeof content !== 'string' || typeof category !== 'string' || !memoryCategories.includes(category as MemoryCategory)) {
    throw new BadRequestException('INVALID_MEMORY');
  }
  const normalized = content.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 3 || normalized.length > 500 || sensitivePattern.test(normalized)
    || /\[\[[^\]]+\]\]/u.test(normalized)
    || /(?:ignore (?:all )?(?:previous|prior) instructions|system prompt|developer message)/iu.test(normalized)) {
    throw new BadRequestException('MEMORY_NOT_ALLOWED');
  }
  return { content: normalized, category: category as MemoryCategory };
}
