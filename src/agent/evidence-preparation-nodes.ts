import type { AuthPrincipal } from '../auth/auth.types.js';
import type { GraphProgress, GraphTurn } from './graph-model-types.js';
import type { AgentPlan } from './planner-node.js';
import {
  createEvidencePackage,
  resolveEvidenceSources,
  validateEvidencePackage,
  type AgentEvidencePackage,
  type EvidenceReferenceBinding,
} from './evidence.js';
import type { ToolEvidenceResult } from './tool-registry.js';

export type EvidencePreparationState = {
  requestId: string;
  principal: AuthPrincipal;
  history: GraphTurn[];
  toolResults: ToolEvidenceResult[];
  route: 'workspace' | 'conversation';
  plan?: AgentPlan;
  evidence?: AgentEvidencePackage;
  bindings: EvidenceReferenceBinding[];
  progress?: GraphProgress;
};

export function createEvidencePreparationNodes(deps: { privacy: { mask: (value: string) => string } }) {
  const evidenceCollection = async (state: EvidencePreparationState) => {
    await state.progress?.('stage', {
      stage: 'tool_execution',
      status: 'completed',
      message: 'Authorized tool execution completed',
    });
    await state.progress?.('stage', {
      stage: 'evidence_collection',
      status: 'completed',
      message: 'Evidence collected',
    });
    return {
      evidence: createEvidencePackage({
        requestId: state.requestId,
        scope: { tenantId: state.principal.tenantId, userId: state.principal.userId },
        toolResults: state.toolResults,
        history: state.history,
      }),
    };
  };

  const sourceResolution = async (state: EvidencePreparationState) => {
    const resolved = resolveEvidenceSources(state.evidence!);
    await state.progress?.('stage', {
      stage: 'source_resolution',
      status: 'completed',
      message: 'Evidence sources resolved',
    });
    const sources = resolved.sources.map((source) => ({
      ...source,
      filename: deps.privacy.mask(source.filename),
      sourceRef: deps.privacy.mask(source.sourceRef),
      ...(source.location ? { location: deps.privacy.mask(source.location) } : {}),
      ...(source.headingPath ? { headingPath: source.headingPath.map(deps.privacy.mask) } : {}),
      ...(source.sheetName ? { sheetName: deps.privacy.mask(source.sheetName) } : {}),
    }));
    const publicBindings = resolved.bindings.map((binding) => ({
      ...binding,
      sources: binding.sources.map((source) => ({
        ...source,
        filename: deps.privacy.mask(source.filename),
        sourceRef: deps.privacy.mask(source.sourceRef),
        ...(source.location ? { location: deps.privacy.mask(source.location) } : {}),
        ...(source.headingPath ? { headingPath: source.headingPath.map(deps.privacy.mask) } : {}),
        ...(source.sheetName ? { sheetName: deps.privacy.mask(source.sheetName) } : {}),
      })),
    }));
    return { bindings: resolved.bindings, publicBindings, persistenceSources: resolved.sources, sources };
  };

  const evidenceValidation = async (state: EvidencePreparationState) => {
    const prepared = validateEvidencePackage({
      evidence: state.evidence!,
      bindings: state.bindings,
      tenantId: state.principal.tenantId,
      userId: state.principal.userId,
      requireEvidence: state.route === 'workspace' && state.plan?.operation !== 'clarify',
    });
    if (prepared.readiness === 'invalid') throw new Error('EVIDENCE_PACKAGE_INVALID');
    await state.progress?.('stage', {
      stage: 'evidence_validation',
      status: 'completed',
      message: 'Evidence authorization and provenance validated',
    });
    return {
      evidenceReadiness: prepared.readiness,
      citationValidation: prepared.readiness === 'authorized' ? ('valid' as const) : ('no-evidence' as const),
    };
  };

  return { evidenceCollection, sourceResolution, evidenceValidation };
}
