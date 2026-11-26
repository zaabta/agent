import type { AgentEvidencePackage, AgentEvidence } from './evidence.js';

export type EvidenceClaim = { claimId: number; text: string; evidenceIds: string[] };
export type AnswerClaimSpan = { index: number; kind: 'paragraph' | 'list-item' | 'table-row'; text: string; startLine: number; endLine: number; startOffset: number; endOffset: number; evidenceIds: string[] };
export type EvidenceVerificationCode = 'authorization_scope_mismatch' | 'unknown_evidence_reference' | 'unreferenced_factual_claim' | 'numeric_value_not_in_source' | 'unit_not_in_source' | 'semantic_support_failed' | 'verification_input_too_large';

function references(text: string) {
  const found = [...text.matchAll(/\[(E\d+|T\d+|S\d+)\]|\[\[([^\]]+)\]\]|\(API: ([^)]+)\)/g)]
    .map(match => match[1] ?? match[2] ?? `API:${match[3]}`);
  return [...new Set(found)];
}

function withoutCitationMarkers(text: string) {
  return text.replace(/[ \t]*\[(?:E|T|S)\d+\]|[ \t]*\[\[[^\]]+\]\]|[ \t]*\(API: [^)]+\)/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function isTableSeparator(line: string) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

/** Split rendered prose into independently attributable claims while retaining
 * exact line spans for deterministic citation repair. Headings, table headers,
 * and colon-terminated lead-ins immediately followed by a list/table are layout,
 * not factual claims. */
export function answerClaimSpans(answer: string): AnswerClaimSpan[] {
  const normalizedAnswer = answer.replace(/\r\n/g, '\n');
  const lines = normalizedAnswer.split('\n');
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) { lineOffsets.push(offset); offset += line.length + 1; }
  type RawSpan = Omit<AnswerClaimSpan, 'index' | 'evidenceIds' | 'kind'> & { kind: AnswerClaimSpan['kind'] | 'heading' | 'structural' };
  const spans: RawSpan[] = [];
  let paragraphStartLine = 0;
  let paragraphStartOffset = 0;
  let paragraphEndOffset = 0;
  const pushSentenceSpans = (kind: 'paragraph' | 'list-item', text: string, startOffset: number, startLine: number, endLine: number) => {
    let segmentStart = 0;
    const boundaries = [...text.matchAll(/[.!?;؛](?:\s*\[(?:E|T|S)\d+\])*(?=\s|$)/gu)].map(match => (match.index ?? 0) + match[0].length)
      .filter(end => !/\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|fig|no|rev|vs)\.$/iu.test(withoutCitationMarkers(text.slice(segmentStart, end))));
    for (const segmentEnd of [...boundaries, text.length]) {
      const raw = text.slice(segmentStart, segmentEnd);
      const claim = raw.trim();
      if (claim) {
        const leading = raw.length - raw.trimStart().length;
        const trailing = raw.length - raw.trimEnd().length;
        const claimStart = startOffset + segmentStart + leading;
        const claimEnd = startOffset + segmentEnd - trailing;
        spans.push({ kind, text: claim, startLine: lineForOffset(lineOffsets, claimStart), endLine: lineForOffset(lineOffsets, Math.max(claimStart, claimEnd - 1)), startOffset: claimStart, endOffset: claimEnd });
      }
      segmentStart = segmentEnd;
    }
  };
  const flush = () => {
    if (paragraphEndOffset > paragraphStartOffset) {
      const raw = normalizedAnswer.slice(paragraphStartOffset, paragraphEndOffset);
      const text = raw.trim();
      if (text) pushSentenceSpans('paragraph', text, paragraphStartOffset + raw.indexOf(text), paragraphStartLine, lineForOffset(lineOffsets, paragraphEndOffset - 1));
    }
    paragraphStartLine = 0;
    paragraphStartOffset = 0;
    paragraphEndOffset = 0;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    if (/^#{1,6}\s/.test(trimmed) || /^Sources:/i.test(trimmed)) { flush(); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      if (isTableSeparator(line)) continue;
      const next = lines[index + 1] ?? '';
      if (/^\s*\|.*\|\s*$/.test(next) && isTableSeparator(next)) continue;
      const start = lineOffsets[index]! + line.indexOf(trimmed);
      spans.push({ kind: 'table-row', text: trimmed, startLine: index, endLine: index, startOffset: start, endOffset: start + trimmed.length });
      continue;
    }
    if (/^\s*(?:[-*+\u2022\u2013]\s+|[\d\u0660-\u0669]+[.)]\s+)/u.test(line)) {
      flush();
      const start = lineOffsets[index]! + line.indexOf(trimmed);
      spans.push({ kind: 'list-item', text: trimmed, startLine: index, endLine: index, startOffset: start, endOffset: start + trimmed.length });
      continue;
    }
    if (!paragraphEndOffset) {
      paragraphStartLine = index;
      paragraphStartOffset = lineOffsets[index]! + line.length - line.trimStart().length;
    }
    paragraphEndOffset = lineOffsets[index]! + line.trimEnd().length;
  }
  flush();

  for (let index = 0; index < spans.length - 1; index++) {
    const current = spans[index]!;
    const next = spans[index + 1]!;
    if (current.kind === 'paragraph' && /:\s*$/.test(current.text) && ['list-item', 'table-row'].includes(next.kind)) current.kind = 'structural';
  }
  return spans.filter((span): span is RawSpan & { kind: AnswerClaimSpan['kind'] } => ['paragraph', 'list-item', 'table-row'].includes(span.kind))
    .map((span, index) => ({ ...span, index, evidenceIds: references(span.text) }));
}

function lineForOffset(lineOffsets: number[], offset: number): number {
  let low = 0, high = lineOffsets.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (lineOffsets[mid]! <= offset) low = mid; else high = mid - 1; }
  return low;
}

export function unreferencedFactualSpans(answer: string): AnswerClaimSpan[] {
  return answerClaimSpans(answer).filter(span => span.evidenceIds.length === 0);
}

export function extractEvidenceClaims(answer: string): EvidenceClaim[] {
  return answerClaimSpans(answer).filter(span => span.evidenceIds.length > 0)
    .map((span, claimId) => ({ claimId, text: withoutCitationMarkers(span.text), evidenceIds: span.evidenceIds }));
}

/** Reposition citation markers at a complete claim boundary before rendering
 * provenance. Citation tokens are metadata and must not split values or IDs. */
export function renderCitationMarkersAtClaimEnd(answer: string): string {
  const spans = answerClaimSpans(answer).filter(span => span.evidenceIds.length).sort((a, b) => b.startOffset - a.startOffset);
  let result = answer.replace(/\r\n/g, '\n');
  for (const span of spans) {
    const raw = result.slice(span.startOffset, span.endOffset);
    const markers = [...new Set([...raw.matchAll(/\[(?:E|T|S)\d+\]/g)].map(match => match[0]))];
    if (!markers.length) continue;
    const clean = raw.replace(/\s*\[(?:E|T|S)\d+\]/g, '').replace(/[ \t]{2,}/g, ' ').trimEnd();
    const rendered = span.kind === 'table-row' && /\|\s*$/.test(clean)
      ? `${clean.replace(/\s*\|\s*$/, '')} ${markers.join(' ')} |`
      : `${clean} ${markers.join(' ')}`;
    result = `${result.slice(0, span.startOffset)}${rendered}${result.slice(span.endOffset)}`;
  }
  return result;
}

/** Remove only rejected, cited claim spans while retaining independently verified prose and rows. */
export function removeRejectedEvidenceClaims(answer: string, rejectedClaimIds: number[]): string {
  const spans = answerClaimSpans(answer).filter(span => span.evidenceIds.length);
  const rejected = new Set(rejectedClaimIds);
  const selected = spans.filter((_span, claimId) => rejected.has(claimId)).sort((a, b) => b.startOffset - a.startOffset);
  let result = answer.replace(/\r\n/g, '\n');
  for (const span of selected) {
    if (span.kind === 'table-row') {
      const lines = result.split('\n');
      if (lines[span.startLine] !== undefined) lines.splice(span.startLine, span.endLine - span.startLine + 1);
      result = lines.join('\n');
    } else result = `${result.slice(0, span.startOffset)}${result.slice(span.endOffset)}`;
  }
  return result.split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function hasUnreferencedFactualClaim(answer: string): boolean {
  return unreferencedFactualSpans(answer).length > 0;
}

function sourceText(item: AgentEvidence): string[] {
  if (item.type === 'document') return [item.content];
  if (item.type === 'registered-tool' || item.type === 'structured') {
    const values = [JSON.stringify(item.data) ?? ''];
    if (item.type === 'structured' && item.input !== undefined) values.push(JSON.stringify(item.input) ?? '');
    return values;
  }
  return [];
}

function referencedItems(reference: string, evidence: AgentEvidencePackage): AgentEvidence[] {
  if (/^[ETS]\d+$/.test(reference)) return evidence.items.filter(item => item.id === reference);
  if (reference.startsWith('API:')) return evidence.items.filter(item => item.type === 'registered-tool' && item.toolId === reference.slice(4).trim());
  return evidence.items.filter(item => item.type === 'document' && item.sourceRef === reference
    || item.type === 'structured' && Array.isArray((item.data as any)?.sources) && (item.data as any).sources.some((source: any) => source?.sourceRef === reference));
}

function numberValues(text: string) {
  const clean = text.replace(/\[(?:E|T|S)\d+\]|\[\[[^\]]+\]\]|\(API: [^)]+\)/g, ' ')
    .replace(/(?<![\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*\p{N}[\p{L}\p{N}_]*/gu, ' ');
  return [...clean.matchAll(/([$€£¥])?\s*(-?\d[\d,]*(?:\.\d+)?)(\s*(?:%|mm|cm|km|kg|lb|ft|in|°[CF]|m|g\b|USD\b|EUR\b|GBP\b|JPY\b|CAD\b|AUD\b|CHF\b|CNY\b|INR\b))?/gi)]
    .map(match => ({ value: match[2]!.replace(/,/g, ''), currency: match[1] ?? '', unit: (match[3] ?? '').trim().toLowerCase() }))
    .filter(item => item.value.length > 0);
}

export function verifyEvidenceClaims(input: {
  answer: string;
  evidence: AgentEvidencePackage;
  tenantId: string;
  userId?: string;
}): { claims: EvidenceClaim[]; reasonCodes: EvidenceVerificationCode[]; claimFailures: Array<{ claimId: number; reasonCodes: EvidenceVerificationCode[] }> } {
  const claims = extractEvidenceClaims(input.answer);
  const reasons = new Set<EvidenceVerificationCode>();
  const failures = new Map<number, Set<EvidenceVerificationCode>>();
  const fail = (claimId: number, reason: EvidenceVerificationCode) => {
    reasons.add(reason);
    const codes = failures.get(claimId) ?? new Set<EvidenceVerificationCode>();
    codes.add(reason);
    failures.set(claimId, codes);
  };
  for (const item of input.evidence.items) {
    if (item.type !== 'conversation-context' && (item.scope.tenantId !== input.tenantId || input.userId !== undefined && item.scope.userId !== input.userId)) {
      reasons.add('authorization_scope_mismatch');
    }
  }
  for (const claim of claims) {
    const cited = claim.evidenceIds.flatMap(id => referencedItems(id, input.evidence));
    if (!cited.length) { fail(claim.claimId, 'unknown_evidence_reference'); continue; }
    const texts = cited.flatMap(sourceText);
    for (const number of numberValues(claim.text)) {
      const valueFound = texts.some(text => number.value && numberValues(text).some(candidate => candidate.value === number.value));
      if (!valueFound) fail(claim.claimId, 'numeric_value_not_in_source');
      else if (number.currency || number.unit) {
        const unitFound = texts.some(text => (!number.currency || text.includes(number.currency)) && (!number.unit || text.toLowerCase().includes(number.unit)));
        if (!unitFound) fail(claim.claimId, 'unit_not_in_source');
      }
    }
  }
  return { claims, reasonCodes: [...reasons], claimFailures: [...failures].map(([claimId, codes]) => ({ claimId, reasonCodes: [...codes] })) };
}
