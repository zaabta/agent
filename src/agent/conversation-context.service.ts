import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { StructuredSelection } from './structured-selection.js';
import { extractDecisionSentences, MAX_CONVERSATION_EVIDENCE_REFERENCES } from './conversation-context.js';

export const CONVERSATION_CONTEXT_LIMITS = {
  evidenceReferences: MAX_CONVERSATION_EVIDENCE_REFERENCES,
  entities: 30,
  decisions: 20,
  summaryCharacters: 2000,
  summaryEntries: 24,
} as const;

export interface ConversationSourceReference {
  documentId: string;
  filename: string;
  sourceRef: string;
  chunkIndex: number;
  documentVersionId?: string;
}

type ConversationContextRow = {
  tenantId: string;
  ownerId: string;
  evidenceRefs: Prisma.JsonValue;
  entities: Prisma.JsonValue;
  decisions: Prisma.JsonValue;
  activeSelection: Prisma.JsonValue | null;
  summary: string | null;
};

const asStringList = (value: Prisma.JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const stableUnion = <T>(previous: T[], next: T[], limit: number): T[] => {
  const values = new Map<string, T>();
  for (const item of [...previous, ...next]) values.set(JSON.stringify(item), item);
  return [...values.values()].slice(-limit);
};

const boundedSummary = (previous: string | null, entries: string[]): string => {
  const lines = [...new Set([...(previous?.split('\n') ?? []), ...entries].filter(Boolean))]
    .slice(-CONVERSATION_CONTEXT_LIMITS.summaryEntries);
  let summary = lines.join('\n');
  if (summary.length > CONVERSATION_CONTEXT_LIMITS.summaryCharacters) {
    summary = summary.slice(-CONVERSATION_CONTEXT_LIMITS.summaryCharacters);
    const firstLine = summary.indexOf('\n');
    if (firstLine >= 0) summary = summary.slice(firstLine + 1);
  }
  return summary;
};

@Injectable()
export class ConversationContextService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  load(conversationId: string, principal: AuthPrincipal) {
    return this.prisma.conversationContext?.findFirst({
      where: { conversationId, tenantId: principal.tenantId, ownerId: principal.userId },
      select: { evidenceRefs: true, entities: true, decisions: true, activeSelection: true, summary: true },
    }) ?? Promise.resolve(null);
  }

  async saveTurn(
    transaction: Prisma.TransactionClient,
    conversationId: string,
    principal: AuthPrincipal,
    answer: string,
    sources: ConversationSourceReference[],
    selection: StructuredSelection | undefined,
    preserveContext: boolean,
  ): Promise<void> {
    const model = (transaction as Prisma.TransactionClient & { conversationContext?: Prisma.TransactionClient['conversationContext'] }).conversationContext;
    if (!model?.upsert || !model.findFirst) return;
    const previous = await model.findFirst({
      where: { conversationId },
      select: { tenantId: true, ownerId: true, evidenceRefs: true, entities: true, decisions: true, activeSelection: true, summary: true },
    }) as ConversationContextRow | null;
    if (previous && (previous.tenantId !== principal.tenantId || previous.ownerId !== principal.userId)) {
      throw new Error('CONVERSATION_CONTEXT_SCOPE_MISMATCH');
    }

    const validSources = sources
      .filter(source => source.documentId && source.filename && source.sourceRef && Number.isInteger(source.chunkIndex))
      .slice(0, CONVERSATION_CONTEXT_LIMITS.evidenceReferences)
      .map(({ documentId, filename, sourceRef, documentVersionId }) => ({ documentId, filename, sourceRef, ...(documentVersionId ? { documentVersionId } : {}) }));
    const previousRefs = Array.isArray(previous?.evidenceRefs) ? previous.evidenceRefs : [];
    // Old refs survive only a detected related turn; every use is still reauthorized by retrieval.
    const refs = preserveContext && validSources.length === 0
      ? stableUnion(previousRefs, [], CONVERSATION_CONTEXT_LIMITS.evidenceReferences)
      : preserveContext
        ? stableUnion(previousRefs, validSources, CONVERSATION_CONTEXT_LIMITS.evidenceReferences)
        : validSources;

    const decisions = stableUnion(asStringList(previous?.decisions), extractDecisionSentences(answer), CONVERSATION_CONTEXT_LIMITS.decisions);
    const oldDocumentNames = new Set(previousRefs.flatMap(ref => typeof ref === 'object' && ref !== null && 'filename' in ref && typeof ref.filename === 'string' ? [ref.filename] : []));
    const previousEntities = asStringList(previous?.entities).filter(entity => preserveContext || !oldDocumentNames.has(entity));
    const entities = stableUnion(previousEntities, [
      ...validSources.map(ref => ref.filename),
      ...(selection ? Object.values(selection).filter((item): item is string => typeof item === 'string') : []),
    ], CONVERSATION_CONTEXT_LIMITS.entities);
    const previousSummary = preserveContext
      ? previous?.summary ?? null
      : (previous?.summary ?? '').split('\n').filter(line => line.startsWith('Decision:')).join('\n') || null;
    const summaryEntries = [
      ...validSources.map(ref => `Context: ${ref.filename}`),
      ...extractDecisionSentences(answer).map(item => `Decision: ${item}`),
    ];
    const summary = boundedSummary(previousSummary, summaryEntries);
    const activeSelection = selection ?? (preserveContext ? previous?.activeSelection : undefined);

    await model.upsert({
      where: { conversationId },
      create: {
        conversationId,
        tenantId: principal.tenantId,
        ownerId: principal.userId,
        evidenceRefs: refs as Prisma.InputJsonValue,
        entities: entities as Prisma.InputJsonValue,
        decisions: decisions as Prisma.InputJsonValue,
        summary,
        activeSelection: activeSelection === undefined ? Prisma.DbNull : activeSelection as Prisma.InputJsonValue,
      },
      update: {
        evidenceRefs: refs as Prisma.InputJsonValue,
        entities: entities as Prisma.InputJsonValue,
        decisions: decisions as Prisma.InputJsonValue,
        summary,
        activeSelection: activeSelection === undefined ? Prisma.DbNull : activeSelection as Prisma.InputJsonValue,
      },
    });
  }
}
