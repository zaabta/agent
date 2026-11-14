import { isEvidenceFollowUp, type ContextTurn, type FollowUpContext } from './retrieval-policy.js';
import { z } from 'zod';

export const MAX_CONVERSATION_EVIDENCE_REFERENCES = 12;
export const conversationEntitiesSchema = z.array(z.string().max(500)).max(30);
export const conversationEvidenceReferencesSchema = z.array(z.object({
  documentId: z.string().uuid(),
  filename: z.string().max(500),
  sourceRef: z.string().max(1000),
  documentVersionId: z.string().uuid().optional(),
})).max(MAX_CONVERSATION_EVIDENCE_REFERENCES);

export interface ConversationEvidenceReference {
  documentId: string;
  filename: string;
  sourceRef: string;
  documentVersionId?: string;
}

/** Previous references are search hints only when recent discourse/context indicates continuity. */
export function evidenceReferencesForRequest<T extends ConversationEvidenceReference>(
  message: string,
  history: ContextTurn[],
  references: T[],
  context: FollowUpContext = {},
): T[] {
  return isEvidenceFollowUp(message, history, { ...context, evidenceRefs: references }) ? references.slice(0, MAX_CONVERSATION_EVIDENCE_REFERENCES) : [];
}

/** Extract compact durable decisions using language-aware markers. */
export function extractDecisionSentences(answer: string): string[] {
  return answer.split(/(?<=[.!?\u061f])\s+|\r?\n/u)
    .map(sentence => sentence.trim())
    .filter(sentence => {
      if (/\b(?:I will|we will|decided|decision|prefer|always|never)\b/iu.test(sentence)) return true;
      const folded = sentence.normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toLocaleLowerCase();
      return /(?:^|[^\p{L}])(?:karar(?:imiz)?|tercih(?:imiz|im)?|bundan sonra|daima|asla)(?=$|[^\p{L}])/iu.test(folded)
        || /(?:\u0633\u0623|\u0633\u0648\u0641|\u0642\u0631\u0631(?:\u062a|\u0646\u0627|\u0648\u0627)?|\u0627\u0644\u0642\u0631\u0627\u0631|\u0623\u0641\u0636\u0644|\u062a\u0641\u0636\u064a\u0644|\u062f\u0627\u0626\u0645\u0627|\u0623\u0628\u062f\u0627)/u.test(sentence);
    })
    .map(sentence => sentence.slice(0, 240));
}
