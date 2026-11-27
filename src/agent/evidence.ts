import type { ContextTurn } from './retrieval-policy.js';

export type EvidenceScope = { tenantId: string; userId?: string };
export type DocumentCitation = {
  documentId: string;
  filename: string;
  chunkIndex: number;
  documentVersionId?: string;
  chunkId?: string;
  pageNumber?: number;
  location?: string;
  headingPath?: string[];
  sheetName?: string;
  rowStart?: number;
  rowEnd?: number;
  rowNumbers?: number[];
  cellRange?: string;
  cellRefs?: string[];
  matchedCell?: string;
  contentHash?: string;
  chunkerVersion?: string;
  paragraphStart?: number;
  paragraphEnd?: number;
};
export type DocumentEvidence = {
  id: string;
  type: 'document';
  scope: EvidenceScope;
  sourceRef: string;
  citation: DocumentCitation;
  content: string;
};
export type RegisteredToolEvidence = {
  id: string;
  type: 'registered-tool';
  scope: EvidenceScope;
  requestId: string;
  toolId: string;
  version?: number;
  data: unknown;
};
export type StructuredEvidence = {
  id: string;
  type: 'structured';
  scope: EvidenceScope;
  operation?: string;
  input?: unknown;
  data: unknown;
};
export type ConversationContextEvidence = {
  id: string;
  type: 'conversation-context';
  verified: false;
  role: ContextTurn['role'];
  content: string;
};
export type AgentEvidence =
  DocumentEvidence | RegisteredToolEvidence | StructuredEvidence | ConversationContextEvidence;
export type AgentEvidencePackage = {
  requestId: string;
  scope: EvidenceScope;
  items: AgentEvidence[];
};
export type ResolvedEvidenceSource = {
  citationId: string;
  documentId: string;
  documentVersionId?: string;
  chunkId?: string;
  pageNumber?: number;
  location?: string;
  headingPath?: string[];
  sheetName?: string;
  rowStart?: number;
  rowEnd?: number;
  rowNumbers?: number[];
  cellRange?: string;
  cellRefs?: string[];
  matchedCell?: string;
  contentHash?: string;
  paragraphStart?: number;
  paragraphEnd?: number;
  filename: string;
  sourceRef: string;
  chunkIndex: number;
};
export type EvidenceReferenceBinding = {
  evidenceId: string;
  sourceRefs: string[];
  sources: ResolvedEvidenceSource[];
  toolId?: string;
};
export type EvidenceReadiness = 'authorized' | 'no-evidence' | 'invalid';
export type EvidencePreparationResult = { readiness: EvidenceReadiness; issues: string[] };

/** Convert only current-request authorized results into typed provenance. */
export function createEvidencePackage(input: {
  requestId: string;
  scope: EvidenceScope;
  toolResults: Array<{ name: string; result: any; input?: unknown }>;
  history: ContextTurn[];
}): AgentEvidencePackage {
  const items: AgentEvidence[] = [];
  const seenDocuments = new Set<string>();
  let documentIndex = 0;
  let toolIndex = 0;
  let structuredIndex = 0;

  for (const entry of input.toolResults) {
    const result = entry.result;
    if (entry.name === 'listDocuments' || entry.name === 'datasetDiscovery') {
      const records = Array.isArray(result?.documents)
        ? result.documents
        : Array.isArray(result?.datasets)
          ? result.datasets
          : [];
      const evidenceSummary = records.length
        ? entry.name === 'listDocuments'
          ? 'Documents available in the authorized inventory.'
          : 'Authorized structured dataset schemas.'
        : entry.name === 'listDocuments'
          ? 'There are no indexed documents.'
          : 'There are no authorized structured datasets.';
      items.push({
        id: `S${++structuredIndex}`,
        type: 'structured',
        scope: input.scope,
        ...(entry.input !== undefined ? { input: entry.input } : {}),
        data: { ...result, evidenceSummary },
      });
    }
    if (typeof result?.customToolId === 'string' && Object.hasOwn(result, 'data')) {
      items.push({
        id: `T${++toolIndex}`,
        type: 'registered-tool',
        scope: input.scope,
        requestId: input.requestId,
        toolId: result.customToolId,
        ...(Number.isInteger(result.configurationVersion) ? { version: result.configurationVersion } : {}),
        data: result.data,
      });
      continue;
    }
    if (
      entry.name.startsWith('structured') ||
      result?.operation ||
      Array.isArray(result?.sources) ||
      Array.isArray(result?.records) ||
      Array.isArray(result?.groups)
    ) {
      if (Array.isArray(result?.records) && result.records.length) {
        for (const record of result.records)
          items.push({
            id: `S${++structuredIndex}`,
            type: 'structured',
            scope: input.scope,
            ...(entry.input !== undefined ? { input: entry.input } : {}),
            ...(typeof result.operation === 'string' ? { operation: result.operation } : {}),
            data: { ...result, records: undefined, record, sources: record?.source ? [record.source] : [] },
          });
      } else if (Array.isArray(result?.groups) && result.groups.length) {
        for (const group of result.groups)
          items.push({
            id: `S${++structuredIndex}`,
            type: 'structured',
            scope: input.scope,
            ...(entry.input !== undefined ? { input: entry.input } : {}),
            operation: String(result.operation),
            data: {
              operation: result.operation,
              columnName: result.columnName,
              group,
              sources: group?.sources ?? [],
            },
          });
      } else
        items.push({
          id: `S${++structuredIndex}`,
          type: 'structured',
          scope: input.scope,
          ...(entry.input !== undefined ? { input: entry.input } : {}),
          ...(typeof result.operation === 'string' ? { operation: result.operation } : {}),
          data: result,
        });
    }
    if (
      !['documentSearch', 'listDocuments', 'datasetDiscovery'].includes(entry.name) &&
      !entry.name.startsWith('structured')
    ) {
      items.push({
        id: `T${++toolIndex}`,
        type: 'registered-tool',
        scope: input.scope,
        requestId: input.requestId,
        toolId: typeof result?.customToolId === 'string' ? result.customToolId : entry.name,
        ...(Number.isInteger(result?.configurationVersion) ? { version: result.configurationVersion } : {}),
        data: Object.hasOwn(result ?? {}, 'data') ? result.data : result,
      });
    }
    for (const hit of result?.hits ?? []) {
      const citation = hit?.citation;
      if (
        typeof hit?.sourceRef !== 'string' ||
        !hit.sourceRef ||
        typeof hit.content !== 'string' ||
        typeof citation?.documentId !== 'string' ||
        typeof citation.filename !== 'string' ||
        !Number.isInteger(citation.chunkIndex)
      )
        continue;
      const key = `${citation.documentId}:${citation.documentVersionId ?? 'legacy'}:${citation.chunkId ?? citation.chunkIndex}:${hit.sourceRef}`;
      if (seenDocuments.has(key)) continue;
      seenDocuments.add(key);
      items.push({
        id: `E${++documentIndex}`,
        type: 'document',
        scope: input.scope,
        sourceRef: hit.sourceRef,
        citation: {
          ...citation,
          ...(typeof hit.metadata?.location === 'string' ? { location: hit.metadata.location } : {}),
          ...(Array.isArray(hit.metadata?.headingPath) ? { headingPath: hit.metadata.headingPath } : {}),
          ...(typeof hit.metadata?.sheetName === 'string' ? { sheetName: hit.metadata.sheetName } : {}),
          ...(Number.isInteger(hit.metadata?.rowStart) ? { rowStart: hit.metadata.rowStart } : {}),
          ...(Number.isInteger(hit.metadata?.rowEnd) ? { rowEnd: hit.metadata.rowEnd } : {}),
          ...(Number.isInteger(hit.metadata?.rowNumber)
            ? { rowStart: hit.metadata.rowNumber, rowEnd: hit.metadata.rowNumber, rowNumbers: [hit.metadata.rowNumber] }
            : {}),
          ...(Array.isArray(hit.metadata?.rowNumbers) ? { rowNumbers: hit.metadata.rowNumbers } : {}),
          ...(typeof hit.metadata?.cellRange === 'string' ? { cellRange: hit.metadata.cellRange } : {}),
          ...(Array.isArray(hit.metadata?.cellRefs) ? { cellRefs: hit.metadata.cellRefs } : {}),
          ...(typeof hit.metadata?.matchedCell === 'string' ? { matchedCell: hit.metadata.matchedCell } : {}),
        },
        content: hit.content,
      });
    }
  }
  for (const [index, turn] of input.history.entries())
    items.push({
      id: `C${index + 1}`,
      type: 'conversation-context',
      verified: false,
      role: turn.role,
      content: turn.content,
    });
  return { requestId: input.requestId, scope: input.scope, items };
}

function sourceFromDocument(item: DocumentEvidence): ResolvedEvidenceSource {
  const citation = item.citation;
  return {
    citationId: item.id,
    documentId: citation.documentId,
    filename: citation.filename,
    sourceRef: item.sourceRef,
    chunkIndex: citation.chunkIndex,
    ...(citation.documentVersionId ? { documentVersionId: citation.documentVersionId } : {}),
    ...(citation.chunkId ? { chunkId: citation.chunkId } : {}),
    ...(Number.isInteger(citation.pageNumber) ? { pageNumber: citation.pageNumber } : {}),
    ...(citation.location ? { location: citation.location } : {}),
    ...(citation.headingPath ? { headingPath: citation.headingPath } : {}),
    ...(citation.sheetName ? { sheetName: citation.sheetName } : {}),
    ...(Number.isInteger(citation.rowStart) ? { rowStart: citation.rowStart } : {}),
    ...(Number.isInteger(citation.rowEnd) ? { rowEnd: citation.rowEnd } : {}),
    ...(Array.isArray(citation.rowNumbers) ? { rowNumbers: citation.rowNumbers } : {}),
    ...(citation.cellRange ? { cellRange: citation.cellRange } : {}),
    ...(citation.cellRefs ? { cellRefs: citation.cellRefs } : {}),
    ...(citation.matchedCell ? { matchedCell: citation.matchedCell } : {}),
    ...(citation.contentHash ? { contentHash: citation.contentHash } : {}),
    ...(Number.isInteger(citation.paragraphStart) ? { paragraphStart: citation.paragraphStart } : {}),
    ...(Number.isInteger(citation.paragraphEnd) ? { paragraphEnd: citation.paragraphEnd } : {}),
  };
}

function structuredSources(item: StructuredEvidence): ResolvedEvidenceSource[] {
  const data = item.data as any;
  const candidates = [
    ...(Array.isArray(data?.sources) ? data.sources : []),
    ...(Array.isArray(data?.records)
      ? data.records.map((record: any) => record?.source).filter(Boolean)
      : []),
    ...(data?.record?.source ? [data.record.source] : []),
    ...(Array.isArray(data?.group?.sources) ? data.group.sources : []),
  ];
  const seen = new Set<string>();
  return candidates
    .filter(
      (source: any) =>
        source &&
        typeof source.documentId === 'string' &&
        typeof source.filename === 'string' &&
        typeof source.sourceRef === 'string' &&
        Number.isInteger(source.chunkIndex),
    )
    .filter((source: any) => {
      const key = `${source.documentId}:${source.documentVersionId ?? ''}:${source.chunkId ?? source.chunkIndex}:${source.sourceRef}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((source: any) => ({
      citationId: item.id,
      documentId: source.documentId,
      filename: source.filename,
      sourceRef: source.sourceRef,
      chunkIndex: source.chunkIndex,
      ...(source.documentVersionId ? { documentVersionId: source.documentVersionId } : {}),
      ...(source.chunkId ? { chunkId: source.chunkId } : {}),
      ...(Number.isInteger(source.pageNumber) ? { pageNumber: source.pageNumber } : {}),
      ...(typeof source.location === 'string' ? { location: source.location } : {}),
      ...(Array.isArray(source.headingPath) ? { headingPath: source.headingPath } : {}),
      ...(typeof source.sheetName === 'string' ? { sheetName: source.sheetName } : {}),
      ...(Number.isInteger(source.rowNumber) ? { rowStart: source.rowNumber, rowEnd: source.rowNumber } : {}),
      ...(Number.isInteger(source.rowStart) ? { rowStart: source.rowStart } : {}),
      ...(Number.isInteger(source.rowEnd) ? { rowEnd: source.rowEnd } : {}),
      ...(Array.isArray(source.rowNumbers) ? { rowNumbers: source.rowNumbers } : {}),
      ...(typeof source.cellRange === 'string' ? { cellRange: source.cellRange } : {}),
      ...(Array.isArray(source.cellRefs) ? { cellRefs: source.cellRefs } : {}),
      ...(typeof source.matchedCell === 'string' ? { cellRange: source.matchedCell } : {}),
      ...(typeof source.matchedCell === 'string' ? { matchedCell: source.matchedCell } : {}),
      ...(source.contentHash ? { contentHash: source.contentHash } : {}),
      ...(Number.isInteger(source.paragraphStart) ? { paragraphStart: source.paragraphStart } : {}),
      ...(Number.isInteger(source.paragraphEnd) ? { paragraphEnd: source.paragraphEnd } : {}),
    }));
}

/** Resolve every evidence identity before the Answer Provider is invoked. */
export function resolveEvidenceSources(evidence: AgentEvidencePackage): {
  bindings: EvidenceReferenceBinding[];
  sources: ResolvedEvidenceSource[];
} {
  const bindings: EvidenceReferenceBinding[] = [];
  const sources = new Map<string, ResolvedEvidenceSource>();
  let citationIndex = 0;
  for (const item of evidence.items) {
    if (item.type === 'conversation-context') continue;
    const candidates =
      item.type === 'document'
        ? [sourceFromDocument(item)]
        : item.type === 'structured'
          ? structuredSources(item)
          : [];
    const seenBindingSources = new Set<string>();
    const resolved: ResolvedEvidenceSource[] = [];
    for (const source of candidates) {
      const key = `${source.documentId}:${source.documentVersionId ?? ''}:${source.chunkId ?? source.chunkIndex}:${source.sourceRef}`;
      if (seenBindingSources.has(key)) continue;
      seenBindingSources.add(key);
      const registered = sources.get(key);
      if (registered) {
        resolved.push(registered);
        continue;
      }
      const citation = { ...source, citationId: `C${++citationIndex}` };
      sources.set(key, citation);
      resolved.push(citation);
    }
    bindings.push({
      evidenceId: item.id,
      sourceRefs: resolved.map((source) => source.sourceRef),
      sources: resolved,
      ...(item.type === 'registered-tool' ? { toolId: item.toolId } : {}),
    });
  }
  return { bindings, sources: [...sources.values()] };
}

/** Validate scope, stable evidence identities, source provenance, and structured result relationships before answer generation. */
export function validateEvidencePackage(input: {
  evidence: AgentEvidencePackage;
  bindings: EvidenceReferenceBinding[];
  tenantId: string;
  userId: string;
  requireEvidence: boolean;
}): EvidencePreparationResult {
  const issues = new Set<string>();
  const ids = new Set<string>();
  const bindingIds = new Set(input.bindings.map((binding) => binding.evidenceId));
  if (input.evidence.scope.tenantId !== input.tenantId || input.evidence.scope.userId !== input.userId)
    issues.add('authorization_scope_mismatch');
  for (const item of input.evidence.items) {
    if (item.type === 'conversation-context') continue;
    if (ids.has(item.id)) issues.add('duplicate_evidence_identity');
    ids.add(item.id);
    if (item.scope.tenantId !== input.tenantId || item.scope.userId !== input.userId)
      issues.add('authorization_scope_mismatch');
    if (!bindingIds.has(item.id)) issues.add('unresolved_evidence_identity');
    if (item.type === 'document') {
      if (
        !item.sourceRef ||
        !item.citation.documentId ||
        !item.citation.filename ||
        !Number.isInteger(item.citation.chunkIndex)
      )
        issues.add('invalid_document_provenance');
      if (
        !input.bindings
          .find((binding) => binding.evidenceId === item.id)
          ?.sources.some((source) => source.sourceRef === item.sourceRef)
      )
        issues.add('unresolved_source_reference');
    }
    if (item.type === 'registered-tool' && (!item.toolId || item.requestId !== input.evidence.requestId))
      issues.add('invalid_tool_provenance');
    if (item.type === 'structured') {
      const data = item.data as any;
      const resolvedSources = input.bindings.find((binding) => binding.evidenceId === item.id)?.sources ?? [];
      const rawSources = structuredSources(item);
      if (rawSources.length !== resolvedSources.length) issues.add('unresolved_source_reference');
      const operation = item.operation ?? data?.operation;
      if (
        ['SUM', 'AVG', 'MIN', 'MAX'].includes(operation) &&
        data?.value !== null &&
        data?.value !== undefined &&
        (!Number.isFinite(Number(data.value)) || rawSources.length === 0)
      )
        issues.add('unresolved_structured_value_provenance');
      if (
        data?.record &&
        (!data.record.source ||
          !resolvedSources.some((source) => source.sourceRef === data.record.source.sourceRef))
      )
        issues.add('unresolved_structured_record');
      if (data?.group && (!Array.isArray(data.group.sources) || !data.group.sources.length))
        issues.add('unresolved_structured_group');
    }
  }
  if (issues.size) return { readiness: 'invalid', issues: [...issues] };
  const hasEvidence = input.evidence.items.some((item) => item.type !== 'conversation-context');
  if (input.requireEvidence && !hasEvidence) return { readiness: 'no-evidence', issues: [] };
  return { readiness: 'authorized', issues: [] };
}
