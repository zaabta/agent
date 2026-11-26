import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { TypegraphService } from '../typegraph/typegraph.service.js';
import type { StructuredDataService } from '../documents/structured-data.service.js';
import type { BackendTools } from './backend-tools.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RuntimeModelSnapshot } from '../llm-admin/runtime-model.js';
import type { StructuredSelection } from './structured-selection.js';
import { type AgentEvidencePackage, type EvidenceReferenceBinding } from './evidence.js';
import { createExternalGptMasker } from './external-gpt-policy.js';
import {
  createAgentToolRegistry,
  plannedToolSelection,
  type ToolCatalogEntry,
  type ToolEvidenceResult,
} from './tool-registry.js';
import { createSemanticRouter } from './semantic-router.js';
import { createPlannerNode, type AgentPlan } from './planner-node.js';
import { createAnswerProvider } from './answer-provider.js';
import { createEvidencePreparationNodes } from './evidence-preparation-nodes.js';
import type {
  GraphTurn,
  GraphProgress,
  GraphUsage,
  RouterModel,
  PlannerModel,
  AnswerModel,
  GraphSource,
} from './graph-model-types.js';
export type {
  GraphTurn,
  GraphProgress,
  GraphUsage,
  RouterModel,
  PlannerModel,
  AnswerModel,
  GraphSource,
} from './graph-model-types.js';

export type GraphResult = {
  answer: string;
  sources: GraphSource[];
  persistenceSources: GraphSource[];
  evidenceReferences: Array<{
    claimIndex: number;
    evidenceIds: string[];
    sources: GraphSource[];
  }>;
  toolsCalled: string[];
  citationValidation: 'valid' | 'no-evidence' | 'fallback';
  verificationStatus: 'unverified' | 'not_required';
  outcome: 'success' | 'empty' | 'clarification' | 'failure';
  executionStatus: 'completed' | 'failed';
  requestId: string;
  llmCalls: number;
};
export const SITEPILOT_GRAPH_EDGES = [
  'START->router',
  'router->planner|tool_executor',
  'planner->tool_executor',
  'tool_executor->evidence_collection',
  'evidence_collection->source_resolution',
  'source_resolution->evidence_validation',
  'evidence_validation->answer_provider',
  'answer_provider->finalization',
  'finalization->END',
] as const;
type ToolResult = ToolEvidenceResult;

const GraphState = Annotation.Root({
  message: Annotation<string>,
  history: Annotation<GraphTurn[]>,
  memories: Annotation<Array<{ category: string; content: string }>>,
  previousSelection: Annotation<StructuredSelection | undefined>,
  previousContext: Annotation<
    | { summary?: string; entities?: string[]; sources?: Array<{ filename: string; sourceRef: string }> }
    | undefined
  >,
  principal: Annotation<AuthPrincipal>,
  signal: Annotation<AbortSignal>,
  requestId: Annotation<string>,
  runtime: Annotation<{
    router: RuntimeModelSnapshot;
    planner: RuntimeModelSnapshot;
    answer: RuntimeModelSnapshot;
  }>,
  backendTools: Annotation<BackendTools | undefined>,
  progress: Annotation<GraphProgress | undefined>,
  route: Annotation<'workspace' | 'conversation'>,
  catalog: Annotation<ToolCatalogEntry[]>,
  plan: Annotation<AgentPlan | undefined>,
  toolResults: Annotation<ToolResult[]>,
  toolsCalled: Annotation<string[]>,
  answerStrategy: Annotation<string | undefined>,
  evidence: Annotation<AgentEvidencePackage | undefined>,
  bindings: Annotation<EvidenceReferenceBinding[]>,
  publicBindings: Annotation<EvidenceReferenceBinding[]>,
  persistenceSources: Annotation<GraphSource[]>,
  answer: Annotation<string>,
  claims: Annotation<Array<{ text: string; evidenceIds: string[] }>>,
  missingInformation: Annotation<string[]>,
  tableHeaders: Annotation<string[]>,
  sources: Annotation<GraphSource[]>,
  evidenceReferences: Annotation<
    Array<{ claimIndex: number; evidenceIds: string[]; sources: GraphSource[] }>
  >,
  evidenceReadiness: Annotation<'authorized' | 'no-evidence' | 'invalid'>,
  citationValidation: Annotation<GraphResult['citationValidation']>,
  verificationStatus: Annotation<GraphResult['verificationStatus']>,
  outcome: Annotation<GraphResult['outcome']>,
  llmCalls: Annotation<number>,
});

/** Build a request-scoped graph. Existing TypeGraph and authorized BackendTools remain the only data access paths. */
export function createLangGraphOrchestrator(deps: {
  typegraph: TypegraphService;
  structuredData?: StructuredDataService;
  principal: AuthPrincipal;
  backendTools?: BackendTools;
  runtime: { router: RuntimeModelSnapshot; planner: RuntimeModelSnapshot; answer: RuntimeModelSnapshot };
  progress?: GraphProgress;
  onUsage?: (record: GraphUsage) => Promise<void> | void;
  onPlannerDiagnostic?: (diagnostic: {
    requestId: string;
    tenantId: string;
    availableToolIds: string[];
    selectedOperation: string;
    selectedToolId?: string;
    schemaValidationOutcome: string;
  }) => Promise<void> | void;
  models?: { router: RouterModel; planner: PlannerModel; answer: AnswerModel };
}) {
  const privacy = createExternalGptMasker(deps.principal.tenantId);
  const toolRegistry = createAgentToolRegistry(deps);
  const router = createSemanticRouter({
    catalog: toolRegistry.catalog,
    privacy,
    model: deps.models?.router,
    onUsage: deps.onUsage,
  });
  const planner = createPlannerNode({
    privacy,
    model: deps.models?.planner,
    onUsage: deps.onUsage,
    onDiagnostic: deps.onPlannerDiagnostic,
  });
  const toolExecutor = async (state: typeof GraphState.State) => {
    await state.progress?.('stage', {
      stage: 'tool_execution',
      status: 'in_progress',
      message: 'Executing authorized tools',
    });
    const selection = plannedToolSelection(state.plan ?? { operation: 'respond' }, state.message);
    if (!selection) return { toolResults: [], toolsCalled: [] };
    const result = await toolRegistry.execute(selection, {
      principal: state.principal,
      signal: state.signal,
      requestId: state.requestId,
      previousSelection: state.previousSelection,
      maxContextChars: state.runtime.answer.maxContextChars ?? config.answerMaxContextChars,
      catalog: state.catalog,
      backendTools: state.backendTools,
      progress: state.progress,
      restore: (value) => {
        const restoreValue = (item: unknown): unknown =>
          typeof item === 'string'
            ? privacy.restore(item)
            : Array.isArray(item)
              ? item.map(restoreValue)
              : item && typeof item === 'object'
                ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, restoreValue(child)]))
                : item;
        return restoreValue(value);
      },
    });
    if (result.status === 'invalid')
      return {
        plan: {
          operation: 'clarify',
          reply: 'The selected tool needs valid arguments. Please clarify the requested filters or details.',
        },
        toolResults: [],
        toolsCalled: [],
      };
    if (result.status === 'unavailable')
      return {
        plan: {
          operation: 'clarify',
          reply: 'I could not safely select an available capability. Please clarify your request.',
        },
        toolResults: [],
        toolsCalled: [],
      };
    return {
      toolResults: [result.result],
      toolsCalled: [result.result.name],
      answerStrategy: result.answerStrategy,
    };
  };

  const { evidenceCollection, sourceResolution, evidenceValidation } = createEvidencePreparationNodes({
    privacy,
  });
  const answerProvider = createAnswerProvider({ privacy, model: deps.models?.answer, onUsage: deps.onUsage });
  const finalization = async (state: typeof GraphState.State) => {
    await state.progress?.('stage', {
      stage: 'finalization',
      status: 'in_progress',
      message: 'Assembling final response',
    });
    const claims = state.claims.map((claim, claimIndex) => ({
      claimIndex,
      text: privacy.mask(claim.text),
      evidenceIds: claim.evidenceIds,
    }));
    const body = state.tableHeaders.length
      ? [
          `| ${state.tableHeaders.join(' | ')} |`,
          `| ${state.tableHeaders.map(() => '---').join(' | ')} |`,
          ...claims.map((claim) => claim.text),
        ].join('\n')
      : claims.map((claim) => claim.text).join('\n\n');
    const answer = [
      body,
      ...((state as any).missingInformation ?? []).map(
        (value: string) => `Missing information: ${privacy.mask(value)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    await state.progress?.('stage', {
      stage: 'finalization',
      status: 'completed',
      message: 'Final response assembled',
    });
    const evidenceReferences = claims.map(({ claimIndex, evidenceIds }) => ({
      claimIndex,
      evidenceIds,
      sources: evidenceIds.flatMap(
        (id) => state.publicBindings.find((binding) => binding.evidenceId === id)?.sources ?? [],
      ),
    }));
    const sources = [
      ...new Map(
        evidenceReferences
          .flatMap((reference) => reference.sources)
          .map((source) => [
            `${source.documentId}:${source.documentVersionId ?? ''}:${source.chunkId ?? source.chunkIndex}:${source.sourceRef}`,
            source,
          ]),
      ).values(),
    ];
    return {
      answer,
      evidenceReferences,
      sources,
      persistenceSources: state.persistenceSources,
      verificationStatus:
        state.route === 'workspace'
          ? state.evidenceReadiness === 'authorized'
            ? ('unverified' as const)
            : ('not_required' as const)
          : ('not_required' as const),
      outcome: state.outcome,
    };
  };

  const graph = new StateGraph(GraphState)
    .addNode('router', router)
    .addNode('planner', planner)
    .addNode('tool_executor', toolExecutor)
    .addNode('evidence_collection', evidenceCollection)
    .addNode('source_resolution', sourceResolution)
    .addNode('evidence_validation', evidenceValidation)
    .addNode('answer_provider', answerProvider)
    .addNode('finalization', finalization)
    .addEdge(START, 'router')
    .addConditionalEdges('router', (state) => (state.route === 'workspace' ? 'planner' : 'tool_executor'), {
      planner: 'planner',
      tool_executor: 'tool_executor',
    })
    .addEdge('planner', 'tool_executor')
    .addEdge('tool_executor', 'evidence_collection')
    .addEdge('evidence_collection', 'source_resolution')
    .addEdge('source_resolution', 'evidence_validation')
    .addEdge('evidence_validation', 'answer_provider')
    .addEdge('answer_provider', 'finalization')
    .addEdge('finalization', END)
    .compile();

  return {
    graph,
    async invoke(input: {
      message: string;
      history: GraphTurn[];
      signal: AbortSignal;
      memories?: Array<{ category: string; content: string }>;
      previousSelection?: StructuredSelection;
      previousContext?: {
        summary?: string;
        entities?: string[];
        sources?: Array<{ filename: string; sourceRef: string }>;
      };
    }): Promise<GraphResult> {
      const requestId = randomUUID();
      const state = await graph.invoke({
        message: input.message,
        history: input.history,
        memories: input.memories ?? [],
        previousSelection: input.previousSelection,
        previousContext: input.previousContext,
        principal: deps.principal,
        signal: input.signal,
        requestId,
        runtime: deps.runtime,
        backendTools: deps.backendTools,
        progress: deps.progress,
        route: 'conversation',
        catalog: [],
        plan: undefined,
        toolResults: [],
        toolsCalled: [],
        answerStrategy: undefined,
        evidence: undefined,
        bindings: [],
        publicBindings: [],
        persistenceSources: [],
        answer: '',
        claims: [],
        missingInformation: [],
        tableHeaders: [],
        sources: [],
        evidenceReferences: [],
        evidenceReadiness: 'authorized',
        citationValidation: 'valid',
        verificationStatus: 'not_required',
        outcome: 'success',
        llmCalls: 0,
      });
      return {
        answer: state.answer,
        sources: state.sources,
        persistenceSources: state.persistenceSources,
        evidenceReferences: state.evidenceReferences,
        toolsCalled: state.toolsCalled,
        citationValidation: state.citationValidation,
        verificationStatus: state.verificationStatus,
        outcome: state.outcome,
        executionStatus: 'completed',
        requestId,
        llmCalls: state.llmCalls,
      };
    },
  };
}
