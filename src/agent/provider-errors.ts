export type ProviderErrorCode =
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'CONNECTION_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_CREDITS_EXHAUSTED';

export type AgentErrorCategory = ProviderErrorCode | 'INVALID_MODEL_OUTPUT' | 'TOOL_EXECUTION_FAILED';

export interface SafeProviderFailure {
  code: ProviderErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  httpStatus: number;
}

export interface SafeProviderClientResponse {
  statusCode: number;
  body: { code: ProviderErrorCode; message: string; retryable: boolean; retryAfterMs?: number };
}

export class ProviderRequestFailure extends Error {
  readonly safe: SafeProviderFailure;
  constructor(safe: SafeProviderFailure) {
    super(safe.code);
    this.name = 'ProviderRequestFailure';
    this.safe = safe;
  }
}

export class AgentRequestFailure extends Error {
  constructor(readonly category: AgentErrorCategory, readonly context: { requestId?: string; retryable?: boolean; retryAfterMs?: number; telemetry?: Record<string, number> } = {}) {
    super(category);
    this.name = 'AgentRequestFailure';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function errorChain(value: unknown, depth = 0, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const current = record(value);
  if (!current || depth > 5 || output.includes(current)) return output;
  output.push(current);
  const errors = Array.isArray(current.errors) ? current.errors : [];
  for (const nested of [current.cause, current.lastError, record(current.data)?.error, ...errors.slice(-1)]) errorChain(nested, depth + 1, output);
  return output;
}

function responseHeader(error: Record<string, unknown>, name: string): string | undefined {
  const candidates = [error.responseHeaders, error.headers, record(error.response)?.headers];
  for (const candidate of candidates) {
    if (candidate && typeof (candidate as { get?: unknown }).get === 'function') {
      const found = (candidate as { get: (key: string) => unknown }).get(name);
      if (typeof found === 'string') return found;
    }
    const headers = record(candidate);
    if (!headers) continue;
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value && typeof (value as { get?: unknown }).get === 'function') {
      const found = (value as { get: (key: string) => unknown }).get(name);
      if (typeof found === 'string') return found;
    }
  }
  return undefined;
}

function retryAfterMs(error: Record<string, unknown>, now: number): number | undefined {
  const raw = responseHeader(error, 'retry-after');
  if (!raw || raw.length > 100) return undefined;
  const seconds = Number(raw);
  const parsed = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - now;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(Math.round(parsed), 86_400_000);
}

function providerPayload(error: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  for (const key of ['responseBody', 'body', 'data']) {
    const value = error[key];
    if (typeof value === 'string' && value.length <= 100_000) {
      try { values.push(JSON.parse(value)); } catch { /* provider payload is not JSON */ }
    } else if (value && typeof value === 'object') values.push(value);
  }
  return values;
}

function quotaDetails(chain: Record<string, unknown>[]): { exhausted: boolean; temporary: boolean; retryAfterMs?: number } {
  const queue = chain.flatMap(providerPayload);
  let exhausted = false;
  let temporary = false;
  let retryAfter: number | undefined;
  for (let index = 0; index < queue.length && index < 500; index++) {
    const item = record(queue[index]);
    if (!item) continue;
    let marker = '';
    try { marker = JSON.stringify(item).toLowerCase(); } catch { /* ignore cyclic SDK error internals */ }
    if (/requestsperday|per_day|daily.?quota|quota.?exceeded|quota.?exhausted/i.test(marker)) exhausted = true;
    if (/per_minute|perminute|per_second|persecond|requests.?per.?minute|rate_limit_exceeded/i.test(marker)) temporary = true;
    const details = Array.isArray(item.details) ? item.details : [];
    for (const detail of details) {
      const entry = record(detail);
      if (!entry) continue;
      const type = String(entry['@type'] ?? '');
      if (type.endsWith('RetryInfo') && typeof entry.retryDelay === 'string') {
        const match = /^(\d+(?:\.\d+)?)(s|ms)$/i.exec(entry.retryDelay);
        if (match) retryAfter = Math.max(retryAfter ?? 0, Math.min(86_400_000, Math.ceil(Number(match[1]) * (match[2]!.toLowerCase() === 's' ? 1000 : 1))));
      }
      queue.push(entry);
    }
    for (const [key, value] of Object.entries(item)) {
      if (/(retryinfo|retrydelay)/i.test(key) && typeof value === 'string') {
        const match = /^(\d+(?:\.\d+)?)(s|ms)$/i.exec(value);
        if (match) retryAfter = Math.max(retryAfter ?? 0, Math.min(86_400_000, Math.ceil(Number(match[1]) * (match[2]!.toLowerCase() === 's' ? 1000 : 1))));
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) queue.push(value);
    }
  }
  return { exhausted, temporary, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
}

/** Extracts only status and retry metadata. Never copies provider messages or bodies. */
export function classifyProviderError(value: unknown, now = Date.now()): SafeProviderFailure | undefined {
  const chain = errorChain(value);
  if (!chain.length) return undefined;
  const statusOwner = chain.find(item => Number.isFinite(Number(item.statusCode ?? item.status)));
  const status = Number(statusOwner?.statusCode ?? statusOwner?.status);
  const codes = chain.map(item => String(item.code ?? ''));
  const marker = chain.flatMap(providerPayload).map(item => { try { return JSON.stringify(item).toLowerCase(); } catch { return ''; } }).join(' ');
  const name = String(chain.map(item => item.name).find(item => typeof item === 'string' && /timeout|timed.?out/i.test(item)) ?? chain[0]?.name ?? '');
  const timeout = /timeout|timed.?out/i.test(name) || chain.some(item => /request_timeout|timeout|timed.?out/i.test(String(item.message ?? ''))) || codes.some(code => ['ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code));
  const connection = codes.some(code => ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'UND_ERR_SOCKET'].includes(code))
    || chain.some(item => item.name === 'TypeError' && /fetch failed/i.test(String(item.message ?? '')));
  const quota = quotaDetails(chain);
  const providerRetryAfter = chain.map(item => retryAfterMs(item, now)).find(item => item !== undefined);
  const resourceExhausted = /resource_exhausted/i.test(marker);
  const exhaustedQuota = quota.exhausted || (status === 429 && ((quota.retryAfterMs ?? providerRetryAfter ?? 0) >= 3_600_000 || resourceExhausted && !quota.temporary));
  let resultCode: ProviderErrorCode;
  let httpStatus: number;
  if (status === 401 || status === 403) { resultCode = 'PROVIDER_AUTH_FAILED'; httpStatus = 502; }
  else if (status === 402) { resultCode = 'PROVIDER_CREDITS_EXHAUSTED'; httpStatus = 503; }
  else if (status === 404 || /model_not_found|model .*not found|model.*does not exist/i.test(`${codes.join(' ')} ${marker}`)) { resultCode = 'MODEL_UNAVAILABLE'; httpStatus = 503; }
  else if (status === 429 && exhaustedQuota) { resultCode = 'QUOTA_EXCEEDED'; httpStatus = 429; }
  else if (status === 429) { resultCode = 'RATE_LIMITED'; httpStatus = 429; }
  else if (timeout || status === 408 || status === 504) { resultCode = 'TIMEOUT'; httpStatus = 504; }
  else if (connection) { resultCode = 'CONNECTION_FAILED'; httpStatus = 503; }
  else if (status >= 500 || status === 425 || status === 0 || !Number.isFinite(status) && chain.some(item => item.isRetryable === true)) { resultCode = 'PROVIDER_UNAVAILABLE'; httpStatus = 503; }
  else return undefined;
  const retryable = ['RATE_LIMITED', 'CONNECTION_FAILED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT'].includes(resultCode);
  const retryAfter = quota.retryAfterMs ?? providerRetryAfter;
  return { code: resultCode, retryable, httpStatus, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
}

export async function withProviderRetry<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: { maxRetries?: number; timeoutMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number; shouldRetry?: (failure: SafeProviderFailure) => boolean; onRetry?: (failure: SafeProviderFailure) => Promise<void>; onFailure?: (failure: SafeProviderFailure) => Promise<void> } = {},
): Promise<T> {
  const maxRetries = Math.max(0, Math.min(1, options.maxRetries ?? 1));
  const timeoutMs = Math.max(1, Math.min(60_000, options.timeoutMs ?? 60_000));
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('REQUEST_ABORTED');
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(options.signal?.aborted
          ? options.signal.reason ?? new Error('REQUEST_ABORTED')
          : Object.assign(new Error('Provider request timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' }));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([Promise.resolve().then(() => operation(signal)), aborted]);
    } catch (error) {
      if (options.signal?.aborted) {
        const reason = options.signal.reason ?? error;
        const abortedFailure = classifyProviderError(reason, options.now?.() ?? Date.now());
        if (abortedFailure?.code === 'TIMEOUT') {
          await options.onFailure?.(abortedFailure);
          throw new ProviderRequestFailure(abortedFailure);
        }
        throw reason;
      }
      const safe = classifyProviderError(error, options.now?.() ?? Date.now());
      if (!safe) throw error;
      await options.onFailure?.(safe);
      if (!safe.retryable || options.shouldRetry?.(safe) === false || attempt >= maxRetries || (safe.retryAfterMs ?? 0) > 2_000) throw new ProviderRequestFailure(safe);
      const exponential = Math.min(4_000, 250 * 2 ** attempt);
      const jittered = Math.round(exponential * (0.5 + Math.max(0, Math.min(1, random()))));
      const delay = safe.retryAfterMs === undefined ? jittered : Math.max(jittered, safe.retryAfterMs);
      await options.onRetry?.(safe);
      const boundedDelay = Math.min(delay, 2_000);
      if (!options.signal) await sleep(boundedDelay);
      else if (options.sleep) {
        if (options.signal.aborted) throw options.signal.reason ?? new Error('REQUEST_ABORTED');
        let onAbort: (() => void) | undefined;
        try {
          await Promise.race([
            sleep(boundedDelay),
            new Promise<never>((_, reject) => {
              onAbort = () => reject(options.signal!.reason ?? new Error('REQUEST_ABORTED'));
              options.signal!.addEventListener('abort', onAbort, { once: true });
            }),
          ]);
        } finally {
          if (onAbort) options.signal.removeEventListener('abort', onAbort);
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          if (options.signal!.aborted) { reject(options.signal!.reason ?? new Error('REQUEST_ABORTED')); return; }
          const timer = setTimeout(() => { options.signal!.removeEventListener('abort', onAbort); resolve(); }, boundedDelay);
          const onAbort = () => { clearTimeout(timer); options.signal!.removeEventListener('abort', onAbort); reject(options.signal!.reason ?? new Error('REQUEST_ABORTED')); };
          options.signal!.addEventListener('abort', onAbort, { once: true });
        });
      }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

export function safeProviderFailure(value: unknown): SafeProviderFailure | undefined {
  if (value instanceof ProviderRequestFailure) return value.safe;
  // Mastra workflow execution serializes errors, removing their prototype.
  // Restore only our allowlisted public metadata, never provider response text.
  for (const error of errorChain(value)) {
    const safe = record(error.safe);
    if (error.name !== 'ProviderRequestFailure' || !safe) continue;
    const statuses: Record<string, number> = { RATE_LIMITED: 429, QUOTA_EXCEEDED: 429, MODEL_UNAVAILABLE: 503, CONNECTION_FAILED: 503, TIMEOUT: 504, PROVIDER_UNAVAILABLE: 503, PROVIDER_AUTH_FAILED: 401, PROVIDER_CREDITS_EXHAUSTED: 402 };
    const status = statuses[String(safe.code)];
    if (!status) continue;
    const restored = classifyProviderError({ statusCode: status });
    if (!restored) continue;
    if (safe.code === 'QUOTA_EXCEEDED') return { ...restored, code: 'QUOTA_EXCEEDED', retryable: false, httpStatus: 429 };
    if (safe.code === 'MODEL_UNAVAILABLE') return { ...restored, code: 'MODEL_UNAVAILABLE', retryable: false, httpStatus: 503 };
    if (safe.code === 'CONNECTION_FAILED') return { ...restored, code: 'CONNECTION_FAILED', retryable: true, httpStatus: 503 };
    if (safe.code === 'TIMEOUT') return { ...restored, code: 'TIMEOUT', retryable: true, httpStatus: 504 };
    if (safe.code === 'PROVIDER_UNAVAILABLE') return { ...restored, code: 'PROVIDER_UNAVAILABLE', retryable: true, httpStatus: 503 };
    const retry = safe.retryAfterMs;
    return { ...restored, ...(typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? { retryAfterMs: Math.min(60000, Math.round(retry)) } : {}) };
  }
  return classifyProviderError(value);
}

export function safeAgentFailure(value: unknown): { code: AgentErrorCategory; retryable: boolean; retryAfterMs?: number; requestId?: string; telemetry?: Record<string, number> } | undefined {
  if (value instanceof AgentRequestFailure) return { code: value.category, retryable: value.context.retryable ?? false, ...(value.context.retryAfterMs !== undefined ? { retryAfterMs: value.context.retryAfterMs } : {}), ...(value.context.requestId ? { requestId: value.context.requestId } : {}), ...(value.context.telemetry ? { telemetry: value.context.telemetry } : {}) };
  for (const error of errorChain(value)) {
    if (error.name === 'AgentRequestFailure' && Object.hasOwn({ INVALID_MODEL_OUTPUT: true, TOOL_EXECUTION_FAILED: true, QUOTA_EXCEEDED: true, RATE_LIMITED: true, TIMEOUT: true, CONNECTION_FAILED: true, MODEL_UNAVAILABLE: true, PROVIDER_UNAVAILABLE: true, PROVIDER_AUTH_FAILED: true, PROVIDER_CREDITS_EXHAUSTED: true }, String(error.category))) {
      const context = record(error.context);
      return { code: error.category as AgentErrorCategory, retryable: context?.retryable === true, ...(typeof context?.retryAfterMs === 'number' ? { retryAfterMs: context.retryAfterMs } : {}), ...(typeof context?.requestId === 'string' ? { requestId: context.requestId } : {}), ...(record(context?.telemetry) ? { telemetry: record(context?.telemetry) as Record<string, number> } : {}) };
    }
    if (['ACTIVE_MODEL_UNAVAILABLE', 'FALLBACK_MODEL_UNAVAILABLE'].includes(String(error.message))) return { code: 'MODEL_UNAVAILABLE', retryable: false };
    if (String(error.message) === 'REQUEST_TIMEOUT') return { code: 'TIMEOUT', retryable: false };
    if (String(error.message) === 'MODEL_STREAM_FAILED') return { code: 'CONNECTION_FAILED', retryable: true };
  }
  const provider = safeProviderFailure(value);
  return provider ? { code: provider.code, retryable: provider.retryable, ...(provider.retryAfterMs !== undefined ? { retryAfterMs: provider.retryAfterMs } : {}) } : undefined;
}

export function safeAgentErrorMessage(code: AgentErrorCategory): string {
  const messages: Record<AgentErrorCategory, string> = {
    QUOTA_EXCEEDED: 'The selected AI provider has exhausted its quota. Try again after it resets.',
    RATE_LIMITED: 'The selected AI provider is temporarily rate limiting requests. Please retry shortly.',
    TIMEOUT: 'The selected model did not respond before the request timeout.',
    CONNECTION_FAILED: 'Could not connect to the selected AI provider. Check that it is reachable and try again.',
    MODEL_UNAVAILABLE: 'The selected model is unavailable. Check the selected model and provider.',
    INVALID_MODEL_OUTPUT: 'The model returned output that did not match the required format. Please retry.',
    TOOL_EXECUTION_FAILED: 'The selected capability could not be completed.',
    PROVIDER_UNAVAILABLE: 'The selected AI provider is temporarily unavailable. Please retry shortly.',
    PROVIDER_AUTH_FAILED: 'The selected AI provider rejected its configured credentials.',
    PROVIDER_CREDITS_EXHAUSTED: 'The selected AI provider has no available credits.',
  };
  return messages[code];
}

export function safeProviderClientResponse(value: unknown): SafeProviderClientResponse | undefined {
  const failure = safeProviderFailure(value);
  if (!failure) return undefined;
  return {
    statusCode: failure.httpStatus,
    body: { code: failure.code, message: safeAgentErrorMessage(failure.code), retryable: failure.retryable, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) },
  };
}

export function safeAgentClientResponse(value: unknown) {
  const failure = safeAgentFailure(value);
  if (!failure) return undefined;
  const provider = safeProviderClientResponse(value);
  const statusCode = provider?.statusCode ?? (failure.code === 'TIMEOUT' ? 504 : failure.code === 'RATE_LIMITED' || failure.code === 'QUOTA_EXCEEDED' ? 429 : 502);
  return {
    statusCode,
    body: {
      code: failure.code,
      message: safeAgentErrorMessage(failure.code),
      retryable: failure.retryable,
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      ...('requestId' in failure && failure.requestId ? { requestId: failure.requestId } : {}),
    },
  };
}

export function modelWithExplicitFallback<T>(primary: T, fallback: T | undefined, provider: string): T | Array<{ model: T; maxRetries: number }> {
  if (!fallback) return primary;
  // Fallbacks must remain within the already selected provider. Ollama-only
  // deployments cannot be redirected to a cloud provider through this setting.
  if (provider === 'ollama') {
    if (typeof primary === 'string' || typeof fallback === 'string') return primary;
    return [{ model: primary, maxRetries: 0 }, { model: fallback, maxRetries: 0 }];
  }
  if (typeof primary === 'string' && typeof fallback === 'string'
    && primary.startsWith(`${provider}/`) && fallback.startsWith(`${provider}/`)) {
    return [{ model: primary as T, maxRetries: 0 }, { model: fallback as T, maxRetries: 0 }];
  }
  return primary;
}
