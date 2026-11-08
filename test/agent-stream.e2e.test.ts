import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const baseUrl = process.env.AGENT_E2E_URL;
// Supply a bearer token from an already authenticated development login/session.
// This E2E intentionally does not use DEV_API_KEY or mint a token.
const bearerToken = process.env.AGENT_E2E_BEARER;
const headers = { 'content-type': 'application/json', ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}) };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SseEvent = { name: string; data: Record<string, any> };
type SseReaderState = { pending: string; buffered: SseEvent[] };

async function nextSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, state: SseReaderState, timeoutMs = 120_000): Promise<SseEvent> {
  while (!state.buffered.length) {
    const next = await withTimeout(reader.read(), timeoutMs, 'Timed out waiting for workflow SSE event');
    if (next.done) throw new Error('SSE stream ended before the expected workflow event');
    state.pending += decoder.decode(next.value, { stream: true });
    const frames = state.pending.split('\n\n');
    state.pending = frames.pop() ?? '';
    for (const frame of frames) {
      const lines = frame.split('\n').map(line => line.replace(/\r$/, ''));
      const name = lines.find(line => line.startsWith('event: '))?.slice(7);
      const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (name && data) state.buffered.push({ name, data: JSON.parse(data) });
    }
  }
  return state.buffered.shift()!;
}

async function cancelAtWorkflowPoint(target: 'planning' | 'searching' | 'model') {
  const conversationResponse = await fetch(`${baseUrl}/api/agent/conversations`, { method: 'POST', headers, body: '{}' });
  assert.equal(conversationResponse.status, 201);
  const conversation = await conversationResponse.json() as { id: string };
  const response = await fetch(`${baseUrl}/api/agent/stream`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: 'What is the SitePilot Enterprise monthly subscription price?', conversationId: conversation.id }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: SseReaderState = { pending: '', buffered: [] };
  let runId: string | undefined;
  let reachedTarget = false;
  while (!reachedTarget) {
    const event = await nextSseEvent(reader, decoder, state);
    if (event.name === 'status') runId = event.data.runId;
    reachedTarget = target === 'model'
      ? event.name === 'text-delta' && event.data.verification === 'provisional'
      : event.name === 'stage' && event.data.stage === target && event.data.status === 'in_progress';
  }
  assert.match(runId ?? '', /^[0-9a-f-]{36}$/i);
  const responseCancel = await fetch(`${baseUrl}/api/agent/runs/${runId}/cancel`, { method: 'POST', headers });
  assert.equal(responseCancel.status, 200);
  const acknowledgement = await responseCancel.json() as { status: string; cancellationRequested: boolean; executionSettled: boolean; providerStopConfirmed: boolean };
  assert.equal(acknowledgement.cancellationRequested, true);
  assert.equal(acknowledgement.providerStopConfirmed, false);
  assert.ok(['cancelling', 'cancelled'].includes(acknowledgement.status));

  let cancelled: SseEvent | undefined;
  while (!cancelled) {
    const event = await nextSseEvent(reader, decoder, state, 30_000);
    if (event.name === 'cancelled') cancelled = event;
    else if (event.name === 'done' || event.name === 'error') throw new Error(`Unexpected terminal SSE event: ${event.name}`);
  }
  assert.equal(cancelled.data.executionSettled, true);
  assert.equal(cancelled.data.providerStopConfirmed, false);
  await reader.cancel().catch(() => undefined);
  const historyResponse = await fetch(`${baseUrl}/api/agent/conversations/${conversation.id}`, { headers });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as { messages: Array<{ role: string; content: string; status: string }> };
  assert.equal(history.messages.at(-1)?.status, 'interrupted');
  assert.equal(history.messages.at(-1)?.content, '');
  await fetch(`${baseUrl}/api/agent/conversations/${conversation.id}`, { method: 'DELETE', headers });
}

test('Mastra streams a grounded TypeGraph answer progressively and persists the turn', {
  skip: !baseUrl || !bearerToken ? 'Set AGENT_E2E_URL and AGENT_E2E_BEARER from an existing valid development session' : false,
}, async () => {
  const conversationResponse = await fetch(`${baseUrl}/api/agent/conversations`, {
    method: 'POST', headers, body: '{}',
  });
  assert.equal(conversationResponse.status, 201);
  const conversation = await conversationResponse.json() as { id: string };

  const response = await fetch(`${baseUrl}/api/agent/stream`, {
    method: 'POST', headers,
    body: JSON.stringify({
      message: 'What is the SitePilot Enterprise monthly subscription price?',
      conversationId: conversation.id,
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let currentEvent = '';
  const events: Array<{ name: string; data: Record<string, any>; receivedAt: number }> = [];
  const startedAt = performance.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      if (line.startsWith('event: ')) currentEvent = line.slice(7);
      if (line.startsWith('data: ')) {
        events.push({ name: currentEvent, data: JSON.parse(line.slice(6)), receivedAt: performance.now() - startedAt });
      }
    }
  }

  const names = events.map(event => event.name);
  assert.doesNotMatch(names.join(','), /reasoning|raw|prompt|provider/i);
  assert.ok(names.includes('tool-start'));
  assert.ok(names.includes('tool-finish'));
  const runId = events.find(event => event.name === 'status')?.data.runId;
  assert.match(runId ?? '', /^[0-9a-f-]{36}$/i);
  const deltas = events.filter(event => event.name === 'text-delta');
  const provisionalDeltas = deltas.filter(event => event.data.verification === 'provisional');
  const verificationReset = events.find(item => item.name === 'text-reset' && item.data.reason === 'citation-verification');
  assert.ok(provisionalDeltas.length > 1, `Expected incremental model chunks; got ${provisionalDeltas.length}`);
  assert.ok(verificationReset, 'expected provisional text to be cleared before verified answer');
  assert.ok(provisionalDeltas.every(event => event.receivedAt < verificationReset.receivedAt));
  const done = events.find(event => event.name === 'done')?.data;
  assert.ok(done);
  assert.ok(deltas.at(-1)!.receivedAt < events.find(event => event.name === 'done')!.receivedAt);
  assert.equal(deltas.at(-1)!.data.verification, 'verified');
  assert.equal(deltas.at(-1)!.data.text, done.answer);
  const firstStatus = events.find(event => event.name === 'stage' || event.name === 'status');
  assert.ok(firstStatus, 'expected a meaningful workflow status');
  assert.equal(done.citationValidation, 'valid');
  assert.match(done.answer, /249/);
  assert.ok(done.answer.includes('[[sitepilot-e2e-pricing.md (chunk 1)]]'));
  assert.ok(done.sources.some((source: { sourceRef: string }) => source.sourceRef === 'sitepilot-e2e-pricing.md (chunk 1)'));

  const lateCancellation = await fetch(`${baseUrl}/api/agent/runs/${runId}/cancel`, { method: 'POST', headers });
  assert.equal(lateCancellation.status, 200);
  assert.equal((await lateCancellation.json() as { status: string }).status, 'completed');

  const storedResponse = await fetch(`${baseUrl}/api/agent/conversations/${conversation.id}`, {
    headers,
  });
  assert.equal(storedResponse.status, 200);
  const stored = await storedResponse.json() as { messages: Array<{ role: string }> };
  assert.deepEqual(stored.messages.map(message => message.role), ['user', 'assistant']);
  console.log(JSON.stringify({
    textDeltaCount: deltas.length,
    timeToFirstStatusMs: Math.round(firstStatus!.receivedAt),
    timeToFirstTextMs: Math.round(provisionalDeltas[0]!.receivedAt),
    lastTextDeltaMs: Math.round(provisionalDeltas.at(-1)!.receivedAt),
    telemetry: done.telemetry,
  }));
});

test('authenticated owner can explicitly cancel an active workflow run', {
  skip: !baseUrl || !bearerToken ? 'Set AGENT_E2E_URL and AGENT_E2E_BEARER from an existing valid development session' : false,
}, async () => {
  const conversationResponse = await fetch(`${baseUrl}/api/agent/conversations`, { method: 'POST', headers, body: '{}' });
  assert.equal(conversationResponse.status, 201);
  const conversation = await conversationResponse.json() as { id: string };
  const response = await fetch(`${baseUrl}/api/agent/stream`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: 'Summarize the active company policy documents and cite the sources.', conversationId: conversation.id }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let runId: string | undefined;
  const firstDeadline = Date.now() + 15_000;
  while (!runId && Date.now() < firstDeadline) {
    const next = await withTimeout(reader.read(), Math.max(1, firstDeadline - Date.now()), 'Timed out waiting for initial run status');
    assert.ok(next.value);
    pending += decoder.decode(next.value, { stream: true });
    const statusFrame = pending.split('\n\n').find(frame => frame.startsWith('event: status\n'));
    if (statusFrame) {
      const dataLine = statusFrame.split('\n').find(line => line.startsWith('data: '));
      if (dataLine) runId = (JSON.parse(dataLine.slice(6)) as { runId?: string }).runId;
    }
  }
  assert.match(runId ?? '', /^[0-9a-f-]{36}$/i);

  const cancelled = await fetch(`${baseUrl}/api/agent/runs/${runId}/cancel`, { method: 'POST', headers });
  assert.equal(cancelled.status, 200);
  const acknowledgement = await cancelled.json() as { status: string; cancellationRequested: boolean; executionSettled: boolean; providerStopConfirmed: boolean };
  assert.ok(['cancelling', 'cancelled'].includes(acknowledgement.status));
  assert.equal(acknowledgement.cancellationRequested, true);

  const cancelDeadline = Date.now() + 30_000;
  let cancellationEvent: Record<string, any> | undefined;
  while (!cancellationEvent && Date.now() < cancelDeadline) {
    const next = await withTimeout(reader.read(), Math.max(1, cancelDeadline - Date.now()), 'Timed out waiting for cancellation confirmation');
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    const frames = pending.split('\n\n');
    pending = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.startsWith('event: cancelled\n')) continue;
      const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
      if (dataLine) cancellationEvent = JSON.parse(dataLine.slice(6));
    }
  }
  assert.ok(cancellationEvent, 'expected server confirmation after the execution stopped');
  assert.equal(cancellationEvent.executionSettled, true);
  assert.equal(cancellationEvent.providerStopConfirmed, false);
  await reader.cancel().catch(() => undefined);
  const historyResponse = await fetch(`${baseUrl}/api/agent/conversations/${conversation.id}`, { headers });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as { messages: Array<{ role: string; content: string; status: string }> };
  const assistantMessage = history.messages.at(-1);
  assert.equal(assistantMessage?.role, 'assistant');
  assert.equal(assistantMessage?.status, 'interrupted');
  assert.equal(assistantMessage?.content, '');
  await fetch(`${baseUrl}/api/agent/conversations/${conversation.id}`, { method: 'DELETE', headers });
});

for (const target of ['planning', 'searching', 'model'] as const) {
  test(`authenticated owner can cancel during ${target}`, {
    skip: !baseUrl || !bearerToken ? 'Set AGENT_E2E_URL and AGENT_E2E_BEARER from an existing valid development session' : false,
  }, () => cancelAtWorkflowPoint(target));
}

test('disconnecting the chat stream leaves the backend turn running and persists its final answer', {
  skip: !baseUrl || !bearerToken ? 'Set AGENT_E2E_URL and AGENT_E2E_BEARER from an existing valid development session' : false,
}, async () => {
  const conversationResponse = await fetch(`${baseUrl}/api/agent/conversations`, {
    method: 'POST', headers, body: '{}',
  });
  const conversation = await conversationResponse.json() as { id: string };
  const abortController = new AbortController();
  const response = await fetch(`${baseUrl}/api/agent/stream`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: 'What is the SitePilot Enterprise monthly subscription price?', conversationId: conversation.id }),
    signal: abortController.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.ok(value, 'expected initial status event');
  assert.match(new TextDecoder().decode(value), /event: status/);
  abortController.abort();
  await reader.cancel().catch(() => undefined);

  const deadline = Date.now() + 190_000;
  let stored: { messages: Array<{ role: string; content: string; status: string; stage: string | null }> } | undefined;
  while (Date.now() < deadline) {
    const storedResponse = await fetch(`${baseUrl}/api/agent/conversations/${conversation.id}`, {
      headers,
    });
    stored = await storedResponse.json() as typeof stored;
    const latest = stored?.messages.at(-1);
    if (latest?.status !== 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.deepEqual(stored?.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(stored?.messages.at(-1)?.status, 'completed');
  assert.match(stored?.messages.at(-1)?.content ?? '', /249/);
  assert.equal(stored?.messages.at(-1)?.stage, null);

  const listResponse = await fetch(`${baseUrl}/api/agent/conversations`, { headers });
  const list = await listResponse.json() as { conversations: Array<{ id: string; lastMessage: { status: string } | null }> };
  assert.equal(list.conversations.find(item => item.id === conversation.id)?.lastMessage?.status, 'interrupted');
});
