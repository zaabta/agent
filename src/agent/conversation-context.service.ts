import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { StructuredSelection } from './structured-selection.js';
import { extractDecisionSentences } from './conversation-context.js';

export interface ConversationSourceReference {
  documentId: string;
  filename: string;
  sourceRef: string;
  chunkIndex: number;
  documentVersionId?: string;
}

@Injectable()
export class ConversationContextService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  load(conversationId: string, principal: AuthPrincipal) {
    return this.prisma.conversationContext?.findFirst({
      where: { conversationId, tenantId: principal.tenantId, ownerId: principal.userId },
      select: { evidenceRefs: true, activeSelection: true, summary: true },
    }) ?? Promise.resolve(null);
  }

  saveTurn(
    conversationId: string,
    principal: AuthPrincipal,
    answer: string,
    sources: ConversationSourceReference[],
    selection: StructuredSelection | undefined,
    preserveContext: boolean,
  ) {
    const contextModel = this.prisma.conversationContext;
    if (!contextModel?.upsert) return undefined;

    const validSources = sources.filter(source => source.documentId && source.filename && source.sourceRef && Number.isInteger(source.chunkIndex)).slice(0, 12);
    const references = validSources.map(({ documentId, filename, sourceRef, documentVersionId }) => ({ documentId, filename, sourceRef, ...(documentVersionId ? { documentVersionId } : {}) }));
    const update: Record<string, unknown> = {
      entities: [...new Set([...references.map(ref => ref.filename), ...(selection ? Object.values(selection).filter((item): item is string => typeof item === 'string') : [])])].slice(-30),
      decisions: extractDecisionSentences(answer).slice(-20),
      summary: [...references.map(ref => `Context: ${ref.filename}`), ...extractDecisionSentences(answer).map(item => `Decision: ${item}`)].join('\n').slice(-2000),
    };
    if (validSources.length || !preserveContext) update.evidenceRefs = references;
    if (selection) update.activeSelection = selection;
    else if (!preserveContext) update.activeSelection = Prisma.DbNull;
    return contextModel.upsert({
      where: { conversationId },
      create: { conversationId, tenantId: principal.tenantId, ownerId: principal.userId, evidenceRefs: references, ...update },
      update,
    });
  }
}
