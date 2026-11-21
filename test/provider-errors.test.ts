import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRequestFailure, classifyProviderError, modelWithExplicitFallback, ProviderRequestFailure, safeAgentClientResponse, safeAgentFailure, safeProviderClientResponse, safeProviderFailure, withProviderRetry } from '../src/agent/provider-errors.js';
import { createSitePilotStorageExporter } from '../src/mastra/observability.js';

test('provider errors map common upstream statuses to stable safe codes', () => {
  assert.deepEqual(classifyProviderError({ statusCode: 429, responseHeaders: { 'retry-after': '3' } }), {
    code: 'RATE_LIMITED', retryable: true, httpStatus: 429, retryAfterMs: 3000,
  });
  assert.equal(classifyProviderError({ statusCode: 401 })?.code, 'PROVIDER_AUTH_FAILED');
  assert.equal(classifyProviderError({ statusCode: 402 })?.code, 'PROVIDER_CREDITS_EXHAUSTED');
  assert.equal(classifyProviderError({ statusCode: 503 })?.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(classifyProviderError({ name: 'TimeoutError', message: 'private provider response' })?.code, 'TIMEOUT');
  assert.equal(classifyProviderError({ name: 'RetryError', errors: [{ statusCode: 429, responseHeaders: { 'retry-after': '2' } }] })?.retryAfterMs, 2000);
  assert.equal(classifyProviderError({ statusCode: 401 })?.retryable, false);
});

test('output truncation remains distinct from provider transport failure in client errors', () => {
  const error = new AgentRequestFailure('OUTPUT_TRUNCATED');
  assert.deepEqual(safeAgentFailure(error), { code: 'OUTPUT_TRUNCATED', retryable: false });
  assert.deepEqual(safeAgentClientResponse(error), {
    statusCode: 502,
    body: { code: 'OUTPUT_TRUNCATED', message: 'The model response reached its output limit before the answer was complete. Narrow the request and try again.', retryable: false },
  });
});

test('retry-after date and metadata are bounded and do not expose provider response text', () => {
  const failure = classifyProviderError({
    statusCode: 429,
    responseHeaders: { 'Retry-After': 'Sat, 07 Nov 2026 19:27:18 GMT' },
    responseBody: 'secret response must not escape',
  }, Date.parse('Sat, 07 Nov 2026 19:27:15 GMT'))!;
  assert.equal(failure.retryAfterMs, 3000);
  assert.equal(classifyProviderError({ statusCode: 429, responseHeaders: new Headers({ 'Retry-After': '4' }) })?.retryAfterMs, 4000);
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'httpStatus', 'retryAfterMs', 'retryable']);
  assert.deepEqual(safeProviderClientResponse({ statusCode: 429, responseHeaders: { 'retry-after': '3' }, responseBody: 'secret' }), {
    statusCode: 429,
    body: { code: 'RATE_LIMITED', message: 'The selected AI provider is temporarily rate limiting requests. Please retry shortly.', retryable: true, retryAfterMs: 3000 },
  });
  assert.equal(JSON.stringify(safeProviderClientResponse({ statusCode: 429, responseBody: 'secret prompt or response' })).includes('secret'), false);
});

test('transient retries are bounded, exponential, jittered, and end in a safe failure', async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(withProviderRetry(async () => {
    calls++;
    throw { statusCode: 503, responseBody: 'private' };
  }, { maxRetries: 2, random: () => 0.5, sleep: async ms => { waits.push(ms); } }), error => {
    assert.ok(error instanceof ProviderRequestFailure);
    assert.deepEqual(error.safe, { code: 'PROVIDER_UNAVAILABLE', retryable: true, httpStatus: 503 });
    assert.equal(error.message, 'PROVIDER_UNAVAILABLE');
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
});

test('non-retryable failures are never retried', async () => {
  let calls = 0;
  await assert.rejects(withProviderRetry(async () => { calls++; throw { statusCode: 402 }; }, {
    sleep: async () => assert.fail('must not wait'),
  }), error => error instanceof ProviderRequestFailure && error.safe.code === 'PROVIDER_CREDITS_EXHAUSTED');
  assert.equal(calls, 1);
});

test('Google daily quota exhaustion is not retried and safely parses RetryInfo', async () => {
  let calls = 0;
  const payload = JSON.stringify({ error: { code: 429, details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', metadata: { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' } },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '86400s' },
  ] } });
  const error = { statusCode: 429, responseBody: payload };
  assert.deepEqual(classifyProviderError(error), {
    code: 'QUOTA_EXCEEDED', retryable: false, httpStatus: 429, retryAfterMs: 86_400_000,
  });
  await assert.rejects(withProviderRetry(async () => { calls++; throw error; }, {
    sleep: async () => assert.fail('daily quota exhaustion must not wait and retry'),
  }), error => error instanceof ProviderRequestFailure && error.safe.code === 'QUOTA_EXCEEDED');
  assert.equal(calls, 1);
  assert.deepEqual(safeProviderClientResponse(error), {
    statusCode: 429,
    body: { code: 'QUOTA_EXCEEDED', message: 'The selected AI provider has exhausted its quota. Try again after it resets.', retryable: false, retryAfterMs: 86_400_000 },
  });
});

test('timeouts retry only to the configured bound and retain a safe timeout code', async () => {
  let calls = 0;
  await assert.rejects(withProviderRetry(async () => {
    calls++;
    throw Object.assign(new Error('private timeout detail'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
  }, { maxRetries: 1, random: () => 0, sleep: async () => {} }), error => {
    assert.ok(error instanceof ProviderRequestFailure);
    assert.equal(error.safe.code, 'TIMEOUT');
    assert.equal(error.message, 'TIMEOUT');
    return true;
  });
  assert.equal(calls, 2);
});

test('provider retry policy can suppress timeouts while retaining their safe error category', async () => {
  let calls = 0;
  let failures = 0;
  await assert.rejects(withProviderRetry(async () => {
    calls++;
    throw Object.assign(new Error('private timeout detail'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
  }, { shouldRetry: failure => failure.code !== 'TIMEOUT', onFailure: async failure => { assert.equal(failure.code, 'TIMEOUT'); failures++; }, sleep: async () => assert.fail('must not wait') }), error => error instanceof ProviderRequestFailure && error.safe.code === 'TIMEOUT');
  assert.equal(calls, 1);
  assert.equal(failures, 1);
});

test('Gemini quota, temporary rate limit, Ollama connection, missing model, and stalled inference are classified safely', async () => {
  const quota = { statusCode: 429, responseBody: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_requests_per_day' }] }] } }) };
  assert.equal(classifyProviderError(quota)?.code, 'QUOTA_EXCEEDED');
  assert.equal(classifyProviderError({ statusCode: 429, responseBody: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }) })?.code, 'QUOTA_EXCEEDED');
  assert.equal(classifyProviderError({ statusCode: 429, responseBody: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_requests_per_minute' }] }] } }) })?.code, 'RATE_LIMITED');
  assert.equal(classifyProviderError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) }))?.code, 'CONNECTION_FAILED');
  assert.equal(classifyProviderError({ statusCode: 404, message: 'model not found' })?.code, 'MODEL_UNAVAILABLE');
  let calls = 0;
  await assert.rejects(withProviderRetry(() => { calls++; return new Promise(() => undefined); }, { timeoutMs: 10, maxRetries: 0 }), error => error instanceof ProviderRequestFailure && error.safe.code === 'TIMEOUT');
  assert.equal(calls, 1);
});

test('provider backoff exits immediately when an active run is cancelled', async () => {
  const controller = new AbortController();
  let resolveSleepStarted!: () => void;
  const sleepStarted = new Promise<void>(resolve => { resolveSleepStarted = resolve; });
  const request = withProviderRetry(async () => { throw { statusCode: 503 }; }, {
    signal: controller.signal,
    sleep: async () => { resolveSleepStarted(); return new Promise<void>(() => undefined); },
  });
  await sleepStarted;
  controller.abort(new Error('AGENT_RUN_CANCELLED'));
  await assert.rejects(request, /AGENT_RUN_CANCELLED/);
});

test('provider timeout honors a measured stage budget above the former 60-second cap', async () => {
  const originalTimeout = AbortSignal.timeout;
  let configuredTimeout = 0;
  AbortSignal.timeout = ((milliseconds: number) => {
    configuredTimeout = milliseconds;
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  try {
    assert.equal(await withProviderRetry(async () => 'ok', { timeoutMs: 128_778, maxRetries: 0 }), 'ok');
    assert.equal(configuredTimeout, 128_778);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('stream timeout distinguishes first token, idle gaps, and healthy progress', async () => {
  await assert.rejects(withProviderRetry(() => new Promise(() => undefined), {
    timeoutMs: 100, firstTokenTimeoutMs: 10, idleTimeoutMs: 10, maxRetries: 0,
  }), error => error instanceof ProviderRequestFailure && error.safe.code === 'TIMEOUT');

  const started = Date.now();
  const value = await withProviderRetry(async (_signal, progress) => {
    await new Promise(resolve => setTimeout(resolve, 5)); progress?.();
    await new Promise(resolve => setTimeout(resolve, 8)); progress?.();
    await new Promise(resolve => setTimeout(resolve, 8)); progress?.();
    return 'complete';
  }, { timeoutMs: 100, firstTokenTimeoutMs: 10, idleTimeoutMs: 12, maxRetries: 0 });
  assert.equal(value, 'complete');
  assert.ok(Date.now() - started >= 20, 'generation may exceed the idle timeout while progress continues');

  await assert.rejects(withProviderRetry(async (_signal, progress) => {
    progress?.();
    await new Promise(() => undefined);
  }, { timeoutMs: 100, firstTokenTimeoutMs: 10, idleTimeoutMs: 10, maxRetries: 0 }), error => error instanceof ProviderRequestFailure && error.safe.code === 'TIMEOUT');
});

test('timeout diagnostics identify the timer that ended the provider call', async () => {
  const sources: string[] = [];
  const onFailure = async (_failure: any, source?: string) => { if (source) sources.push(source); };
  const stalled = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));

  await assert.rejects(withProviderRetry(stalled, { timeoutMs: 100, firstTokenTimeoutMs: 8, idleTimeoutMs: 8, maxRetries: 0, onFailure }));
  assert.equal(sources.at(-1), 'first-token');

  await assert.rejects(withProviderRetry((signal, progress) => new Promise<never>((_resolve, reject) => {
    progress?.();
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { timeoutMs: 100, firstTokenTimeoutMs: 8, idleTimeoutMs: 8, maxRetries: 0, onFailure }));
  assert.equal(sources.at(-1), 'idle');

  await assert.rejects(withProviderRetry((signal, progress) => new Promise<never>((_resolve, reject) => {
    const heartbeat = setInterval(() => progress?.(), 2);
    signal?.addEventListener('abort', () => { clearInterval(heartbeat); reject(signal.reason); }, { once: true });
  }), { timeoutMs: 20, firstTokenTimeoutMs: 8, idleTimeoutMs: 8, maxRetries: 0, onFailure }));
  assert.equal(sources.at(-1), 'stage-deadline');

  const request = new AbortController();
  setTimeout(() => request.abort(Object.assign(new Error('request deadline'), { name: 'TimeoutError', code: 'ETIMEDOUT' })), 8);
  await assert.rejects(withProviderRetry(stalled, { signal: request.signal, timeoutMs: 100, firstTokenTimeoutMs: 50, idleTimeoutMs: 50, maxRetries: 0, onFailure }));
  assert.equal(sources.at(-1), 'request-deadline');

  await assert.rejects(withProviderRetry(async () => { throw Object.assign(new Error('provider timeout'), { name: 'TimeoutError', code: 'ETIMEDOUT' }); }, { maxRetries: 0, onFailure }));
  assert.equal(sources.at(-1), 'provider');
});

test('stream request cancellation interrupts the generation without becoming a timeout', async () => {
  const controller = new AbortController();
  const request = withProviderRetry(async signal => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { signal: controller.signal, timeoutMs: 1000, firstTokenTimeoutMs: 500, idleTimeoutMs: 500 });
  controller.abort(new Error('CLIENT_DISCONNECTED'));
  await assert.rejects(request, /CLIENT_DISCONNECTED/);
});

test('stream hard deadline still bounds a continuously active generation', async () => {
  await assert.rejects(withProviderRetry((signal, progress) => new Promise((_resolve, reject) => {
    const heartbeat = setInterval(() => progress?.(), 2);
    signal?.addEventListener('abort', () => { clearInterval(heartbeat); reject(signal.reason); }, { once: true });
  }), { timeoutMs: 20, firstTokenTimeoutMs: 10, idleTimeoutMs: 10, maxRetries: 0 }), error => error instanceof ProviderRequestFailure && error.safe.code === 'TIMEOUT');
});

test('model fallback is opt-in and cannot cross provider or Local AI Only boundaries', () => {
  assert.equal(modelWithExplicitFallback('openrouter/google/a', undefined, 'openrouter'), 'openrouter/google/a');
  assert.deepEqual(modelWithExplicitFallback('openrouter/google/a', 'openrouter/google/b', 'openrouter'), [
    { model: 'openrouter/google/a', maxRetries: 0 }, { model: 'openrouter/google/b', maxRetries: 0 },
  ]);
  assert.equal(modelWithExplicitFallback('openrouter/google/a', 'anthropic/b', 'openrouter'), 'openrouter/google/a');
  assert.equal(modelWithExplicitFallback('qwen3:8b', 'cloud/model', 'ollama'), 'qwen3:8b');
});

test('observability exporter starts and degrades safely when storage initialization fails; log export is disabled only', async () => {
  const exporter = createSitePilotStorageExporter();
  await assert.doesNotReject(exporter.onLogEvent({} as any));
  assert.equal(typeof exporter._exportTracingEvent, 'function');
  const unavailableMastra = { getStorage: () => ({ getStore: async () => { throw new Error('storage unavailable'); } }) };
  await assert.doesNotReject(exporter.init({ mastra: unavailableMastra as any }));
  await exporter.shutdown();
});

test('serialized Mastra provider failures retain only allowlisted retry metadata', () => {
  const serialized = JSON.parse(JSON.stringify(new ProviderRequestFailure({ code: 'RATE_LIMITED', retryable: true, httpStatus: 429, retryAfterMs: 90000 })));
  assert.deepEqual(safeProviderFailure(serialized), { code: 'RATE_LIMITED', retryable: true, httpStatus: 429, retryAfterMs: 60000 });
  assert.equal(safeProviderFailure({ name: 'ProviderRequestFailure', safe: { code: 'INVENTED', message: 'secret' } }), undefined);
});
