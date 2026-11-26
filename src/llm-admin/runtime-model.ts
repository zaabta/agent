import type { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';
import { effectiveCredential, type CloudProvider } from '../llm-admin/provider-credentials.js';

export type LlmRole = 'ROUTER' | 'PLANNER' | 'ANSWER';
export interface RuntimeModelSnapshot {
  provider: string;
  model: string;
  ollamaThink: boolean;
  apiKey?: string;
  requestTimeoutMs?: number;
  maxOutputTokens?: number;
  maxContextChars?: number;
  maxStreamDurationMs?: number;
  temperature?: number;
  capabilities?: Record<string, unknown>;
  role?: LlmRole;
}
export interface RuntimeModelRolesSnapshot {
  router: RuntimeModelSnapshot;
  planner: RuntimeModelSnapshot;
  answer: RuntimeModelSnapshot;
}
export type RuntimeModelInput = RuntimeModelSnapshot | RuntimeModelRolesSnapshot;

function configuredOutputTokens(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('INVALID_RUNTIME_OUTPUT_TOKEN_LIMIT');
  return parsed;
}

/** Read authoritative settings for every logical request; never cache across requests/instances. */
export async function resolveRuntimeModel(prisma: PrismaService): Promise<RuntimeModelSnapshot> {
  return (await resolveRuntimeModels(prisma)).planner;
}

export async function resolveRuntimeModels(prisma: PrismaService): Promise<RuntimeModelRolesSnapshot> {
  const fallback = {
    provider: config.modelProvider,
    model: config.model,
    ollamaThink: config.ollamaThink,
    requestTimeoutMs: config.agentTimeoutMs,
    maxContextChars: config.answerMaxContextChars,
    maxStreamDurationMs: config.answerStreamMaxDurationMs,
  };
  if (!(prisma as any).runtimeSetting || !(prisma as any).registeredModel)
    return {
      router: { ...fallback, role: 'ROUTER' },
      planner: { ...fallback, role: 'PLANNER' },
      answer: { ...fallback, role: 'ANSWER' },
    };
  const rows = await prisma.runtimeSetting.findMany({
    where: {
      key: {
        in: [
          'AGENT_PROVIDER',
          'AGENT_MODEL',
          'OLLAMA_THINK',
          'AGENT_REQUEST_TIMEOUT_MS',
          'ROUTER_PROVIDER',
          'ROUTER_MODEL',
          'PLANNER_PROVIDER',
          'PLANNER_MODEL',
          'ANSWER_PROVIDER',
          'ANSWER_MODEL',
          'PLANNER_MAX_OUTPUT_TOKENS',
          'ANSWER_MAX_OUTPUT_TOKENS',
          'ANSWER_MAX_CONTEXT_CHARS',
          'ANSWER_STREAM_MAX_DURATION_MS',
        ],
      },
    },
  });
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const sharedProvider = v.AGENT_PROVIDER ?? config.modelProvider,
    sharedModel = v.AGENT_MODEL ?? config.model;
  const make = async (role: LlmRole): Promise<RuntimeModelSnapshot> => {
    const configured = v[`${role}_PROVIDER`] !== undefined && v[`${role}_MODEL`] !== undefined;
    const provider = configured ? v[`${role}_PROVIDER`] : sharedProvider,
      model = configured ? v[`${role}_MODEL`] : sharedModel;
    const registered = await prisma.registeredModel.findUnique({
      where: { provider_modelId: { provider, modelId: model } },
    });
    if (
      rows.length &&
      (!registered || !registered.enabled || !registered.available || !registered.compatible)
    )
      throw new Error('ACTIVE_MODEL_UNAVAILABLE');
    const maxOutputTokens = configuredOutputTokens(v[`${role}_MAX_OUTPUT_TOKENS`]);
    const providerMaxOutputTokens = Number((registered?.capabilities as any)?.maxOutputTokens);
    if (
      maxOutputTokens !== undefined &&
      Number.isSafeInteger(providerMaxOutputTokens) &&
      providerMaxOutputTokens > 0 &&
      maxOutputTokens > providerMaxOutputTokens
    )
      throw new Error('OUTPUT_TOKEN_LIMIT_EXCEEDS_MODEL_MAXIMUM');
    const apiKey = ['google', 'openrouter', 'openai'].includes(provider)
      ? (await effectiveCredential(prisma, provider as CloudProvider)).key
      : undefined;
    return {
      provider,
      model,
      ollamaThink: (v.OLLAMA_THINK ?? String(config.ollamaThink)) === 'true',
      apiKey,
      requestTimeoutMs: Number(v.AGENT_REQUEST_TIMEOUT_MS ?? config.agentTimeoutMs),
      maxOutputTokens,
      capabilities: registered?.capabilities as Record<string, unknown> | undefined,
      ...(role === 'ANSWER'
        ? {
            maxContextChars: Number(v.ANSWER_MAX_CONTEXT_CHARS ?? config.answerMaxContextChars),
            maxStreamDurationMs: Number(v.ANSWER_STREAM_MAX_DURATION_MS ?? config.answerStreamMaxDurationMs),
          }
        : {}),
      role,
    };
  };
  const [router, planner, answer] = await Promise.all([make('ROUTER'), make('PLANNER'), make('ANSWER')]);
  return { router, planner, answer };
}

export function modelForRole(runtime: RuntimeModelInput | undefined, role: LlmRole): RuntimeModelSnapshot {
  if (runtime && 'planner' in runtime)
    return role === 'ROUTER'
      ? (runtime.router ?? runtime.planner)
      : role === 'PLANNER'
        ? runtime.planner
        : runtime.answer;
  return {
    ...(runtime ?? {
      provider: config.modelProvider,
      model: config.model,
      ollamaThink: config.ollamaThink,
      maxContextChars: config.answerMaxContextChars,
      maxStreamDurationMs: config.answerStreamMaxDurationMs,
    }),
    role,
  };
}

export function modelRequestTimeoutMs(runtime: RuntimeModelSnapshot): number {
  const configured = Number.isFinite(runtime.requestTimeoutMs)
    ? runtime.requestTimeoutMs!
    : config.agentTimeoutMs;
  return Math.max(1_000, configured);
}
