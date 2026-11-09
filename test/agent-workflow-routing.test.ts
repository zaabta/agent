import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { createAgentWorkflow } from '../src/agent/agent.workflow.js';

for (const scenario of ['narrative', 'unknown-column', 'aggregate-unique', 'aggregate-year', 'mixed', 'followup', 'same-source-chunks', 'irrelevant-evidence', 'mislabelled-refusal', 'invalid-verifier-refusal'] as const) {
  test(`workflow routing recovery: ${scenario}`, async () => {
    const previous = process.env.MASTRA_OBSERVABILITY;
    process.env.MASTRA_OBSERVABILITY = 'false';
    const calls: string[] = [];
    const datasets = [
      { documentId: '11111111-1111-4111-8111-111111111111', filename: 'items.csv', sheets: [{ sheetName: 'CSV', columns: ['Project', 'Item', 'Cost'] }] },
      { documentId: '22222222-2222-4222-8222-222222222222', filename: 'violations.xlsx', sheets: [{ sheetName: 'Warnings', columns: ['Project', 'Warning', 'Year'] }] },
    ];
    const generate = mock.method(Agent.prototype, 'generate', async function(this: Agent, messages: any) {
      const prompt = messages[0].content;
      if (this.id.startsWith('sitepilot-planner')) {
        if (prompt.startsWith('Decide whether')) return { object: scenario === 'narrative' ? { mode: 'retrieve', retrievalQueries: ['project budget', 'project risks'] } : { mode: 'structured' } } as any;
        if (scenario === 'mixed') return { object: { operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }], documentQuestion: 'What risks are in the safety reports?' } } as any;
        if (scenario === 'aggregate-year') return { object: { operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }] } } as any;
        if (scenario === 'aggregate-unique' && prompt.includes('Authorized schema:')) return { object: { operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Project', operator: 'EQ', value: 'Orion' }] } } as any;
        if (scenario === 'same-source-chunks' || scenario === 'irrelevant-evidence' || scenario === 'mislabelled-refusal' || scenario === 'invalid-verifier-refusal') return { object: { operation: 'retrieve', retrievalQueries: ['first fact', 'second fact'] } } as any;
        if (scenario === 'followup') return { object: { operation: 'respond', standaloneQuestion: 'What are the project risks?', reply: 'وماذا عن المخاطر؟' } } as any;
        return { object: { operation: 'aggregate', aggregate: 'SUM', columnName: scenario === 'aggregate-unique' ? 'Cost' : 'Budget' } } as any;
      }
      if (scenario === 'followup') assert.ok(prompt.includes('ORIGINAL user message (answer in this language): وماذا عن المخاطر؟'));
      const ids = [...prompt.matchAll(/(?:^|\n)(E\d+):/g)].map((m: any) => m[1]);
      if (scenario === 'irrelevant-evidence') return { object: { answer: 'لا تتوفر أدلة كافية في الملفات للإجابة.', evidenceSufficient: false, evidenceIds: [] } } as any;
      if (scenario === 'mislabelled-refusal') return { object: { answer: 'لا يوجد إشارة إلى اسم شركة التأمين لمشروع Orion في البيانات المقدمة.', evidenceSufficient: true, evidenceIds: ids } } as any;
      if (scenario === 'invalid-verifier-refusal') return { object: { answer: '', evidenceSufficient: false, evidenceIds: [] } } as any;
      return { object: { answer: 'Supported fixture answer', evidenceSufficient: true, evidenceIds: scenario === 'same-source-chunks' ? [...ids, ids[0]] : ids } } as any;
    });
    const stream = mock.method(Agent.prototype, 'stream', async (messages: any) => {
      if (scenario === 'invalid-verifier-refusal') return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'الشركة المُؤمنة لمشروع Orion غير مذكورة في المعلومات المتاحة.' } }; })(), getFullOutput: async () => ({}) } as any;
      if (scenario === 'followup') assert.ok(messages[0].content.includes('ORIGINAL user message (answer in this language): وماذا عن المخاطر؟'));
      if (scenario === 'same-source-chunks') { assert.ok(messages[0].content.includes('First fact 17')); assert.ok(messages[0].content.includes('Second fact 29')); }
      return ({ fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'Supported fixture answer' } }; })(), getFullOutput: async () => ({ text: 'Supported fixture answer' }) }) as any; });
    const typegraph: any = { searchDocuments: async (query: string) => {
      calls.push(query);
      if (scenario === 'same-source-chunks') { const first = query.startsWith('first'); return { query, hits: [{ score: 0.8, content: first ? 'First fact 17' : 'Second fact 29', sourceRef: 'shared.pdf (page 1)', metadata: {}, citation: { documentId: 'shared', filename: 'shared.pdf', bucketId: 'documents', chunkIndex: first ? 0 : 1, chunkCount: 2 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } }; }
      const id = query.includes('budget') ? 'budget' : 'risks';
      return { query, hits: [{ score: 0.7, content: `Project ${id} facts`, sourceRef: id, metadata: {}, citation: { documentId: id, filename: `${id}.md`, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
    } };
    const structured: any = {
      discoverDatasets: async () => datasets,
      lookupAnyExact: async () => { assert.fail('A valid aggregation filter must not trigger an exact lookup'); },
      aggregate: async (_operation: string, column: string, _tenant: string, scope: any) => {
        if (scenario === 'aggregate-year' || scenario === 'mixed') {
          assert.equal(_operation, 'COUNT');
          assert.equal(scope.documentId, datasets[1]!.documentId);
          assert.deepEqual(scope.filters, [{ columnName: 'Year', operator: 'EQ', value: '2025' }]);
          return { operation: 'COUNT', total: 21, sources: [{ documentId: datasets[1]!.documentId, filename: 'violations.xlsx', sourceRef: 'violations.xlsx rows 2-22', chunkIndex: 0 }] };
        }
        assert.equal(column, 'Cost'); assert.equal(scope.documentId, datasets[0]!.documentId);
        return { operation: 'SUM', value: 300, sources: [{ documentId: datasets[0]!.documentId, filename: 'items.csv', sourceRef: 'items.csv rows 2-3', chunkIndex: 0 }] };
      },
    };
    try {
      const workflow = createAgentWorkflow(typegraph, structured, { userId: 'user', tenantId: 'tenant', role: 'MEMBER', authMethod: 'jwt' });
      const run = await workflow.createRun();
      const result = await run.start({ inputData: { message: scenario === 'followup' ? 'وماذا عن المخاطر؟' : scenario === 'narrative' ? 'Compare project Budget and risks across reports' : scenario === 'aggregate-unique' ? 'Sum Orion item costs' : scenario === 'mixed' ? 'Count violations in 2025 and describe report risks' : scenario === 'aggregate-year' ? 'How many violations were recorded in 2025?' : 'Sum the Budget column', history: scenario === 'followup' ? [{ role: 'user', content: 'Describe the project' }, { role: 'assistant', content: 'Project evidence [[project.md (line 1)]]' }] : [] } });
      assert.equal(result.status, 'success');
      if (result.status !== 'success') return;
      if (scenario === 'unknown-column') { assert.equal(result.result.outcome, 'clarification'); assert.deepEqual(calls, []); }
      else if (scenario === 'irrelevant-evidence' || scenario === 'mislabelled-refusal' || scenario === 'invalid-verifier-refusal') {
        assert.ok(calls.length > 0);
        assert.equal(result.result.outcome, 'empty');
        assert.equal(result.result.citationValidation, 'no-evidence');
        assert.deepEqual(result.result.sources, []);
        assert.equal(result.result.answer, scenario === 'irrelevant-evidence' ? 'لا تتوفر أدلة كافية في الملفات للإجابة.' : scenario === 'invalid-verifier-refusal' ? 'الشركة المُؤمنة لمشروع Orion غير مذكورة في المعلومات المتاحة.' : 'لا يوجد إشارة إلى اسم شركة التأمين لمشروع Orion في البيانات المقدمة.');
      }
      else if (scenario === 'mixed') {
        assert.match(result.result.answer, /21/);
        assert.match(result.result.answer, /Supported fixture answer/);
        assert.deepEqual(calls, ['What risks are in the safety reports?']);
        assert.deepEqual(result.result.sources.map(source => source.filename).sort(), ['risks.md', 'violations.xlsx']);
      }
      else if (scenario === 'aggregate-year') { assert.match(result.result.answer, /21/); assert.deepEqual(calls, []); }
      else if (scenario === 'aggregate-unique') { assert.match(result.result.answer, /300/); assert.deepEqual(calls, []); }
      else { assert.ok(calls.length > 0); assert.ok(result.result.toolsCalled.includes('documentSearch')); assert.equal(result.result.citationValidation, 'valid'); if (scenario === 'narrative') assert.equal(result.result.sources.length, 2); if (scenario === 'same-source-chunks') assert.equal(result.result.sources.length, 1); }
    } finally {
      generate.mock.restore(); stream.mock.restore();
      if (previous === undefined) delete process.env.MASTRA_OBSERVABILITY; else process.env.MASTRA_OBSERVABILITY = previous;
    }
  });
}
