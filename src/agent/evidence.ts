import type { ContextTurn } from './retrieval-policy.js';

export type EvidenceScope = { tenantId: string; userId?: string };
export type DocumentCitation = {
  documentId: string;
  filename: string;
  chunkIndex: number;
  documentVersionId?: string;
  chunkId?: string;
  pageNumber?: number;
  contentHash?: string;
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
export type AgentEvidence = DocumentEvidence | RegisteredToolEvidence | StructuredEvidence | ConversationContextEvidence;
export type AgentEvidencePackage = {
  requestId: string;
  scope: EvidenceScope;
  items: AgentEvidence[];
};

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
    if (typeof result?.customToolId === 'string' && Object.hasOwn(result, 'data')) {
      items.push({
        id: `T${++toolIndex}`, type: 'registered-tool', scope: input.scope,
        requestId: input.requestId, toolId: result.customToolId,
        ...(Number.isInteger(result.configurationVersion) ? { version: result.configurationVersion } : {}),
        data: result.data,
      });
      continue;
    }
    if (entry.name.startsWith('structured') || result?.operation || Array.isArray(result?.sources) || Array.isArray(result?.records) || Array.isArray(result?.groups)) {
      items.push({ id: `S${++structuredIndex}`, type: 'structured', scope: input.scope,
        ...(entry.input !== undefined ? { input: entry.input } : {}),
        ...(typeof result.operation === 'string' ? { operation: result.operation } : {}), data: result });
    }
    if (!['documentSearch', 'listDocuments', 'datasetDiscovery'].includes(entry.name) && !entry.name.startsWith('structured')) {
      items.push({ id: `T${++toolIndex}`, type: 'registered-tool', scope: input.scope, requestId: input.requestId,
        toolId: typeof result?.customToolId === 'string' ? result.customToolId : entry.name,
        ...(Number.isInteger(result?.configurationVersion) ? { version: result.configurationVersion } : {}),
        data: Object.hasOwn(result ?? {}, 'data') ? result.data : result });
    }
    for (const hit of result?.hits ?? []) {
      const citation = hit?.citation;
      if (typeof hit?.sourceRef !== 'string' || !hit.sourceRef || typeof hit.content !== 'string'
        || typeof citation?.documentId !== 'string' || typeof citation.filename !== 'string' || !Number.isInteger(citation.chunkIndex)) continue;
      const key = `${citation.documentId}:${citation.documentVersionId ?? 'legacy'}:${citation.chunkId ?? citation.chunkIndex}:${hit.sourceRef}`;
      if (seenDocuments.has(key)) continue;
      seenDocuments.add(key);
      items.push({ id: `E${++documentIndex}`, type: 'document', scope: input.scope,
        sourceRef: hit.sourceRef, citation, content: hit.content });
    }
  }
  for (const [index, turn] of input.history.entries()) items.push({
    id: `C${index + 1}`, type: 'conversation-context', verified: false, role: turn.role, content: turn.content,
  });
  return { requestId: input.requestId, scope: input.scope, items };
}
