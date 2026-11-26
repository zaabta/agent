import { stdin, stdout } from 'node:process';

const filename = 'concrete-structure1.pdf';
const question =
  'What footing types and dimensions are shown in concrete-structure1.pdf? Cite the evidence for each value.';
const base = new URL(process.env.SITEPILOT_DIAGNOSTIC_URL ?? 'http://127.0.0.1:3220');

class DiagnosticError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function')
    throw new DiagnosticError('SET_DIAGNOSTIC_CREDENTIALS_AT_RUNTIME');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new DiagnosticError('DIAGNOSTIC_CANCELLED'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function failOnUnsafeBaseUrl() {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
    throw new DiagnosticError('LOCAL_SITEPILOT_URL_REQUIRED');
}

async function api(path: string, token: string, body?: unknown): Promise<any> {
  const response = await fetch(new URL(path, base), {
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new DiagnosticError(`API_${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function login(): Promise<string> {
  const suppliedToken = process.env.SITEPILOT_DIAGNOSTIC_BEARER;
  if (suppliedToken) return suppliedToken;
  const email = process.env.SITEPILOT_DIAGNOSTIC_EMAIL ?? (await promptHidden('SitePilot account email: '));
  let password =
    process.env.SITEPILOT_DIAGNOSTIC_PASSWORD ??
    (await promptHidden('SitePilot account password (hidden): '));
  try {
    const response = await fetch(new URL('/api/auth/login', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new DiagnosticError(`LOGIN_${response.status}`);
    const result = (await response.json()) as { accessToken?: unknown };
    if (typeof result.accessToken !== 'string' || !result.accessToken)
      throw new DiagnosticError('LOGIN_TOKEN_MISSING');
    return result.accessToken;
  } finally {
    password = '';
  }
}

async function readSse(response: Response, record: (event: string, data: any) => void) {
  if (!response.body) throw new DiagnosticError('SSE_BODY_MISSING');
  const decoder = new TextDecoder();
  let pending = '';
  const reader = response.body.getReader();
  const consume = (frame: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length) {
      try {
        record(event, JSON.parse(data.join('\n')));
      } catch {
        throw new DiagnosticError('SSE_INVALID_JSON');
      }
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() ?? '';
    for (const frame of frames) if (frame.trim()) consume(frame);
    if (done) break;
  }
  if (pending.trim()) consume(pending);
}

function main() {
  return (async () => {
    failOnUnsafeBaseUrl();
    const token = await login();
    await api('/api/auth/me', token);

    const [documentPage, conversationPage] = await Promise.all([
      api(`/api/documents?search=${encodeURIComponent(filename)}&status=ready&limit=100`, token),
      api('/api/agent/conversations?limit=50', token),
    ]);
    const documents = (documentPage.documents ?? []).filter(
      (item: any) => String(item.filename).toLocaleLowerCase() === filename.toLocaleLowerCase(),
    );
    const requestedDocumentId = process.env.SITEPILOT_DIAGNOSTIC_DOCUMENT_ID;
    const document = requestedDocumentId
      ? documents.find((item: any) => item.id === requestedDocumentId)
      : documents.length === 1
        ? documents[0]
        : undefined;
    if (!document)
      throw new DiagnosticError(
        documents.length ? 'DOCUMENT_ID_REQUIRED_FOR_AMBIGUOUS_MATCH' : 'AUTHORIZED_DOCUMENT_NOT_FOUND',
      );

    const requestedConversationId = process.env.SITEPILOT_DIAGNOSTIC_CONVERSATION_ID;
    const conversations = conversationPage.conversations ?? [];
    const conversationId =
      requestedConversationId ??
      conversations.find((item: any) =>
        /concrete-structure1\.pdf|footing/i.test(String(item.lastMessage?.content ?? '')),
      )?.id;
    if (typeof conversationId !== 'string') throw new DiagnosticError('EXISTING_CONVERSATION_ID_REQUIRED');
    await api(`/api/agent/conversations/${encodeURIComponent(conversationId)}`, token);

    const startedAt = performance.now();
    let runId: string | undefined;
    let turnId: string | undefined;
    let responseConversationId: string | undefined;
    let requestId: string | undefined;
    let terminal: { event: string; code?: string } | undefined;
    let providerTelemetry: any;
    let planner: any;
    let retrieval: any;
    let answer: any;
    let answerInvocationAt: number | undefined;
    let answerFinishAt: number | undefined;
    let firstAnswerTextAt: number | undefined;
    const deltaTimes: number[] = [];
    let finalSourceCount: number | undefined;
    let answerValidation:
      | {
          citationValidation: string | null;
          citationCount: number;
          citationsAuthorized: boolean;
          answerNonEmpty: boolean;
        }
      | undefined;

    const response = await fetch(new URL('/api/agent/stream', base), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ message: question, conversationId }),
      signal: AbortSignal.timeout(660_000),
    });
    if (!response.ok) throw new DiagnosticError(`STREAM_${response.status}`);

    await readSse(response, (event, data) => {
      const now = performance.now();
      if (event === 'status') {
        runId = data.runId;
        turnId = data.turnId;
        responseConversationId = data.conversationId;
      } else if (event === 'diagnostic') {
        requestId = data.requestId ?? requestId;
        if (data.stage === 'planner-start') planner = { provider: data.provider, model: data.model };
        if (data.stage === 'planner-complete')
          planner = {
            ...planner,
            durationMs: data.durationMs,
            providerRetries: data.providerRetries,
            llmCalls: data.llmCalls,
          };
        if (data.stage === 'retrieval-complete')
          retrieval = { durationMs: data.durationMs, retrievedChunks: data.retrievedChunks };
        if (data.stage === 'answer-invocation') {
          answerInvocationAt = now;
          answer = {
            provider: data.provider,
            model: data.model,
            maxOutputTokens: data.maxOutputTokens,
            evidenceChunks: data.evidenceChunks,
            evidenceChars: data.evidenceChars,
            evidenceTokenEstimate: data.evidenceTokenEstimate,
          };
        }
        if (data.stage === 'answer-call-finish') {
          answerFinishAt = now;
          answer = {
            ...answer,
            finishReason: data.finishReason,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            generationDurationMs: data.durationMs,
          };
        }
      } else if (
        event === 'stage' &&
        data.stage === 'searching' &&
        data.status === 'completed' &&
        !retrieval
      ) {
        retrieval = { durationMs: data.durationMs ?? null, retrievedChunks: data.sourceCount ?? null };
      } else if (event === 'telemetry') {
        providerTelemetry = {
          providerErrors: data.providerErrors,
          providerRetries: data.providerRetries,
          llmCalls: data.llmCalls,
          llmLatencyMs: data.llmLatencyMs,
          code: data.code,
          timeoutSource: data.timeoutSource,
        };
        requestId = data.requestId ?? requestId;
      } else if (
        event === 'text-delta' &&
        data.verification === 'provisional' &&
        typeof data.text === 'string' &&
        data.text.length
      ) {
        if (firstAnswerTextAt === undefined) firstAnswerTextAt = now;
        deltaTimes.push(now);
      } else if (event === 'sources') {
        finalSourceCount = Array.isArray(data.sources) ? data.sources.length : undefined;
      } else if (event === 'done') {
        terminal = { event: 'done' };
        requestId = data.requestId ?? requestId;
        answer = { ...answer, finishReason: answer?.finishReason ?? 'stop' };
        const refs = [...String(data.answer ?? '').matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]);
        const authorizedRefs = new Set(
          (Array.isArray(data.sources) ? data.sources : [])
            .map((source: any) => source.sourceRef)
            .filter((ref: unknown): ref is string => typeof ref === 'string'),
        );
        answerValidation = {
          citationValidation: typeof data.citationValidation === 'string' ? data.citationValidation : null,
          citationCount: refs.length,
          citationsAuthorized: refs.length > 0 && refs.every((ref) => authorizedRefs.has(ref)),
          answerNonEmpty: typeof data.answer === 'string' && data.answer.trim().length > 0,
        };
        if (data.timing) {
          planner = {
            ...planner,
            durationMs: planner?.durationMs ?? data.timing.plannerMs,
            providerRetries: planner?.providerRetries ?? data.timing.providerRetries,
          };
          retrieval = { ...retrieval, durationMs: retrieval?.durationMs ?? data.timing.typegraphRetrievalMs };
        }
      } else if (event === 'error') {
        terminal = { event: 'error', code: data.code };
        requestId = data.requestId ?? requestId;
        providerTelemetry = data.telemetry ?? providerTelemetry;
      } else if (event === 'cancelled') terminal = { event: 'cancelled' };
    });

    if (!terminal) terminal = { event: 'stream-ended-without-terminal' };
    const totalMs = Math.round(performance.now() - startedAt);
    const gaps = deltaTimes.slice(1).map((time, index) => Math.round(time - deltaTimes[index]!));
    let usage: any[] = [];
    if (responseConversationId && requestId) {
      try {
        const logs = await api(
          `/api/llm/usage/logs?conversationId=${encodeURIComponent(responseConversationId)}&limit=100`,
          token,
        );
        usage = (logs.data ?? [])
          .filter((row: any) => row.logicalRequestId === requestId)
          .map((row: any) => ({
            role: row.role,
            provider: row.provider,
            model: row.modelId,
            status: row.status,
            latencyMs: row.latencyMs,
            errorCategory: row.errorCategory,
            finishReason: row.finishReason,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            maxOutputTokens: row.maxOutputTokens,
          }));
      } catch {
        usage = [];
      }
    }

    console.log(
      JSON.stringify({
        requestId: requestId ?? null,
        turnId: turnId ?? null,
        runId: runId ?? null,
        authorizedDocumentFound: true,
        existingConversationVerified: true,
        planner: planner ?? null,
        retrieval: retrieval ?? null,
        answer: answer ?? null,
        firstAnswerTokenMs:
          answerInvocationAt !== undefined && firstAnswerTextAt !== undefined
            ? Math.round(firstAnswerTextAt - answerInvocationAt)
            : null,
        answerDurationMs:
          answerInvocationAt !== undefined
            ? Math.round((answerFinishAt ?? performance.now()) - answerInvocationAt)
            : null,
        interTokenActivity: {
          deltaEvents: deltaTimes.length,
          maxGapMs: gaps.length ? Math.max(...gaps) : null,
          gapsMs: gaps.slice(0, 200),
          gapsTruncated: gaps.length > 200,
        },
        finalSourceCount,
        finalSse: terminal,
        providerTelemetry,
        usage,
        totalMs,
        answerValidation: answerValidation ?? null,
      }),
    );
    if (terminal.event !== 'done') process.exitCode = 1;
  })();
}

main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof DiagnosticError ? error.code : 'DIAGNOSTIC_FAILED' }),
  );
  process.exitCode = 1;
});
