import { isEvidenceFollowUp, type ContextTurn } from './retrieval-policy.js';

export interface ConversationEvidenceReference {
  documentId: string;
  filename: string;
  sourceRef: string;
  documentVersionId?: string;
}

/** Old citations are available as search hints only for an explicit cited follow-up. */
export function evidenceReferencesForRequest<T extends ConversationEvidenceReference>(
  message: string,
  history: ContextTurn[],
  references: T[],
): T[] {
  return isEvidenceFollowUp(message, history) ? references.slice(0, 12) : [];
}

/** Extract compact decision context using language-aware markers; JS `\b` is ASCII-only. */
export function extractDecisionSentences(answer: string): string[] {
  return answer.split(/(?<=[.!?؟])\s+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => {
      if (/\b(?:I will|we will|decided|decision|prefer|always|never)\b/iu.test(sentence)) return true;
      const folded = sentence.normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toLocaleLowerCase();
      return /(?:^|[^\p{L}])(?:karar(?:imiz)?|tercih(?:imiz|im)?|bundan sonra|daima|asla)(?=$|[^\p{L}])/iu.test(folded)
        || /(?:سأ|سوف|قرر(?:ت|نا|وا)?|القرار|أفضل|تفضيل|دائمًا|ابدا|أبدًا)/u.test(sentence);
    })
    .map(sentence => sentence.slice(0, 240));
}
