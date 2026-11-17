import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProviderError, modelWithExplicitFallback, ProviderRequestFailure, safeProviderClientResponse, safeProviderFailure, withProviderRetry } from '../src/agent/provider-errors.js';
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
