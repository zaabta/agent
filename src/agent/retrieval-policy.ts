import type { DocumentSearchHit } from '../typegraph/typegraph.service.js';

export type ContextTurn = { role: 'user' | 'assistant'; content: string };
export interface FollowUpContext {
  entities?: string[];
  summary?: string;
  evidenceRefs?: Array<{ filename?: string }>;
  activeSelection?: unknown;
}

/** History is discourse context only; it must never become a source citation. */
export function boundedConversationContext(history: ContextTurn[], maxMessages = 10, maxChars = 12000): ContextTurn[] {
  if (maxMessages <= 0 || maxChars <= 0) return [];
  const selected: ContextTurn[] = [];
  let remaining = maxChars;
  for (const turn of history.slice(-maxMessages).reverse()) {
    if (remaining <= 0) break;
    const content = turn.content.slice(0, Math.min(3000, remaining));
    if (content.trim()) selected.push({ role: turn.role, content });
    remaining -= content.length;
  }
  return selected.reverse();
}

export function retrievalQueries(query: string, focused: string[] = []): string[] {
  const unique = new Map<string, string>();
  for (const q of focused.map(q => q.trim()).filter(Boolean)) if (!unique.has(q.toLocaleLowerCase())) unique.set(q.toLocaleLowerCase(), q);
  const queries = [...unique.values()].slice(0, 4);
  return queries.length >= 2 ? queries : [query.trim()];
}

/** Reciprocal rank fusion across query results. Scores are query-local, not probabilities.
 * Round-robin document selection prevents a long document consuming the evidence budget.
 * Only complete passages fit: exact source references and content remain unchanged.
 */
export function mergeRetrievalEvidence(lists: DocumentSearchHit[][], maxHits = 8, maxChars = 18000): DocumentSearchHit[] {
  const ranked = new Map<string, { hit: DocumentSearchHit; score: number }>();
  for (const hits of lists) {
    const seen = new Set<string>();
    hits.forEach((hit, index) => {
      const key = `${hit.citation.documentId}:${hit.citation.documentVersionId ?? 'legacy'}:${hit.citation.chunkId ?? hit.citation.chunkIndex}`;
      if (seen.has(key)) return;
      seen.add(key);
      const previous = ranked.get(key);
      ranked.set(key, { hit: previous?.hit ?? hit, score: (previous?.score ?? 0) + 1 / (60 + index + 1) });
    });
  }
  const groups = new Map<string, DocumentSearchHit[]>();
  for (const { hit } of [...ranked.values()].sort((a, b) => b.score - a.score)) {
    const group = groups.get(hit.citation.documentId) ?? [];
    group.push(hit);
    groups.set(hit.citation.documentId, group);
  }
  const selected: DocumentSearchHit[] = [];
  let chars = 0;
  while (selected.length < maxHits && groups.size) {
    for (const [id, group] of groups) {
      const hit = group.shift()!;
      if (!group.length) groups.delete(id);
      if (chars + hit.content.length > maxChars) continue;
      selected.push(hit);
      chars += hit.content.length;
      if (selected.length === maxHits) break;
    }
  }
  return selected;
}

/** Detect discourse continuity from recent history and bounded persistent context.
 * This signal only enables authorized retrieval; it never promotes context into evidence. */
export function isEvidenceFollowUp(message: string, history: ContextTurn[], context: FollowUpContext = {}): boolean {
  if (!message.trim() || !history.some(turn => turn.role === 'assistant')) return false;
  const text = normalizeForComparison(message);
  const recent = history.slice(-8).map(turn => turn.content).join(' ');
  const memory = [context.summary ?? '', ...(context.entities ?? []), ...(context.evidenceRefs ?? []).map(ref => ref.filename ?? '')].join(' ');
  const prior = normalizeForComparison(`${recent} ${memory}`);

  // Discourse connectives work across languages; context availability prevents
  // a short continuation-shaped first message from inheriting unrelated state.
  if (/^(?:why|how so|and why|what do you mean)[?.!\s]*$/iu.test(text)
    || /^(?:neden|nicin|nasil yani)[?.!\s]*$/iu.test(text.replace(/ı/g, 'i'))
    || /^(?:\u0644\u0645\u0627\u0630\u0627|\u0643\u064a\u0641 \u0630\u0644\u0643)[\u061f?.!\s]*$/u.test(text)) return true;
  const continuationCue = /\b(?:what about|and|also|compare|contrast|which one|why|how so|same|previous|above|more detail|in that case)\b/iu.test(text)
    || /(?:bunlar|onlar|onceki|ikincisi|ikisini|peki|bunun|buna|ayni|orada|ayrica|karsilastir)/iu.test(text)
    || /(?:\u0648\u0645\u0627\u0630\u0627|\u0645\u0627\u0630\u0627 \u0639\u0646|\u0648\u0628\u0627\u0644\u0646\u0633\u0628\u0629|\u0645\u0627 \u0631\u0623\u064a\u0643|\u0642\u0627\u0631\u0646|\u0628\u064a\u0646\u0647\u0645\u0627|\u0641\u064a\u0647\u0627|\u0641\u064a\u0647\u0645|\u0647\u0630\u0627|\u0647\u0630\u0647|\u0627\u0644\u0633\u0627\u0628\u0642|\u0623\u064a\u0636)/u.test(text);
  const explicitReference = /\b(?:it|its|they|them|their|those|these|this|that|there|same|previous|above)\b/iu.test(text)
    || /(?:bunlar|onlar|ikincisi|ikisini|onun|bunun|buna|ayni|orada)/iu.test(text)
    || /(?:\u0647\u0630\u0627|\u0647\u0630\u0647|\u0630\u0644\u0643|\u062a\u0644\u0643|\u0647\u0645|\u0647\u0646|\u0647\u0627|\u0647\u0645\u0627|\u0647\u0646\u0627|\u0628\u064a\u0646\u0647\u0645\u0627|\u0648\u0645\u0627\u0630\u0627 \u0639\u0646|\u0645\u0627\u0630\u0627 \u0639\u0646|\u0648\u0628\u0627\u0644\u0646\u0633\u0628\u0629|\u0642\u0627\u0631\u0646 \u0628\u064a\u0646)/u.test(text);
  if (explicitReference && continuationCue) return true;

  const currentTerms = contentTerms(text);
  const priorTerms = contentTerms(prior);
  if (!currentTerms.size || !priorTerms.size) return false;
  let overlap = 0;
  for (const term of currentTerms) {
    const match = priorTerms.has(term) || (term.length >= 5 && [...priorTerms].some(priorTerm => priorTerm.length >= 5 && (term.startsWith(priorTerm.slice(0, 5)) || priorTerm.startsWith(term.slice(0, 5)))));
    if (match) overlap++;
  }
  const overlapRatio = overlap / currentTerms.size;
  const namedReference = [...(context.entities ?? []), ...(context.evidenceRefs ?? []).map(ref => ref.filename ?? '')]
    .some(item => item.length > 2 && text.includes(normalizeForComparison(item)));
  const selectionContinuity = context.activeSelection !== undefined && context.activeSelection !== null && overlapRatio >= 0.2;
  return namedReference || overlapRatio >= 0.34 || selectionContinuity || (continuationCue && overlapRatio >= 0.2);
}

function normalizeForComparison(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

function contentTerms(value: string): Set<string> {
  const stopWords = new Set(['the', 'and', 'what', 'about', 'its', 'with', 'from', 'this', 'that', 'which', 'more', 'detail', 'peki']);
  return new Set((value.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(term => !stopWords.has(term)));
}
