export type ProviderErrorCode =
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_DAILY_QUOTA_EXHAUSTED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_CREDITS_EXHAUSTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT';

export interface SafeProviderFailure {
  code: ProviderErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  httpStatus: number;
}

export interface SafeProviderClientResponse {
  statusCode: number;
  body: { code: ProviderErrorCode; retryable: boolean; retryAfterMs?: number };
}

export class ProviderRequestFailure extends Error {
  readonly safe: SafeProviderFailure;
  constructor(safe: SafeProviderFailure) {
    super(safe.code);
    this.name = 'ProviderRequestFailure';
    this.safe = safe;
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

function quotaDetails(chain: Record<string, unknown>[]): { dailyQuota: boolean; retryAfterMs?: number } {
  const queue = chain.flatMap(providerPayload);
  let dailyQuota = false;
  let retryAfter: number | undefined;
  for (let index = 0; index < queue.length && index < 500; index++) {
    const item = record(queue[index]);
    if (!item) continue;
    let marker = '';
    try { marker = JSON.stringify(item).toLowerCase(); } catch { /* ignore cyclic SDK error internals */ }
    if (/requestsperday|per_day|daily.?quota|quota.?exceeded/i.test(marker)) dailyQuota = true;
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
  return { dailyQuota, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
}

/** Extracts only status and retry metadata. Never copies provider messages or bodies. */
export function classifyProviderError(value: unknown, now = Date.now()): SafeProviderFailure | undefined {
  const chain = errorChain(value);
  if (!chain.length) return undefined;
  const statusOwner = chain.find(item => Number.isFinite(Number(item.statusCode ?? item.status)));
  const status = Number(statusOwner?.statusCode ?? statusOwner?.status);
  const code = String(chain.map(item => item.code).find(item => typeof item === 'string') ?? '');
  const name = String(chain.map(item => item.name).find(item => typeof item === 'string' && /timeout|timed.?out/i.test(item)) ?? chain[0]?.name ?? '');
  const timeout = /timeout|timed.?out/i.test(name) || ['ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
  const quota = quotaDetails(chain);
  const providerRetryAfter = chain.map(item => retryAfterMs(item, now)).find(item => item !== undefined);
  const exhaustedQuota = quota.dailyQuota || (status === 429 && ((quota.retryAfterMs ?? providerRetryAfter ?? 0) >= 3_600_000));
  let resultCode: ProviderErrorCode;
  let httpStatus: number;
  if (status === 401 || status === 403) { resultCode = 'PROVIDER_AUTH_FAILED'; httpStatus = 502; }
  else if (status === 402) { resultCode = 'PROVIDER_CREDITS_EXHAUSTED'; httpStatus = 503; }
  else if (status === 429 && exhaustedQuota) { resultCode = 'PROVIDER_DAILY_QUOTA_EXHAUSTED'; httpStatus = 429; }
  else if (status === 429) { resultCode = 'PROVIDER_RATE_LIMITED'; httpStatus = 503; }
  else if (timeout || status === 408 || status === 504) { resultCode = 'PROVIDER_TIMEOUT'; httpStatus = 504; }
  else if (status >= 500 || status === 425 || status === 0 || !Number.isFinite(status) && chain.some(item => item.isRetryable === true)) { resultCode = 'PROVIDER_UNAVAILABLE'; httpStatus = 503; }
  else return undefined;
  const retryable = resultCode === 'PROVIDER_RATE_LIMITED' || resultCode === 'PROVIDER_UNAVAILABLE' || resultCode === 'PROVIDER_TIMEOUT';
  const retryAfter = quota.retryAfterMs ?? providerRetryAfter;
  return { code: resultCode, retryable, httpStatus, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
}

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number; onRetry?: (failure: SafeProviderFailure) => Promise<void> } = {},
): Promise<T> {
  const maxRetries = Math.max(0, Math.min(2, options.maxRetries ?? 2));
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('REQUEST_ABORTED');
    try {
      return await operation();
    } catch (error) {
      const safe = classifyProviderError(error, options.now?.() ?? Date.now());
      if (!safe) throw error;
      if (!safe.retryable || attempt >= maxRetries || options.signal?.aborted) throw new ProviderRequestFailure(safe);
      const exponential = Math.min(4_000, 250 * 2 ** attempt);
      const jittered = Math.round(exponential * (0.5 + Math.max(0, Math.min(1, random()))));
      const delay = safe.retryAfterMs === undefined ? jittered : Math.max(jittered, safe.retryAfterMs);
      await options.onRetry?.(safe);
      const boundedDelay = Math.min(delay, 60_000);
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
    const statuses: Record<string, number> = { PROVIDER_RATE_LIMITED: 429, PROVIDER_DAILY_QUOTA_EXHAUSTED: 429, PROVIDER_AUTH_FAILED: 401, PROVIDER_CREDITS_EXHAUSTED: 402, PROVIDER_UNAVAILABLE: 503, PROVIDER_TIMEOUT: 504 };
    const status = statuses[String(safe.code)];
    if (!status) continue;
    const restored = classifyProviderError({ statusCode: status });
    if (!restored) continue;
    if (safe.code === 'PROVIDER_DAILY_QUOTA_EXHAUSTED') return { ...restored, code: 'PROVIDER_DAILY_QUOTA_EXHAUSTED', retryable: false, httpStatus: 429 };
    const retry = safe.retryAfterMs;
    return { ...restored, ...(typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? { retryAfterMs: Math.min(60000, Math.round(retry)) } : {}) };
  }
  return classifyProviderError(value);
}

export function safeProviderClientResponse(value: unknown): SafeProviderClientResponse | undefined {
  const failure = safeProviderFailure(value);
  if (!failure) return undefined;
  return {
    statusCode: failure.httpStatus,
    body: { code: failure.code, retryable: failure.retryable, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) },
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
