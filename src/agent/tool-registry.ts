import { z } from 'zod';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { StructuredDataService } from '../documents/structured-data.service.js';
import type { TypegraphService } from '../typegraph/typegraph.service.js';
import type { BackendTools } from './backend-tools.js';
import type { StructuredSelection } from './structured-selection.js';
import { mergeRetrievalEvidence } from './retrieval-policy.js';

export const rowFilterSchema = z.object({
  columnName: z.string().min(1).max(250),
  operator: z.enum(['EQ', 'CONTAINS', 'GT', 'GTE', 'LT', 'LTE']),
  value: z.string().max(1000),
});

export const builtinToolSchemas = {
  document_search: z.object({ query: z.string().min(2).max(600) }),
  list_documents: z.object({}),
  dataset_discovery: z.object({ documentId: z.string().uuid().optional() }),
  structured_data_lookup: z.object({ value: z.string().min(1).max(250) }),
  structured_data_analytics: z.object({
    operation: z.enum(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_BY', 'DISTINCT']),
    columnName: z.string().min(1).max(250).optional(),
    documentId: z.string().uuid().optional(),
    sheetName: z.string().max(250).optional(),
    groupLimit: z.number().int().min(1).max(100).optional(),
    filters: z.array(rowFilterSchema).max(8).optional(),
  }),
  structured_row_lookup: z.object({
    documentId: z.string().uuid().optional(),
    sheetName: z.string().max(250).optional(),
    filters: z.array(rowFilterSchema).min(1).max(8),
    limit: z.number().int().min(1).max(25).optional(),
  }),
};

export type ToolCatalogEntry = { id: string; description: string; input: unknown; version?: number };
export type ToolEvidenceResult = { name: string; result: unknown; input?: unknown };
export type ToolExecutionContext = {
  principal: AuthPrincipal;
  signal: AbortSignal;
  requestId: string;
  previousSelection?: StructuredSelection;
  maxContextChars: number;
  catalog: ToolCatalogEntry[];
  backendTools?: BackendTools;
  progress?: (event: string, data: Record<string, unknown>) => Promise<void> | void;
  restore: (value: unknown) => unknown;
};
export type PlannedToolSelection = { id: string; args: unknown };

type RegisteredTool = {
  id: string;
  progressName?: string;
  description: string;
  schema: z.ZodTypeAny;
  answerStrategy?: 'document-inventory' | 'dataset-inventory' | 'structured-rows';
  authorize: (args: unknown, context: ToolExecutionContext) => boolean;
  execute: (args: any, context: ToolExecutionContext) => Promise<unknown>;
  evidence: (result: unknown, args: unknown, context: ToolExecutionContext) => ToolEvidenceResult;
};

const scoped = (context: ToolExecutionContext) =>
  Boolean(context.principal.tenantId && context.principal.userId);

export function plannedToolSelection(
  plan: { operation: string; toolId?: string; query?: string; args?: Record<string, unknown> },
  message: string,
): PlannedToolSelection | undefined {
  if (plan.operation === 'retrieve') return { id: 'document_search', args: { query: plan.query ?? message } };
  if (plan.operation === 'registered_tool' && plan.toolId) return { id: plan.toolId, args: plan.args ?? {} };
  return undefined;
}

export function createAgentToolRegistry(deps: {
  typegraph: TypegraphService;
  structuredData?: StructuredDataService;
  backendTools?: BackendTools;
}) {
  const builtin = new Map<string, RegisteredTool>();
  const register = (tool: RegisteredTool) => {
    if (builtin.has(tool.id)) throw new Error('DUPLICATE_AGENT_TOOL_ID');
    builtin.set(tool.id, tool);
  };

  register({
    id: 'document_search',
    progressName: 'documentSearch',
    description: 'Search authorized document content with existing RAG.',
    schema: builtinToolSchemas.document_search,
    authorize: (_args, context) => scoped(context),
    execute: async ({ query }, context) => {
      const result = await deps.typegraph.searchDocuments(
        query,
        8,
        context.principal.tenantId,
        context.principal.userId,
        context.signal,
      );
      result.hits = mergeRetrievalEvidence(
        [result.hits],
        8,
        Math.max(2000, Math.min(18000, Math.round(context.maxContextChars * 0.6))),
      );
      return result;
    },
    evidence: (result) => ({ name: 'documentSearch', result }),
  });
  register({
    id: 'list_documents',
    description: 'List files only when the user requests workspace inventory.',
    schema: builtinToolSchemas.list_documents,
    answerStrategy: 'document-inventory',
    authorize: (_args, context) => scoped(context),
    execute: (_args, context) =>
      deps.typegraph.listDocuments(context.principal.tenantId, context.principal.userId),
    evidence: (result) => ({ name: 'listDocuments', result }),
  });
  if (deps.structuredData) {
    register({
      id: 'dataset_discovery',
      progressName: 'datasetDiscovery',
      description: 'Discover authorized CSV/Excel datasets and actual columns.',
      schema: builtinToolSchemas.dataset_discovery,
      answerStrategy: 'dataset-inventory',
      authorize: (_args, context) => scoped(context),
      execute: async ({ documentId }, context) => ({
        datasets: await deps.structuredData!.discoverDatasets(context.principal.tenantId, documentId),
      }),
      evidence: (result) => ({ name: 'datasetDiscovery', result }),
    });
    register({
      id: 'structured_data_lookup',
      progressName: 'structuredDataLookup',
      description: 'Search authorized structured rows for an exact cell value.',
      schema: builtinToolSchemas.structured_data_lookup,
      authorize: (_args, context) => scoped(context),
      execute: async ({ value }, context) =>
        (await deps.structuredData!.lookup(value, context.principal.tenantId)) ?? { hits: [] },
      evidence: (result) => ({ name: 'structuredDataLookup', result }),
    });
    register({
      id: 'structured_data_analytics',
      progressName: 'structuredDataAnalytics',
      description: 'Tenant scoped COUNT, SUM, AVG, MIN, MAX, GROUP_BY or DISTINCT over actual columns.',
      schema: builtinToolSchemas.structured_data_analytics,
      authorize: (_args, context) => scoped(context),
      execute: async (args, context) =>
        deps.structuredData!.aggregate(args.operation, args.columnName, context.principal.tenantId, {
          ...(args.documentId ? { documentId: args.documentId } : {}),
          ...(args.sheetName ? { sheetName: args.sheetName } : {}),
          ...(args.groupLimit ? { groupLimit: args.groupLimit } : {}),
          ...(context.previousSelection ? { selection: context.previousSelection } : {}),
          filters: args.filters ?? [],
        }),
      evidence: (result) => ({ name: 'structuredDataAnalytics', result }),
    });
    register({
      id: 'structured_row_lookup',
      progressName: 'structuredRowLookup',
      description: 'Find authorized structured rows using bounded schema column filters.',
      schema: builtinToolSchemas.structured_row_lookup,
      answerStrategy: 'structured-rows',
      authorize: (_args, context) => scoped(context),
      execute: async (args, context) =>
        deps.structuredData!.lookupRows(
          args.filters,
          context.principal.tenantId,
          {
            ...(args.documentId ? { documentId: args.documentId } : {}),
            ...(args.sheetName ? { sheetName: args.sheetName } : {}),
          },
          args.limit ?? 10,
        ),
      evidence: (result) => ({ name: 'structuredRowLookup', result }),
    });
  }

  async function catalog(principal: AuthPrincipal): Promise<ToolCatalogEntry[]> {
    const custom = (await deps.backendTools?.catalog(principal)) ?? [];
    const builtinCatalog = [...builtin.values()].map(({ id, description, schema }) => ({
      id,
      description,
      input: z.toJSONSchema(schema),
    }));
    return [...builtinCatalog, ...custom];
  }

  function resolve(id: string, context: ToolExecutionContext): RegisteredTool | undefined {
    const tool = builtin.get(id);
    if (tool) return tool;
    const entry = context.catalog.find((item) => item.id === id);
    if (!entry || !deps.backendTools) return undefined;
    return {
      id,
      description: entry.description,
      schema: z.object({}).catchall(z.unknown()),
      authorize: (_args, current) =>
        scoped(current) && current.catalog.some((item) => item.id === id && item.version === entry.version),
      execute: (args, current) =>
        deps.backendTools!.execute({ id, args }, current.principal, current.signal, undefined, {
          snapshotVersion: entry.version,
        }),
      evidence: (result) => ({
        name: id,
        result: { customToolId: id, configurationVersion: entry.version, data: result },
      }),
    };
  }

  async function execute(selection: PlannedToolSelection, context: ToolExecutionContext) {
    const tool = resolve(selection.id, context);
    if (!tool) return { status: 'unavailable' as const };
    const parsed = tool.schema.safeParse(context.restore(selection.args));
    if (!parsed.success) return { status: 'invalid' as const };
    if (!tool.authorize(parsed.data, context)) throw new Error('REGISTERED_TOOL_UNAUTHORIZED');
    const progressName = tool.progressName ?? tool.id;
    await context.progress?.('tool-start', { toolName: progressName });
    const result = await tool.execute(parsed.data, context);
    await context.progress?.('tool-finish', { toolName: progressName, status: 'completed' });
    return {
      status: 'executed' as const,
      result: tool.evidence(result, parsed.data, context),
      toolId: tool.id,
      answerStrategy: tool.answerStrategy,
    };
  }

  return { catalog, execute };
}
