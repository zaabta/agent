import type { AgentEvidencePackage, AgentEvidence } from './evidence.js';

export type EvidenceClaim = { claimId: number; text: string; evidenceIds: string[] };
export type EvidenceVerificationCode = 'authorization_scope_mismatch' | 'unknown_evidence_reference' | 'unreferenced_factual_claim' | 'numeric_value_not_in_source' | 'unit_not_in_source' | 'semantic_support_failed' | 'verification_input_too_large';

function references(text: string) {
  const found = [...text.matchAll(/\[(E\d+|T\d+|S\d+)\]|\[\[([^\]]+)\]\]|\(API: ([^)]+)\)/g)]
    .map(match => match[1] ?? match[2] ?? `API:${match[3]}`);
  return [...new Set(found)];
}

function isTableSeparator(line: string) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

export function extractEvidenceClaims(answer: string): EvidenceClaim[] {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push(paragraph.join(' ')); paragraph = []; };
  for (const line of answer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      if (!isTableSeparator(line)) blocks.push(trimmed);
    } else if (/^#{1,6}\s|^Sources:/i.test(trimmed)) {
      flush();
    } else paragraph.push(trimmed);
  }
  flush();
  return blocks.map((text, claimId) => ({ claimId, text, evidenceIds: references(text) })).filter(claim => claim.evidenceIds.length > 0);
}

export function hasUnreferencedFactualClaim(answer: string): boolean {
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(' ');
    paragraph = [];
    return Boolean(text && !references(text).length);
  };
  const lines = answer.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const text = line.trim();
    if (!text) { if (flush()) return true; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (flush()) return true;
      if (!isTableSeparator(line) && !isTableSeparator(lines[index + 1] ?? '') && !references(text).length) return true;
    } else if (/^#{1,6}\s|^Sources:/i.test(text)) {
      if (flush()) return true;
    } else paragraph.push(text);
  }
  return flush();
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
  const clean = text.replace(/\[(?:E|T|S)\d+\]|\[\[[^\]]+\]\]|\(API: [^)]+\)/g, ' ');
  return [...clean.matchAll(/([$€£¥])?\s*(-?\d[\d,]*(?:\.\d+)?)(\s*(?:%|mm|cm|km|kg|lb|ft|in|°[CF]|m|g\b|USD\b|EUR\b|GBP\b|JPY\b|CAD\b|AUD\b|CHF\b|CNY\b|INR\b))?/gi)]
    .map(match => ({ value: match[2]!.replace(/,/g, ''), currency: match[1] ?? '', unit: (match[3] ?? '').trim().toLowerCase() }))
    .filter(item => item.value.length > 0);
}

export function verifyEvidenceClaims(input: {
  answer: string;
  evidence: AgentEvidencePackage;
  tenantId: string;
  userId?: string;
}): { claims: EvidenceClaim[]; reasonCodes: EvidenceVerificationCode[] } {
  const claims = extractEvidenceClaims(input.answer);
  const reasons = new Set<EvidenceVerificationCode>();
  for (const item of input.evidence.items) {
    if (item.type !== 'conversation-context' && (item.scope.tenantId !== input.tenantId || input.userId !== undefined && item.scope.userId !== input.userId)) {
      reasons.add('authorization_scope_mismatch');
    }
  }
  for (const claim of claims) {
    const cited = claim.evidenceIds.flatMap(id => referencedItems(id, input.evidence));
    if (!cited.length) { reasons.add('unknown_evidence_reference'); continue; }
    const texts = cited.flatMap(sourceText);
    for (const number of numberValues(claim.text)) {
      const valueFound = texts.some(text => number.value && numberValues(text).some(candidate => candidate.value === number.value));
      if (!valueFound) reasons.add('numeric_value_not_in_source');
      else if (number.currency || number.unit) {
        const unitFound = texts.some(text => (!number.currency || text.includes(number.currency)) && (!number.unit || text.toLowerCase().includes(number.unit)));
        if (!unitFound) reasons.add('unit_not_in_source');
      }
    }
  }
  return { claims, reasonCodes: [...reasons] };
}
