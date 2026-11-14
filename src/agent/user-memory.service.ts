import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { validateUserMemory, type MemoryCategory } from './user-memory.js';

const MEMORY_CONTEXT_LIMIT = 8;
const ACTIVE_MEMORY_LIMIT = 100;

export interface UserMemoryContextEntry {
  category: MemoryCategory;
  content: string;
}

@Injectable()
export class UserMemoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async forPrompt(principal: AuthPrincipal): Promise<UserMemoryContextEntry[]> {
    const model = this.prisma.userMemory;
    if (!model?.findMany) return [];
    const entries = await model.findMany({
      where: { tenantId: principal.tenantId, userId: principal.userId, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: MEMORY_CONTEXT_LIMIT,
      select: { category: true, content: true },
    });
    return entries.filter((item): item is UserMemoryContextEntry =>
      ['preference', 'fact', 'project', 'decision'].includes(item.category),
    );
  }

  list(principal: AuthPrincipal) {
    return this.prisma.userMemory.findMany({
      where: { tenantId: principal.tenantId, userId: principal.userId, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: ACTIVE_MEMORY_LIMIT,
      select: { id: true, category: true, content: true, createdAt: true, updatedAt: true },
    });
  }

  create(input: { category?: unknown; content?: unknown }, principal: AuthPrincipal) {
    const memory = validateUserMemory(input.content, input.category);
    return this.prisma.userMemory.create({
      data: { tenantId: principal.tenantId, userId: principal.userId, ...memory },
      select: { id: true, category: true, content: true, createdAt: true, updatedAt: true },
    });
  }

  async update(id: string, input: { category?: unknown; content?: unknown }, principal: AuthPrincipal) {
    const memory = validateUserMemory(input.content, input.category);
    const result = await this.prisma.userMemory.updateMany({
      where: { id, tenantId: principal.tenantId, userId: principal.userId, deletedAt: null },
      data: memory,
    });
    if (!result.count) throw new NotFoundException('MEMORY_NOT_FOUND');
    return this.prisma.userMemory.findFirst({
      where: { id, tenantId: principal.tenantId, userId: principal.userId, deletedAt: null },
      select: { id: true, category: true, content: true, createdAt: true, updatedAt: true },
    });
  }

  async delete(id: string, principal: AuthPrincipal) {
    const result = await this.prisma.userMemory.updateMany({
      where: { id, tenantId: principal.tenantId, userId: principal.userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('MEMORY_NOT_FOUND');
    return { id, deleted: true };
  }
}
