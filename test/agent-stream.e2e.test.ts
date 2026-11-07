import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const baseUrl = process.env.AGENT_E2E_URL;
const apiKey = process.env.DEV_API_KEY;

test('Mastra streams a grounded TypeGraph answer progressively and persists the turn', {
  skip: !baseUrl || !apiKey ? 'Set AGENT_E2E_URL and DEV_API_KEY for the real local E2E test' : false,
}, async () => {
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey! };
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
  const deltas = events.filter(event => event.name === 'text-delta');
  assert.ok(deltas.length > 1, `Expected incremental text deltas; got ${deltas.length}`);
  assert.ok(deltas.every(event => event.data.verification === 'provisional'));
  const done = events.find(event => event.name === 'done')?.data;
  assert.ok(done);
  assert.ok(deltas.at(-1)!.receivedAt < events.find(event => event.name === 'done')!.receivedAt);
  assert.equal(done.citationValidation, 'valid');
  assert.match(done.answer, /249/);
  assert.ok(done.answer.includes('[[sitepilot-e2e-pricing.md (chunk 1)]]'));
  assert.ok(done.sources.some((source: { sourceRef: string }) => source.sourceRef === 'sitepilot-e2e-pricing.md (chunk 1)'));

  const storedResponse = await fetch(`${baseUrl}/api/agent/conversations/${conversation.id}`, {
    headers: { 'x-api-key': apiKey! },
  });
  assert.equal(storedResponse.status, 200);
  const stored = await storedResponse.json() as { messages: Array<{ role: string }> };
  assert.deepEqual(stored.messages.map(message => message.role), ['user', 'assistant']);
  console.log(JSON.stringify({
    textDeltaCount: deltas.length,
    timeToFirstTextMs: Math.round(deltas[0]!.receivedAt),
    lastTextDeltaMs: Math.round(deltas.at(-1)!.receivedAt),
    telemetry: done.telemetry,
  }));
});

test('disconnecting the chat stream leaves the backend turn running and persists its final answer', {
  skip: !baseUrl || !apiKey ? 'Set AGENT_E2E_URL and DEV_API_KEY for the real local E2E test' : false,
}, async () => {
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey! };
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
      headers: { 'x-api-key': apiKey! },
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

  const listResponse = await fetch(`${baseUrl}/api/agent/conversations`, { headers: { 'x-api-key': apiKey! } });
  const list = await listResponse.json() as { conversations: Array<{ id: string; lastMessage: { status: string } | null }> };
  assert.equal(list.conversations.find(item => item.id === conversation.id)?.lastMessage?.status, 'interrupted');
});
