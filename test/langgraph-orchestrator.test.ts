import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLangGraphOrchestrator, SITEPILOT_GRAPH_EDGES, type AnswerModel, type PlannerModel } from '../src/agent/langgraph-orchestrator.js';
import { maskConversationForExternalGpt, maskForExternalGpt } from '../src/agent/external-gpt-policy.js';
import { assertReadOnlyAtomicTool, type AtomicToolRegistration } from '../src/agent/atomic-tool-contract.js';

const principal = { userId: 'user-a', tenantId: 'tenant-a', authMethod: 'jwt' as const };
const runtime = { planner: { provider: 'openai', model: 'gpt-test', apiKey: 'key', ollamaThink: false }, answer: { provider: 'openai', model: 'gpt-test', apiKey: 'key', ollamaThink: false } };
function models(plan: unknown, answer: string, count: { planner: number; answer: number }) {
  const planner: PlannerModel = { withStructuredOutput: () => ({ invoke: async () => { count.planner++; return plan; } }) };
  const answerModel: AnswerModel = { stream: async () => ({ async *[Symbol.asyncIterator]() { count.answer++; yield { content: answer }; } }) };
  return { planner, answer: answerModel };
}

test('graph topology has the router, optional planner, authorized executor, evidence, answer, and integrity nodes', () => {
  assert.deepEqual(SITEPILOT_GRAPH_EDGES, [
    'START->router', 'router->planner|tool_executor', 'planner->tool_executor',
    'tool_executor->evidence_collector', 'evidence_collector->answer_composer',
    'answer_composer->integrity_gate', 'integrity_gate->END',
  ]);
});

test('ordinary conversation skips planner and data tools', async () => {
  const count = { planner: 0, answer: 0 };
  const typegraph = { searchDocuments: async () => { throw new Error('unexpected retrieval'); } } as any;
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: models({ operation: 'retrieve', query: 'unused' }, 'Hello!', count) });
  const result = await graph.invoke({ message: 'Hello there', history: [], signal: new AbortController().signal });
  assert.equal(result.answer, 'Hello!');
  assert.equal(result.verificationStatus, 'not_required');
  assert.deepEqual(count, { planner: 0, answer: 1 });
});

test('workspace question uses authorized existing RAG and validates source attribution', async () => {
  const count = { planner: 0, answer: 0 };
  const usage: any[] = [];
  const typegraph = { searchDocuments: async (_query: string, _limit: number, tenantId: string, userId: string) => {
    assert.equal(tenantId, 'tenant-a'); assert.equal(userId, 'user-a');
    return { hits: [{ sourceRef: 'report page 2', content: 'The beam is 350 mm wide.', citation: { documentId: 'doc-a', filename: 'report.pdf', chunkIndex: 1, pageNumber: 2 } }] };
  } } as any;
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: models({ operation: 'retrieve', query: 'beam width' }, 'The beam is 350 mm wide [[report page 2]].', count), onUsage: record => { usage.push(record); } });
  const result = await graph.invoke({ message: 'What does the report say about beam width?', history: [], signal: new AbortController().signal });
  assert.equal(result.answer, 'The beam is 350 mm wide [[report page 2]].');
  assert.equal(result.citationValidation, 'valid');
  assert.equal(result.verificationStatus, 'verified');
  assert.deepEqual(result.sources.map(source => source.sourceRef), ['report page 2']);
  assert.deepEqual(count, { planner: 1, answer: 1 });
  assert.deepEqual(usage.map(record => record.role), ['PLANNER', 'ANSWER']);
  assert.ok(usage.every(record => record.status === 'success'));
});

test('retrieval with no authorized hits refuses and marks missing evidence', async () => {
  const count = { planner: 0, answer: 0 };
  const typegraph = { searchDocuments: async () => ({ hits: [] }) } as any;
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: models({ operation: 'retrieve', query: 'policy details' }, 'unreachable', count) });
  const result = await graph.invoke({ message: 'Find the policy details in the documents', history: [], signal: new AbortController().signal });
  assert.equal(result.citationValidation, 'no-evidence');
  assert.match(result.answer, /do not contain evidence/i);
  assert.deepEqual(count, { planner: 1, answer: 0 });
});

test('conversation follow-up reuses context and sends the planner only masked prior turns', async () => {
  const count = { planner: 0, answer: 0 };
  let sawPriorTurn = false;
  const planner: PlannerModel = { withStructuredOutput: () => ({ invoke: async messages => { count.planner++; sawPriorTurn = JSON.stringify(messages).includes('Earlier report value'); return { operation: 'retrieve', query: 'report detail' }; } }) };
  const answer: AnswerModel = { stream: async () => ({ async *[Symbol.asyncIterator]() { count.answer++; yield { content: 'The report gives no further detail.' }; } }) };
  const typegraph = { searchDocuments: async () => ({ hits: [] }) } as any;
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: { planner, answer } });
  await graph.invoke({ message: 'What about it?', history: [{ role: 'user', content: 'Find the report value' }, { role: 'assistant', content: 'Earlier report value' }], signal: new AbortController().signal });
  assert.equal(sawPriorTurn, true);
  assert.deepEqual(count, { planner: 1, answer: 0 });
});

test('registered tools are rechecked against the authorized catalog and cited as tool evidence', async () => {
  const count = { planner: 0, answer: 0 };
  const catalog = [{ id: 'price_lookup', description: 'Read the authorized price', input: { item: 'string' }, version: 2 }];
  const backendTools = {
    catalog: async () => catalog,
    execute: async (call: any, authorizedPrincipal: any) => {
      assert.equal(call.id, 'price_lookup'); assert.deepEqual(authorizedPrincipal, principal);
      return { customToolId: 'price_lookup', configurationVersion: 2, data: { price: 25.5, currency: 'EUR' } };
    },
  } as any;
  const graph = createLangGraphOrchestrator({ typegraph: {} as any, principal, backendTools, runtime, models: models({ operation: 'registered_tool', toolId: 'price_lookup', args: { item: 'subscription' } }, 'The price is 25.5 EUR [T1].', count) });
  const result = await graph.invoke({ message: 'Look up the subscription price', history: [], signal: new AbortController().signal });
  assert.equal(result.answer, 'The price is 25.5 EUR [T1].');
  assert.deepEqual(result.toolsCalled, ['price_lookup']);
  assert.equal(result.citationValidation, 'valid');
  assert.equal(result.verificationStatus, 'verified');

  let unauthorizedExecuted = false;
  const unauthorized = { catalog: async () => catalog, execute: async () => { unauthorizedExecuted = true; } } as any;
  const invalidGraph = createLangGraphOrchestrator({ typegraph: {} as any, principal, backendTools: unauthorized, runtime, models: models({ operation: 'registered_tool', toolId: 'other_tool', args: {} }, 'unused', count) });
  const refused = await invalidGraph.invoke({ message: 'Call another tool in the workspace', history: [], signal: new AbortController().signal });
  assert.equal(refused.outcome, 'clarification');
  assert.equal(unauthorizedExecuted, false);
});

test('invalid citations are replaced by the final integrity gate', async () => {
  const count = { planner: 0, answer: 0 };
  const typegraph = { searchDocuments: async () => ({ hits: [{ sourceRef: 'report page 2', content: 'The beam is 350 mm wide.', citation: { documentId: 'doc-a', filename: 'report.pdf', chunkIndex: 1 } }] }) } as any;
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: models({ operation: 'retrieve', query: 'beam' }, 'The beam is 350 mm wide [[unknown source]].', count) });
  const result = await graph.invoke({ message: 'Find beam width in the report', history: [], signal: new AbortController().signal });
  assert.equal(result.citationValidation, 'fallback');
  assert.match(result.answer, /could not produce an answer with verifiable evidence/i);
  assert.deepEqual(result.sources, []);
});

test('external GPT policy masks user, conversation, and evidence identifiers in tenant scoped tokens', () => {
  const masked = maskForExternalGpt('Email ali@example.com or call +1 (555) 123-4567', 'tenant-a');
  assert.doesNotMatch(masked.text, /ali@example.com|555/);
  assert.equal(masked.replacements.size, 2);
  assert.ok([...masked.replacements.keys()].every(token => token.startsWith('[PRIVATE_tenant-a_')));
  assert.equal(maskConversationForExternalGpt([{ role: 'user', content: 'mail ali@example.com' }], 'tenant-a')[0]!.content.includes('ali@example.com'), false);
});

test('LangGraph masks messages and retrieved evidence before GPT, then privately restores exact RAG references', async () => {
  let referenceForAnswer = '';
  const planner: PlannerModel = { withStructuredOutput: () => ({ invoke: async messages => {
    const prompt = JSON.stringify(messages);
    assert.doesNotMatch(prompt, /ali@example\.com/);
    const token = prompt.match(/\[PRIVATE_tenant-a_\d+\]/)?.[0];
    assert.ok(token);
    return { operation: 'retrieve', query: `Find ${token} in report` };
  } }) };
  const answer: AnswerModel = { stream: async messages => ({ async *[Symbol.asyncIterator]() {
    const prompt = (messages as any[]).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message)).join('\n');
    assert.doesNotMatch(prompt, /ali@example\.com/);
    referenceForAnswer = prompt.match(/"sourceRef":"([^"]+)"/)?.[1] ?? '';
    assert.ok(referenceForAnswer);
    yield { content: `The contact is listed [[${referenceForAnswer}]].` };
  } }) };
  const typegraph = { searchDocuments: async (query: string, _limit: number, tenantId: string) => {
    assert.equal(tenantId, principal.tenantId); assert.match(query, /ali@example\.com/);
    return { hits: [{ sourceRef: 'report ali@example.com page 1', content: 'Contact: ali@example.com.', citation: { documentId: 'doc-a', filename: 'report ali@example.com.pdf', chunkIndex: 0 } }] };
  } } as any;
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: { planner, answer } });
  const result = await graph.invoke({ message: 'Find ali@example.com in the report', history: [{ role: 'user', content: 'Use ali@example.com' }], signal: new AbortController().signal });
  assert.equal(result.answer, 'The contact is listed [[report ali@example.com page 1]].');
  assert.equal(result.citationValidation, 'valid');
});

test('Atomic tool registration contract rejects write capability', () => {
  const atomicRead: AtomicToolRegistration = { id: 'atomic_document_metadata', description: 'Read metadata', readOnly: true, inputSchema: { parse: value => value }, authorize: () => true, execute: async value => value };
  assert.doesNotThrow(() => assertReadOnlyAtomicTool(atomicRead));
  assert.throws(() => assertReadOnlyAtomicTool({ ...atomicRead, readOnly: false } as any), /ATOMIC_TOOL_REGISTRATION_REJECTED/);
});
