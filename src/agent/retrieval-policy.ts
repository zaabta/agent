import type { DocumentSearchHit } from '../typegraph/typegraph.service.js';

export type ContextTurn = { role: 'user' | 'assistant'; content: string };

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

/** A cited prior turn can resolve discourse references, but is never evidence.
 * Limit the override to explicit follow-up references; unrelated conversation
 * still uses the planner's ordinary-conversation path. */
export function isEvidenceFollowUp(message: string, history: ContextTurn[]): boolean {
  if (!history.some(turn => turn.role === 'assistant' && /\[\[[^\]]+\]\]/u.test(turn.content))) return false;
  const text = message.normalize('NFKD').toLocaleLowerCase().replace(/\p{M}/gu, '').replace(/ı/g, 'i');
  return /\b(?:it|them|those|these|previous|second|first)\b|\bwhat about\b/iu.test(text)
    || /\b(?:ikisini|onceki|ikinci|peki|onun|onu|onlari|bunlari)\b/iu.test(text)
    || /(?:ماذا عن|عنها|عنهم|بينهما|السابق|الثاني|الاول)/u.test(text);
}
