import type { z } from 'zod';

export type GraphTurn = { role: 'user' | 'assistant'; content: string };
export type GraphSource = {
  documentId: string;
  documentVersionId?: string;
  chunkId?: string;
  pageNumber?: number;
  contentHash?: string;
  paragraphStart?: number;
  paragraphEnd?: number;
  filename: string;
  sourceRef: string;
  chunkIndex: number;
};
export type GraphProgress = (event: string, data: Record<string, unknown>) => Promise<void> | void;
export type GraphUsage = {
  requestId: string;
  role: 'ROUTER' | 'PLANNER' | 'ANSWER';
  usage?: Record<string, unknown>;
  latencyMs: number;
  status: 'success' | 'failed';
  error?: unknown;
  finishReason?: string;
};
export interface StructuredOutputModel {
  withStructuredOutput(
    schema: z.ZodTypeAny,
    options?: {
      strict?: boolean;
      includeRaw?: boolean;
      method?: 'jsonSchema' | 'functionCalling' | 'jsonMode';
    },
  ): {
    invoke(messages: unknown[], options?: { signal?: AbortSignal }): Promise<unknown>;
  };
}
export type RouterModel = StructuredOutputModel;
export type PlannerModel = StructuredOutputModel;
export type AnswerModel = StructuredOutputModel;
