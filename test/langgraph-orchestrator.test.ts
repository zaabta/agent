import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLangGraphOrchestrator, SITEPILOT_GRAPH_EDGES, type AnswerModel, type PlannerModel } from '../src/agent/langgraph-orchestrator.js';
import { maskConversationForExternalGpt, maskForExternalGpt } from '../src/agent/external-gpt-policy.js';
import { assertReadOnlyAtomicTool, type AtomicToolRegistration } from '../src/agent/atomic-tool-contract.js';

const principal = { userId: 'user-a', tenantId: 'tenant-a', authMethod: 'jwt' as const };
const runtime = { planner: { provider: 'openai', model: 'planner-test', apiKey: 'key', ollamaThink: false }, answer: { provider: 'google', model: 'answer-test', apiKey: 'key', ollamaThink: false } };
function models(plan: unknown, response: { claims: Array<{ text: string; evidenceIds: string[] }>; missingInformation?: string[] }, count = { planner: 0, answer: 0 }, inspectAnswer?: (messages: unknown[]) => void) {
  const planner: PlannerModel = { withStructuredOutput: () => ({ invoke: async () => { count.planner++; return plan; } }) };
  const answer: AnswerModel = { withStructuredOutput: () => ({ invoke: async messages => { count.answer++; inspectAnswer?.(messages); return { parsed: { ...response, missingInformation: response.missingInformation ?? [] }, raw: { usage_metadata: { input_tokens: 4, output_tokens: 3 } } }; } }) };
  return { planner, answer };
}

test('graph topology puts evidence preparation and validation before the only answer call', () => {
  assert.deepEqual(SITEPILOT_GRAPH_EDGES, [
    'START->router', 'router->planner|tool_executor', 'planner->tool_executor',
    'tool_executor->evidence_collection', 'evidence_collection->source_resolution',
    'source_resolution->evidence_validation', 'evidence_validation->answer_provider',
    'answer_provider->finalization', 'finalization->END',
  ]);
});

test('ordinary conversation skips planner and all tools, then uses the answer model once', async () => {
  const count = { planner: 0, answer: 0 };
  const graph = createLangGraphOrchestrator({ typegraph: {} as any, principal, runtime, models: models({}, { claims: [{ text: 'Hello!', evidenceIds: [] }] }, count) });
  const result = await graph.invoke({ message: 'Hello there', history: [], signal: new AbortController().signal });
  assert.equal(result.answer, 'Hello!');
  assert.deepEqual(count, { planner: 0, answer: 1 });
  assert.deepEqual(result.sources, []);
});

test('workspace route resolves and validates authorized RAG evidence before structured answer generation', async () => {
  const order: string[] = [];
  const count = { planner: 0, answer: 0 };
  const progress = async (_event: string, data: Record<string, unknown>) => { if (typeof data.stage === 'string') order.push(data.stage); };
  const typegraph = { searchDocuments: async (_q: string, _n: number, tenantId: string, userId: string) => {
    assert.equal(tenantId, principal.tenantId); assert.equal(userId, principal.userId);
    return { hits: [{ sourceRef: 'report page 2', content: 'The beam is 350 mm wide.', citation: { documentId: 'doc-a', documentVersionId: 'v1', filename: 'report.pdf', chunkIndex: 1, pageNumber: 2 } }] };
  } } as any;
  const selected = models({ operation: 'retrieve', query: 'beam width' }, { claims: [{ text: 'The beam is 350 mm wide.', evidenceIds: ['E1'] }] }, count, () => {
    assert.ok(order.indexOf('evidence_validation') < order.indexOf('answer_provider'));
    assert.equal(count.answer, 1);
  });
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: selected, progress });
  const result = await graph.invoke({ message: 'What does the report say about beam width?', history: [], signal: new AbortController().signal });
  const firstStageIndexes = ['routing', 'planning', 'tool_execution', 'evidence_collection', 'source_resolution', 'evidence_validation', 'answer_provider', 'finalization'].map(stage => order.indexOf(stage));
  assert.ok(firstStageIndexes.every(index => index >= 0));
  assert.deepEqual(firstStageIndexes, [...firstStageIndexes].sort((a, b) => a - b));
  assert.equal(result.answer, 'The beam is 350 mm wide.');
  assert.equal(result.verificationStatus, 'unverified');
  assert.deepEqual(result.evidenceReferences[0]?.evidenceIds, ['E1']);
  assert.deepEqual(result.evidenceReferences[0]?.sources.map(source => source.sourceRef), ['report page 2']);
  assert.equal(result.sources[0]?.sourceRef, 'report page 2');
  assert.deepEqual(count, { planner: 1, answer: 1 });
});

test('missing authorized evidence returns safely without calling Answer Provider', async () => {
  const count = { planner: 0, answer: 0 };
  const graph = createLangGraphOrchestrator({ typegraph: { searchDocuments: async () => ({ hits: [] }) } as any, principal, runtime, models: models({ operation: 'retrieve', query: 'policy' }, { claims: [] }, count) });
  const result = await graph.invoke({ message: 'Find policy details in the documents', history: [], signal: new AbortController().signal });
  assert.equal(result.citationValidation, 'no-evidence');
  assert.match(result.answer, /do not contain evidence/i);
  assert.deepEqual(count, { planner: 1, answer: 0 });
});

test('deterministic document inventory preserves its source evidence relationship', async () => {
  const graph = createLangGraphOrchestrator({ typegraph: { listDocuments: async () => ({ documents: [{ id: 'd1', name: 'report.pdf', type: 'PDF' }] }) } as any, principal, runtime,
    models: models({ operation: 'registered_tool', toolId: 'list_documents', args: {} }, { claims: [] }) });
  const result = await graph.invoke({ message: 'List all documents in my workspace', history: [], signal: new AbortController().signal });
  assert.match(result.answer, /report\.pdf/);
  assert.deepEqual(result.evidenceReferences[0]?.evidenceIds, ['S1']);
  assert.deepEqual(result.evidenceReferences[0]?.sources, []);
  assert.equal(result.verificationStatus, 'unverified');
});

test('deterministic structured table keeps each row attached to its own source evidence id', async () => {
  const source = { documentId: 'doc-a', documentVersionId: 'v1', filename: 'rows.xlsx', sourceRef: 'rows.xlsx row 2', chunkIndex: 0 };
  const source2 = { ...source, sourceRef: 'rows.xlsx row 3', chunkIndex: 1 };
  const graph = createLangGraphOrchestrator({ typegraph: {} as any, structuredData: { lookupRows: async () => ({ records: [
    { cells: [{ columnName: 'Name', value: 'Deniz' }], source }, { cells: [{ columnName: 'Name', value: 'Aria' }], source: source2 },
  ], sources: [source, source2] }) } as any,
    principal, runtime, models: models({ operation: 'registered_tool', toolId: 'structured_row_lookup', args: { filters: [{ columnName: 'Name', operator: 'EQ', value: 'Deniz' }] } }, { claims: [{ text: 'Deniz is in row 2.', evidenceIds: ['S1'] }] }) });
  const result = await graph.invoke({ message: 'Find Deniz in the spreadsheet', history: [], signal: new AbortController().signal });
  assert.match(result.answer, /\| Name \|\n\| --- \|\n\| Deniz \|\n\| Aria \|/);
  assert.deepEqual(result.sources.map(item => item.sourceRef), [source.sourceRef, source2.sourceRef]);
  assert.deepEqual(result.evidenceReferences.map(item => item.evidenceIds), [['S1'], ['S2']]);
  assert.deepEqual(result.evidenceReferences.map(item => item.sources[0]?.sourceRef), [source.sourceRef, source2.sourceRef]);
});

test('planner and answer receive masked request, evidence, and source metadata; final sources stay masked', async () => {
  let answerPrompt = '';
  const planner: PlannerModel = { withStructuredOutput: () => ({ invoke: async messages => {
    const prompt = JSON.stringify(messages);
    assert.doesNotMatch(prompt, /ali@example\.com/);
    const token = prompt.match(/\[PRIVATE_\d+\]/)?.[0];
    assert.ok(token);
    return { operation: 'retrieve', query: `Find ${token} in the document` };
  } }) };
  const answer: AnswerModel = { withStructuredOutput: () => ({ invoke: async messages => {
    answerPrompt = JSON.stringify(messages);
    assert.doesNotMatch(answerPrompt, /ali@example\.com/);
    const token = answerPrompt.match(/\[PRIVATE_\d+\]/)?.[0];
    assert.ok(token);
    return { parsed: { claims: [{ text: `The contact is ${token}.`, evidenceIds: ['E1'] }], missingInformation: [] } };
  } }) };
  const typegraph = { searchDocuments: async () => {
    return { hits: [{ sourceRef: 'contact ali@example.com page 1', content: 'Contact: ali@example.com', citation: { documentId: 'doc-a', filename: 'ali@example.com.pdf', chunkIndex: 0 } }] };
  } } as any;
  const graph = createLangGraphOrchestrator({ typegraph, principal, runtime, models: { planner, answer } });
  const result = await graph.invoke({ message: 'Find ali@example.com in the document', history: [], signal: new AbortController().signal });
  assert.match(result.answer, /The contact is \[PRIVATE_\d+\]\./);
  assert.doesNotMatch(result.answer, /ali@example\.com/);
  assert.doesNotMatch(JSON.stringify(result.sources), /ali@example\.com/);
  assert.doesNotMatch(answerPrompt, /ali@example\.com/);
});

test('malformed structured model output fails once without repair or another model call', async () => {
  let calls = 0;
  const answer: AnswerModel = { withStructuredOutput: () => ({ invoke: async () => { calls++; return { parsed: null }; } }) };
  const graph = createLangGraphOrchestrator({ typegraph: {} as any, principal, runtime, models: { planner: models({}, { claims: [] }).planner, answer } });
  await assert.rejects(graph.invoke({ message: 'Hi', history: [], signal: new AbortController().signal }), /ANSWER_GENERATION_INVALID/);
  assert.equal(calls, 1);
});

test('workspace claims cannot omit their prepared evidence references', async () => {
  let answerCalls = 0;
  const answer: AnswerModel = { withStructuredOutput: () => ({ invoke: async () => { answerCalls++; return { parsed: { claims: [{ text: 'Unsupported fact.', evidenceIds: [] }], missingInformation: [] } }; } }) };
  const graph = createLangGraphOrchestrator({ typegraph: { searchDocuments: async () => ({ hits: [{ sourceRef: 'doc page 1', content: 'A supported fact.', citation: { documentId: 'd1', filename: 'doc.pdf', chunkIndex: 0 } }] }) } as any,
    principal, runtime, models: { planner: models({ operation: 'retrieve', query: 'fact' }, { claims: [] }).planner, answer } });
  await assert.rejects(graph.invoke({ message: 'Find the fact in the document', history: [], signal: new AbortController().signal }), /ANSWER_GENERATION_INVALID/);
  assert.equal(answerCalls, 1);
});

test('external GPT policy masks personal data and keeps its replacement mapping private', () => {
  const masked = maskForExternalGpt('Email ali@example.com or call +1 (555) 123-4567', 'tenant-a');
  assert.doesNotMatch(masked.text, /ali@example.com|555/);
  assert.ok(masked.replacements.size >= 2);
  assert.doesNotMatch(masked.text, /tenant-a/);
  assert.equal(maskConversationForExternalGpt([{ role: 'user', content: 'mail ali@example.com' }], 'tenant-a')[0]!.content.includes('ali@example.com'), false);
});

test('Atomic registration contract remains read-only', () => {
  const registration: AtomicToolRegistration = { id: 'atomic_read', description: 'Read', readOnly: true, inputSchema: { parse: value => value }, authorize: () => true, execute: async value => value };
  assert.doesNotThrow(() => assertReadOnlyAtomicTool(registration));
  assert.throws(() => assertReadOnlyAtomicTool({ ...registration, readOnly: false } as any), /ATOMIC_TOOL_REGISTRATION_REJECTED/);
});
