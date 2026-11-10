import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, mock } from 'node:test';
import { Module, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '../src/agent/agent.controller.js';
import { AgentService } from '../src/agent/agent.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { config } from '../src/config.js';

// In-memory Prisma-shaped store: this tests real HTTP/controller/service/workflow
// behavior, not database durability, transactions, JWT cryptography or live LLM quality.
function store() {
  const conversations: any[] = [], messages: any[] = [];
  let clock = Date.now();
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'OR') return value.some((clause: any) => matches(row, clause));
    if (value && typeof value === 'object') return value.in ? value.in.includes(row[key]) : value.lt ? row[key] < value.lt : true;
    return row[key] === value;
  });
  const model = (rows: any[]) => ({
    create: async ({ data }: any) => { const row = { id: randomUUID(), createdAt: new Date(clock++), updatedAt: new Date(clock++), deletedAt: null, status: 'completed', ...data }; rows.push(row); return row; },
    findFirst: async ({ where }: any) => rows.find(row => matches(row, where)) ?? null,
    findMany: async ({ where, take, cursor, skip = 0, distinct }: any) => {
      let found = rows.filter(row => matches(row, where)).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      if (distinct) found = found.filter((row, index) => found.findIndex(other => other.conversationId === row.conversationId) === index);
      const start = cursor ? found.findIndex(row => row.id === cursor.id) + skip : 0;
      return found.slice(start, take === undefined ? undefined : start + take);
    },
    update: async ({ where, data }: any) => Object.assign(rows.find(row => matches(row, where)), data),
    updateMany: async ({ where, data }: any) => { const found = rows.filter(row => matches(row, where)); found.forEach(row => Object.assign(row, data)); return { count: found.length }; },
  });
  return { conversation: model(conversations), message: model(messages), $transaction: (ops: any[]) => Promise.all(ops), messages };
}

test('authenticated HTTP workflow preserves history after 429, paginates independently, retries and streams verified content', async () => {
  const previous = config.agentOrchestration;
  const previousObservability = process.env.MASTRA_OBSERVABILITY;
  config.agentOrchestration = 'workflow';
  process.env.MASTRA_OBSERVABILITY = 'false';
  const db = store();
  const principal = { userId: 'owner', tenantId: 'workspace', role: 'MEMBER', authMethod: 'jwt' };
  let limited = false;
  let pauseStreaming = false;
  let slowStreaming = false;
  let planPrompt = '';
  let analyticsMode: 'rank' | 'followup' | undefined;
  const workbook = { documentId: randomUUID(), filename: 'violations.xlsx', sheets: [{ sheetName: 'Warnings', columns: ['Employee', 'Year'] }] };
  const selection = { documentId: workbook.documentId, versionId: randomUUID(), sheetName: 'Warnings', columnName: 'Employee', values: ['E1', 'E2'], filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }] };
  const queries: string[] = [];
  const hit = (id: string) => ({ content: `Project ${id}`, score: 0.4, sourceRef: id, metadata: {}, citation: { documentId: id, filename: `${id}.md`, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } });
  const service = new AgentService({ searchDocuments: async (query: string, _limit: number, tenant: string, user: string) => {
    assert.equal(tenant, 'workspace'); assert.equal(user, 'owner'); queries.push(query);
    return { query, hits: [hit(query.includes('cost') ? 'costs' : 'risks')], timing: { embeddingMs: 0, retrievalMs: 1, searchMs: 1 } };
  } } as any, db as any, {
    discoverDatasets: async () => [workbook],
    aggregate: async (_operation: string, _column: string, tenant: string, scope: any) => {
      assert.equal(tenant, principal.tenantId);
      assert.deepEqual(scope.filters, selection.filters);
      if (analyticsMode === 'followup') {
        assert.deepEqual(scope.selection, selection);
        return { operation: 'COUNT', total: 11 };
      }
      assert.equal(scope.groupLimit, 2);
      return { operation: 'GROUP_BY', groups: [{ value: 'E1', count: 6 }, { value: 'E2', count: 5 }], selection, sources: [{ documentId: workbook.documentId, filename: workbook.filename, sourceRef: 'violations.xlsx rows 2-12', chunkIndex: 0 }] };
    },
  } as any);
  const generation = mock.method(Agent.prototype, 'generate', async function(this: Agent, messages: any, options: any) {
    if (config.modelProvider === 'ollama' && config.model.startsWith('qwen3') && !config.ollamaThink) assert.equal(options?.providerOptions?.ollama?.reasoningEffort, 'none');
    if (limited) throw Object.assign(new Error('mock rate limit'), { statusCode: 429, responseHeaders: { 'retry-after': '0' } });
    const prompt = messages[0].content;
    if (this.id.startsWith('sitepilot-planner')) {
      planPrompt = prompt;
      if (analyticsMode === 'rank') return { object: { operation: 'aggregate', aggregate: 'GROUP_BY', datasetId: workbook.documentId, columnName: 'Employee', filters: selection.filters, groupLimit: 2 } } as any;
      if (analyticsMode === 'followup') {
        if (!prompt.includes('Authorized schema:')) assert.match(prompt, /"values":\["E1","E2"\]/);
        return { object: { operation: 'aggregate', aggregate: 'COUNT', usePreviousSelection: true } } as any;
      }
      return { object: { operation: 'retrieve', standaloneQuestion: 'Compare project costs and risks', retrievalQuery: 'project costs risks', retrievalQueries: ['project costs', 'project risks'] } } as any;
    }
    return { object: { answer: 'Costs and risks are documented.', evidenceSufficient: true, evidenceIds: ['E1', 'E2'] } } as any;
  });
  const streaming = mock.method(Agent.prototype, 'stream', async (_messages: any, options: any) => {
    assert.deepEqual(options.activeTools, []);
    if (config.modelProvider === 'ollama' && config.model.startsWith('qwen3') && !config.ollamaThink) assert.equal(options?.providerOptions?.ollama?.reasoningEffort, 'none');
    return ({
    fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'Costs ' } }; if (slowStreaming) await new Promise(resolve => setTimeout(resolve, 200)); if (pauseStreaming) { await new Promise<void>((_resolve, reject) => { const abort = () => reject(options.abortSignal.reason); if (options.abortSignal.aborted) abort(); else options.abortSignal.addEventListener('abort', abort, { once: true }); }); } yield { type: 'text-delta', payload: { text: 'and risks.' } }; })(),
    getFullOutput: async () => ({ text: 'Costs and risks.' }),
  }) as any; });
  @Module({ controllers: [AgentController], providers: [
    { provide: AgentService, useValue: service },
    { provide: AuthService, useValue: { validateAccessToken: async (token: string) => { if (!['test-session', 'test-other'].includes(token)) throw new UnauthorizedException(); return token === 'test-other' ? { ...principal, userId: 'other-owner' } : principal; } } },
  ] }) class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const headers = { authorization: 'Bearer test-session', 'content-type': 'application/json' };
  const request = (path: string, body?: any) => fetch(`${base}/api/agent/${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  try {
    assert.equal((await fetch(`${base}/api/agent/conversations`)).status, 401);
    const conversation = await (await request('conversations', {})).json() as any;
    const id = conversation.id;
    for (let index = 0; index < 6; index++) assert.equal((await request('ask', { message: `Project comparison ${index}`, conversationId: id })).status, 201);
    const before = await (await request(`conversations/${id}`)).json() as any;
    assert.equal(before.messages.length, 12);
    limited = true;
    assert.equal((await request('ask', { message: 'Failed request', conversationId: id })).status, 503);
    const after = await (await request(`conversations/${id}`)).json() as any;
    assert.equal(after.messages.length, 14);
    assert.deepEqual(after.messages.slice(0, 12), before.messages);
    assert.equal(after.messages.at(-1).status, 'failed');
    assert.ok((await (await request('conversations')).json() as any).conversations.some((c: any) => c.id === id));
    const page = await (await request(`conversations/${id}?limit=5`)).json() as any;
    assert.equal(page.messages.length, 5); assert.equal(page.hasMore, true);
    assert.deepEqual(page.meta, { limit: 5, count: 5, hasMore: true, nextCursor: page.nextCursor, direction: 'older' });
    const older = await (await request(`conversations/${id}?limit=5&cursor=${page.nextCursor}`)).json() as any;
    assert.equal(older.messages.length, 5);
    assert.equal(older.meta.count, older.messages.length);
    assert.equal(older.meta.nextCursor, older.nextCursor);
    assert.ok(older.messages.every((m: any) => !page.messages.some((n: any) => n.id === m.id)));
    const failedStream = await request('stream', { message: 'Rate limited stream', conversationId: id });
    const failedFrames = await failedStream.text();
    assert.match(failedFrames, /event: error/);
    assert.match(failedFrames, /PROVIDER_RATE_LIMITED/);
    assert.doesNotMatch(failedFrames, /event: done/);
    assert.equal((await (await request(`conversations/${id}`)).json() as any).messages.at(-1).status, 'failed');
    limited = false;
    for (const message of ['\u0642\u0627\u0631\u0646 \u0628\u064a\u0646\u0647\u0645\u0627', '\u0130kisini kar\u015f\u0131la\u015ft\u0131r', 'Compare them']) {
      const response = await request('stream', { message, conversationId: id });
      const frames = (await response.text()).split('\n\n').filter(Boolean).map(frame => ({ name: frame.split('\n')[0]!.slice(7), data: JSON.parse(frame.split('\ndata: ')[1]!) }));
      for (const name of ['status', 'stage', 'tool-start', 'tool-finish', 'text-delta', 'text-reset', 'sources', 'done']) assert.ok(frames.some(frame => frame.name === name), name);
      assert.equal(frames.filter(frame => frame.name === 'done').length, 1);
      const final = frames.find(frame => frame.name === 'done')!.data;
      assert.equal(final.telemetry.llmCalls, 3);
      assert.equal(final.sources.length, 2);
      const saved = await (await request(`conversations/${id}`)).json() as any;
      assert.equal(saved.messages.at(-1).content, final.answer);
      assert.match(planPrompt, /Project comparison/);
      assert.match(planPrompt, new RegExp(message));
      assert.equal(final.citationValidation, 'valid');
    }
    slowStreaming = true;
    const disconnected = new AbortController();
    const transport = await fetch(`${base}/api/agent/stream`, { method: 'POST', headers, body: JSON.stringify({ message: 'Continue after disconnect', conversationId: id }), signal: disconnected.signal });
    const transportReader = transport.body!.getReader();
    await transportReader.read();
    disconnected.abort();
    await transportReader.cancel().catch(() => undefined);
    const deadline = Date.now() + 3000;
    let restored: any;
    do {
      await new Promise(resolve => setTimeout(resolve, 20));
      restored = await (await request(`conversations/${id}`)).json() as any;
    } while (restored.messages.at(-1).status === 'processing' && Date.now() < deadline);
    assert.equal(restored.messages.at(-1).status, 'completed');
    assert.match(restored.messages.at(-1).content, /Costs and risks are documented/);
    slowStreaming = false;
    pauseStreaming = true;
    const cancellationResponse = await request('stream', { message: 'Cancel this comparison', conversationId: id });
    const reader = cancellationResponse.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: text-delta')) {
      const next = await reader.read(); assert.equal(next.done, false); received += decoder.decode(next.value);
    }
    const runId = JSON.parse(received.split('event: status\ndata: ')[1]!.split('\n')[0]!).runId;
    assert.equal((await request(`runs/${runId}/cancel`, {})).status, 201);
    for (;;) { const next = await reader.read(); if (next.done) break; received += decoder.decode(next.value); }
    assert.match(received, /event: cancelled/);
    assert.doesNotMatch(received, /event: done/);
    assert.equal((await (await request(`conversations/${id}`)).json() as any).messages.at(-1).status, 'interrupted');
    assert.ok(queries.includes('project costs') && queries.includes('project risks'));
    assert.equal((await request(`conversations/${id}?limit=nope`)).status, 400);
    assert.equal((await fetch(`${base}/api/agent/conversations/${id}`, { headers: { authorization: 'Bearer test-other' } })).status, 404);
    for (let index = 0; index < 53; index++) await request('conversations', {});
    const listPage = await (await request('conversations')).json() as any;
    assert.equal(listPage.conversations.length, 50); assert.equal(listPage.hasMore, true);
    assert.deepEqual(listPage.meta, { limit: 50, count: 50, hasMore: true, nextCursor: listPage.nextCursor, direction: 'older' });
    const olderList = await (await request(`conversations?cursor=${listPage.nextCursor}`)).json() as any;
    assert.equal(olderList.hasMore, false);
    assert.equal(olderList.meta.hasMore, false); assert.equal(olderList.meta.nextCursor, null);
    assert.equal(new Set([...listPage.conversations, ...olderList.conversations].map((c: any) => c.id)).size, 54);
    assert.ok(olderList.conversations.some((c: any) => c.id === id));
    const other = await fetch(`${base}/api/agent/conversations?cursor=${listPage.nextCursor}`, { headers: { authorization: 'Bearer test-other' } });
    assert.equal(other.status, 404);
    analyticsMode = 'rank';
    const ranked = await request('ask', { message: 'Top two employees in 2025', conversationId: id });
    assert.equal(ranked.status, 201);
    assert.match((await ranked.json() as any).answer, /E1: 6/);
    assert.deepEqual(db.messages.at(-1).structuredSelection, selection);
    limited = true;
    assert.equal((await request('ask', { message: 'Provider failure', conversationId: id })).status, 503);
    limited = false;
    analyticsMode = 'followup';
    const followup = await request('ask', { message: 'How many violations do they have?', conversationId: id });
    assert.equal(followup.status, 201);
    assert.match((await followup.json() as any).answer, /Record count: 11/);
    const history = await (await request(`conversations/${id}`)).json() as any;
    assert.ok(history.messages.every((message: any) => !('structuredSelection' in message)));

  } finally {
    await app.close(); generation.mock.restore(); streaming.mock.restore();
    config.agentOrchestration = previous;
    if (previousObservability === undefined) delete process.env.MASTRA_OBSERVABILITY; else process.env.MASTRA_OBSERVABILITY = previousObservability;
  }
});
