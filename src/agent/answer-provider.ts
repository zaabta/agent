import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { RuntimeModelSnapshot } from '../llm-admin/runtime-model.js';
import type { AgentEvidencePackage } from './evidence.js';
import type { AgentPlan } from './planner-node.js';
import { createLangGraphModel } from './model-factory.js';
import { normalizeUsage } from './graph-usage.js';
import { buildAnswerPrompt, renderDeterministicAnswer } from './answer-strategies.js';
import { structuredOutputMethod } from '../llm-admin/model-capabilities.js';
import type { AnswerModel, GraphProgress, GraphUsage } from './graph-model-types.js';
import type { ToolCatalogEntry } from './tool-registry.js';

export type AnswerProviderState = {
  route: 'conversation' | 'workspace';
  plan?: AgentPlan;
  evidenceReadiness: 'authorized' | 'no-evidence' | 'invalid';
  evidence?: AgentEvidencePackage;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  memories: Array<{ category: string; content: string }>;
  catalog: ToolCatalogEntry[];
  answerStrategy?: string;
  signal: AbortSignal;
  requestId: string;
  runtime: { answer: RuntimeModelSnapshot };
  llmCalls: number;
  progress?: GraphProgress;
};

export function createAnswerProvider(deps: {
  privacy: { mask: (value: string) => string };
  model?: AnswerModel;
  onUsage?: (record: GraphUsage) => Promise<void> | void;
}) {
  return async (state: AnswerProviderState) => {
    await state.progress?.('stage', {
      stage: 'answer_provider',
      status: 'in_progress',
      message: 'Generating structured answer',
    });
    const plan = state.plan ?? { operation: 'respond' as const };
    if (plan.operation === 'clarify') {
      await state.progress?.('stage', {
        stage: 'answer_provider',
        status: 'completed',
        message: 'Clarification response ready',
      });
      return {
        claims: [{ text: plan.reply ?? 'Please clarify what you would like me to do.', evidenceIds: [] }],
        missingInformation: [],
        outcome: 'clarification' as const,
      };
    }
    if (state.route === 'workspace' && state.evidenceReadiness === 'no-evidence') {
      await state.progress?.('stage', {
        stage: 'answer_provider',
        status: 'completed',
        message: 'No evidence available',
      });
      return {
        claims: [
          {
            text: 'The authorized documents do not contain evidence to answer this question.',
            evidenceIds: [],
          },
        ],
        missingInformation: [],
        outcome: 'empty' as const,
      };
    }
    const items = (state.evidence?.items ?? []).filter((item) => item.type !== 'conversation-context');
    const deterministic = renderDeterministicAnswer(state.answerStrategy, items);
    if (deterministic) {
      await state.progress?.('stage', {
        stage: 'answer_provider',
        status: 'completed',
        message: 'Structured answer ready',
      });
      return deterministic;
    }
    const evidenceIds = items.map((item) => item.id);
    const claimSchema = z.object({
      claims: z
        .array(
          z.object({
            text: z.string().min(1).max(4000),
            evidenceIds: z
              .array(evidenceIds.length ? z.enum(evidenceIds as [string, ...string[]]) : z.string().max(0))
              .min(state.route === 'workspace' ? 1 : 0)
              .max(8),
          }),
        )
        .max(32),
      missingInformation: z.array(z.string().max(500)).max(8),
    });
    const promptStrategy = buildAnswerPrompt(state.route, {
      message: state.message,
      history: state.history,
      memories: state.memories,
      catalog: state.catalog,
      items,
      privacy: deps.privacy,
    });
    const method = structuredOutputMethod(state.runtime.answer);
    const model = (deps.model ?? createLangGraphModel(state.runtime.answer)).withStructuredOutput(
      claimSchema,
      { ...(method ? { method } : {}), strict: false, includeRaw: true },
    );
    const startedAt = performance.now();
    try {
      const result: any = await model.invoke(
        [new SystemMessage(promptStrategy.system), new HumanMessage(promptStrategy.prompt)],
        { signal: state.signal },
      );
      if (!result?.parsed || !claimSchema.safeParse(result.parsed).success)
        throw new Error('ANSWER_GENERATION_INVALID');
      await deps.onUsage?.({
        requestId: state.requestId,
        role: 'ANSWER',
        usage: normalizeUsage(result.raw?.usage_metadata),
        latencyMs: performance.now() - startedAt,
        status: 'success',
      });
      await state.progress?.('stage', {
        stage: 'answer_provider',
        status: 'completed',
        message: 'Structured answer ready',
      });
      return {
        claims: result.parsed.claims,
        missingInformation: result.parsed.missingInformation,
        llmCalls: state.llmCalls + 1,
        outcome: 'success' as const,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AnswerProvider] FAILED', {
        name: err.name,
        code: (error as any)?.code,
        message: err.message,
        provider: state.runtime.answer.provider,
        model: state.runtime.answer.model,
        requestId: state.requestId,
      });
      await deps.onUsage?.({
        requestId: state.requestId,
        role: 'ANSWER',
        latencyMs: performance.now() - startedAt,
        status: 'failed',
        error,
      });
      throw error;
    }
  };
}
