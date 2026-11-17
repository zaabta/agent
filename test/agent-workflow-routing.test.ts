import { z } from 'zod';
import { BackendTools } from '../src/agent/backend-tools.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { createAgentWorkflow } from '../src/agent/agent.workflow.js';
import { readLocalWorkflowDiagnostic } from '../src/mastra/observability.js';
import { safeAgentFailure } from '../src/agent/provider-errors.js';

for (const scenario of ['narrative', 'unknown-column', 'aggregate-unique', 'aggregate-year', 'mixed', 'mixed-dependent', 'cohort-ar', 'cohort-tr', 'cohort-en', 'drawing-revisions', 'drawing-missing-revision', 'backend-mixed', 'backend-denied', 'backend-missing', 'custom-independent', 'custom-en', 'custom-ar', 'custom-ambiguous', 'custom-irrelevant', 'planner-invalid', 'planner-repair', 'followup', 'followup-ar', 'followup-tr', 'same-source-chunks', 'irrelevant-evidence', 'mislabelled-refusal', 'invalid-verifier-refusal'] as const) {
  test(`workflow routing recovery: ${scenario}`, async () => {
    const previous = process.env.MASTRA_OBSERVABILITY;
    process.env.MASTRA_OBSERVABILITY = 'false';
    const calls: string[] = [];
    const modelEvents: string[] = [];
    const datasets = [
      { documentId: '11111111-1111-4111-8111-111111111111', filename: 'items.csv', sheets: [{ sheetName: 'CSV', columns: ['Project', 'Item', 'Cost'] }] },
      { documentId: '22222222-2222-4222-8222-222222222222', filename: 'violations.xlsx', sheets: [{ sheetName: 'Warnings', columns: ['Project', 'Warning', 'Year', 'Employee'] }] },
    ];
    const cohortQuestions: Record<string, string> = {
      'cohort-ar': 'ÙƒÙ… Ù…Ø®Ø§Ù„ÙØ© Ù„Ø¯Ù‰ Ù‡Ø¤Ù„Ø§Ø¡ØŸ',
      'cohort-tr': 'BunlarÄ±n kaÃ§ ihlali var?',
      'cohort-en': 'How many violations do they have?',
    };
    const previousSelection = {
      documentId: datasets[1]!.documentId, versionId: '33333333-3333-4333-8333-333333333333',
      sheetName: 'Warnings', columnName: 'Employee', values: ['E1', 'E2'],
      filters: [{ columnName: 'Year', operator: 'EQ' as const, value: '2025' }],
    };
    const backendTools = new BackendTools();
    backendTools.register({
      id: 'employee_count', description: 'Count registered employees', input: z.strictObject({ department: z.string().min(1) }),
      authorize: principal => principal.tenantId === 'tenant' && scenario !== 'backend-denied',
      execute: async (args, principal) => {
        assert.equal(args.department, 'Safety');
        assert.equal(principal.userId, 'user');
        return 'Registered employees: 42';
      },
    });
    const dynamicCatalog = [
      { id: 'custom_11111111111141118111111111111111', name: 'weather_feed', displayName: 'Weather feed', description: 'Return current weather for a city, including temperature and conditions.', input: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'], additionalProperties: false }, version: 1 },
      { id: 'custom_22222222222242228222222222222222', name: 'fx_rates', displayName: 'Foreign exchange rates', description: 'Return the latest exchange rate between two ISO currency codes.', input: { type: 'object', properties: { base: { type: 'string' }, quote: { type: 'string' } }, required: ['base', 'quote'], additionalProperties: false }, version: 3 },
      { id: 'custom_33333333333343338333333333333333', name: 'air_quality', displayName: 'Air quality', description: 'Return current outdoor air quality index and pollutant levels for a city.', input: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }, version: 2 },
    ];
    const dynamicScenarios = ['custom-independent', 'custom-en', 'custom-ar', 'custom-ambiguous', 'custom-irrelevant', 'planner-repair'];
    const workflowTools = dynamicScenarios.includes(scenario) ? {
      catalog: async () => dynamicCatalog,
      execute: async (call: any, _principal: any, _signal: any, _onStart: any, context: any) => {
        context?.onSchemaValidation?.('valid');
        if (scenario === 'custom-independent' || scenario === 'custom-ar') assert.deepEqual(call, { id: dynamicCatalog[0]!.id, args: { city: 'Istanbul' } });
        if (scenario === 'custom-en') assert.deepEqual(call, { id: dynamicCatalog[1]!.id, args: { base: 'EUR', quote: 'JPY' } });
        return scenario === 'custom-en' ? { rate: 160.25 } : { temperatureC: 22, condition: 'clear' };
      },
    } as any : backendTools;
    const generate = mock.method(Agent.prototype, 'generate', async function(this: Agent, messages: any) {
      const prompt = messages[0].content;
      if (this.id.startsWith('sitepilot-planner')) {
        modelEvents.push('planner');
        if (prompt.startsWith('Decide whether')) return { object: scenario === 'narrative' ? { mode: 'retrieve', retrievalQueries: ['project budget', 'project risks'] } : { mode: 'structured' } } as any;
        if (cohortQuestions[scenario]) {
          if (!prompt.includes('Authorized schema:')) assert.match(prompt, /"values":\["E1","E2"\]/);
          return { object: { operation: 'aggregate', aggregate: 'COUNT', usePreviousSelection: !prompt.includes('Authorized schema:') } } as any;
        }
        if (scenario === 'drawing-revisions' || scenario === 'drawing-missing-revision') return { object: { operation: 'retrieve', compareDrawingRevisions: true, retrievalQueries: ['revision A', 'revision B'] } } as any;
        if (scenario.startsWith('backend-')) {
          if (scenario === 'backend-denied') assert.doesNotMatch(prompt, /Count registered employees/);
          else assert.match(prompt, /Count registered employees/);
          return { object: { operation: 'tool_call', toolCall: { id: scenario === 'backend-missing' ? 'missing' : 'employee_count', args: { department: 'Safety' } }, documentQuestion: 'What risks are in the safety reports?' } } as any;
        }
        if (scenario === 'custom-independent' || scenario === 'custom-ar') {
          assert.match(prompt, /Return current weather for a city/);
          assert.match(prompt, /Return the latest exchange rate/);
          assert.match(prompt, /Return current outdoor air quality/);
          return { object: { operation: 'tool_call', toolCall: { id: dynamicCatalog[0]!.id, args: { city: 'Istanbul' } } } } as any;
        }
        if (scenario === 'custom-en') {
          assert.match(prompt, /Return the latest exchange rate between two ISO currency codes/);
          assert.match(prompt, /"base":\s*\{\s*"type":"string"/);
          return { object: { operation: 'tool_call', toolCall: { id: dynamicCatalog[1]!.id, args: { base: 'EUR', quote: 'JPY' } } } } as any;
        }
        if (scenario === 'custom-ambiguous') return { object: { operation: 'clarify', reply: 'Do you mean weather or air quality?' } } as any;
        if (scenario === 'custom-irrelevant') return { object: { operation: 'retrieve', retrievalQuery: 'evacuation instructions in the safety handbook' } } as any;
        if (scenario === 'planner-invalid') return { object: { operation: 'invalid_operation' } } as any;
        if (scenario === 'planner-repair') {
          if (prompt.includes('Validation findings from the previous plan:')) {
            assert.match(prompt, /toolCall/);
            assert.doesNotMatch(prompt, /invalid id/i);
            return { object: { operation: 'tool_call', toolCall: { id: dynamicCatalog[0]!.id, args: { city: 'Oslo' } } } } as any;
          }
          return { object: { operation: 'tool_call', toolCall: { id: 'invalid id', args: { city: 'Oslo' } } } } as any;
        }
        if (scenario === 'mixed-dependent') return { object: { operation: 'aggregate', aggregate: 'GROUP_BY', columnName: 'Employee', groupLimit: 2, filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }], documentQuestion: 'What risks are in the safety reports?', searchRankedGroups: true } } as any;
        if (scenario === 'mixed' && !prompt.includes('Authorized schema:')) return { object: { operation: 'lookup', standaloneQuestion: 'Count violations from violations.xlsx' } } as any;
        if (scenario === 'mixed') assert.doesNotMatch(prompt, /describe report risks/);
        if (scenario === 'mixed') return { object: { operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }], documentQuestion: 'What risks are in the safety reports?' } } as any;
        if (scenario === 'aggregate-year') return { object: { operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }] } } as any;
        if (scenario === 'aggregate-unique' && prompt.includes('Authorized schema:')) return { object: { operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Project', operator: 'EQ', value: 'Orion' }] } } as any;
        if (scenario === 'same-source-chunks' || scenario === 'irrelevant-evidence' || scenario === 'mislabelled-refusal' || scenario === 'invalid-verifier-refusal') return { object: { operation: 'retrieve', retrievalQueries: ['first fact', 'second fact'] } } as any;
        if (scenario.startsWith('followup')) return { object: { operation: 'respond', standaloneQuestion: 'What are the project risks?', reply: 'How can I help?' } } as any;
        return { object: { operation: 'aggregate', aggregate: 'SUM', columnName: scenario === 'aggregate-unique' ? 'Cost' : 'Budget' } } as any;
      }
      if (dynamicScenarios.includes(scenario) && scenario !== 'custom-irrelevant') {
        if (scenario === 'custom-en') { assert.match(messages[0].content, /160.25/); return { object: { answer: 'The EUR to JPY rate is 160.25.' } } as any; }
        assert.match(messages[0].content, /temperatureC/);
        return { object: { answer: scenario === 'custom-ar' ? 'درجة الحرارة في إسطنبول 22 مئوية.' : 'Istanbul is 22 C.' } } as any;
      }
      modelEvents.push('citation-verifier');
      const ids = [...prompt.matchAll(/(?:^|\n)(E\d+):/g)].map((m: any) => m[1]);
      if (scenario === 'irrelevant-evidence') return { object: { answer: 'Ù„Ø§ ØªØªÙˆÙØ± Ø£Ø¯Ù„Ø© ÙƒØ§ÙÙŠØ© ÙÙŠ Ø§Ù„Ù…Ù„ÙØ§Øª Ù„Ù„Ø¥Ø¬Ø§Ø¨Ø©.', evidenceSufficient: false, evidenceIds: [] } } as any;
      if (scenario === 'mislabelled-refusal') return { object: { answer: 'The requested company is not mentioned in the available documents.', evidenceSufficient: true, evidenceIds: ids } } as any;
      if (scenario === 'invalid-verifier-refusal') return { object: { answer: '', evidenceSufficient: false, evidenceIds: [] } } as any;
      return { object: { answer: 'Supported fixture answer', evidenceSufficient: true, evidenceIds: scenario === 'same-source-chunks' ? [...ids, ids[0]] : ids } } as any;
    });
    const stream = mock.method(Agent.prototype, 'stream', async (messages: any) => {
      if (scenario === 'invalid-verifier-refusal') return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'Ø§Ù„Ø´Ø±ÙƒØ© Ø§Ù„Ù…ÙØ¤Ù…Ù†Ø© Ù„Ù…Ø´Ø±ÙˆØ¹ Orion ØºÙŠØ± Ù…Ø°ÙƒÙˆØ±Ø© ÙÙŠ Ø§Ù„Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø§Ù„Ù…ØªØ§Ø­Ø©.' } }; })(), getFullOutput: async () => ({}) } as any;
      if (scenario === 'same-source-chunks') { assert.ok(messages[0].content.includes('First fact 17')); assert.ok(messages[0].content.includes('Second fact 29')); }
      if (scenario === 'same-source-chunks') return ({ fullStream: (async function* () {
        modelEvents.push('model-delta-1'); yield { type: 'text-delta', payload: { text: 'Supported ' } };
        modelEvents.push('model-delta-2'); yield { type: 'text-delta', payload: { text: 'fixture answer' } };
      })(), getFullOutput: async () => ({ text: 'Supported fixture answer' }) }) as any;
      return ({ fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'Supported fixture answer' } }; })(), getFullOutput: async () => ({ text: 'Supported fixture answer' }) }) as any; });
    const typegraph: any = { listDocuments: async () => ({ documents: [], durationMs: 0 }), searchDocuments: async (query: string) => {
      calls.push(query);
      if (scenario === 'drawing-revisions' || scenario === 'drawing-missing-revision') {
        const name = query.endsWith('B') && scenario === 'drawing-revisions' ? 'B' : 'A';
        return { query, hits: [{ score: 0.8, content: 'Unverified dimension', sourceRef: `${name}.drawing.pdf (page 1)`, metadata: {}, citation: { documentId: name, filename: `${name}.drawing.pdf`, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      }
      if (scenario === 'same-source-chunks') { const first = query.startsWith('first'); return { query, hits: [{ score: 0.8, content: first ? 'First fact 17' : 'Second fact 29', sourceRef: 'shared.pdf (page 1)', metadata: {}, citation: { documentId: 'shared', filename: 'shared.pdf', bucketId: 'documents', chunkIndex: first ? 0 : 1, chunkCount: 2 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } }; }
      const id = query.includes('budget') ? 'budget' : 'risks';
      return { query, hits: [{ score: 0.7, content: `Project ${id} facts`, sourceRef: id, metadata: {}, citation: { documentId: id, filename: `${id}.md`, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
    } };
    const structured: any = {
      discoverDatasets: async () => datasets,
      lookupAnyExact: async () => { assert.fail('A valid aggregation filter must not trigger an exact lookup'); },
      aggregate: async (_operation: string, column: string, _tenant: string, scope: any) => {
        if (cohortQuestions[scenario]) {
          assert.deepEqual(scope.selection, previousSelection);
          assert.deepEqual(scope.filters, previousSelection.filters);
          return { operation: 'COUNT', total: 11 };
        }
        if (scenario === 'mixed-dependent') {
          assert.equal(_operation, 'GROUP_BY');
          assert.equal(scope.groupLimit, 2);
          assert.deepEqual(calls, []);
          return { operation: 'GROUP_BY', groups: [{ value: 'E1', count: 6 }, { value: 'E2', count: 5 }], sources: [{ documentId: datasets[1]!.documentId, filename: 'violations.xlsx', sourceRef: 'violations.xlsx rows 2-22', chunkIndex: 0 }] };
        }
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
      const workflow = createAgentWorkflow(typegraph, structured, { userId: 'user', tenantId: 'tenant', authMethod: 'jwt' }, undefined, {
        onTextDelta: async text => { if (scenario === 'same-source-chunks') modelEvents.push(text === 'Supported ' ? 'sse-delta-1' : 'sse-delta-2'); },
      }, workflowTools);
      const run = await workflow.createRun();
      const followupHistory = scenario === 'followup-tr'
        ? [
            { role: 'user' as const, content: 'Summarize the Orion project' },
            { role: 'assistant' as const, content: 'The project has documented risks. [[project.md (line 1)]]' },
            { role: 'user' as const, content: 'ماذا عن التكاليف؟' },
            { role: 'assistant' as const, content: 'التكاليف مذكورة في المستند. [[project.md (page 2)]]' },
          ]
        : scenario.startsWith('followup')
          ? [{ role: 'user' as const, content: 'Describe the project' }, { role: 'assistant' as const, content: 'Project evidence [[project.md (line 1)]]' }]
          : [];
      const followupMessage = scenario === 'followup-ar' ? 'ماذا عن المخاطر؟'
        : scenario === 'followup-tr' ? 'Peki proje riskleri?'
          : 'What about the project risks?';
      const result = await run.start({ inputData: { previousSelection: cohortQuestions[scenario] ? previousSelection : undefined, message: cohortQuestions[scenario] ?? (scenario.startsWith('followup') ? followupMessage : scenario === 'narrative' ? 'Compare project Budget and risks across reports' : scenario === 'aggregate-unique' ? 'Sum Orion item costs' : scenario === 'mixed-dependent' ? 'Top two employees in 2025 and the report risks for them' : scenario === 'mixed' ? 'Count violations in 2025 from violations.xlsx and independently describe report risks in safety.md' : scenario === 'aggregate-year' ? 'How many violations were recorded in 2025?' : scenario === 'custom-independent' ? 'What is the weather in Istanbul?' : scenario === 'custom-en' ? 'What is the EUR to JPY exchange rate?' : scenario === 'custom-ar' ? 'كم تبلغ درجة الحرارة في إسطنبول الآن؟' : scenario === 'custom-ambiguous' ? 'Tell me the current conditions outside.' : scenario === 'custom-irrelevant' ? 'What does the safety handbook say about evacuation?' : scenario === 'planner-invalid' ? 'Please handle this request.' : scenario === 'planner-repair' ? 'What is the weather in Oslo?' : 'Sum the Budget column'), history: followupHistory, userMemories: [], evidenceRefs: [], contextEntities: [], conversationSummary: '' } });
      if (scenario === 'planner-invalid') {
        assert.equal(result.status, 'failed');
        assert.equal(safeAgentFailure(result.error)?.code, 'INVALID_MODEL_OUTPUT');
        assert.equal(calls.length, 0);
        return;
      }
      assert.equal(result.status, 'success');
      if (result.status !== 'success') return;
      if (scenario === 'narrative') {
        assert.equal(result.result.timing.llmCalls, 5, 'this multi-document route performs three planning requests, one answer stream, and one citation verification request');
        assert.equal(typeof result.result.timing.llmLatencyMs, 'number');
        assert.equal(typeof result.result.timing.promptTokens, 'number');
        assert.equal(typeof result.result.timing.completionTokens, 'number');
      }
      if (scenario === 'same-source-chunks') {
        assert.equal(result.result.timing.llmCalls, 3, 'one planner request, one answer stream, and one citation verification request');
        assert.deepEqual(modelEvents, ['planner', 'model-delta-1', 'sse-delta-1', 'model-delta-2', 'sse-delta-2', 'citation-verifier']);
      }
      if (scenario === 'unknown-column') { assert.equal(result.result.outcome, 'clarification'); assert.deepEqual(calls, []); }
      else if (scenario === 'invalid-verifier-refusal') {
        assert.equal(result.result.outcome, 'failure');
        assert.match(result.result.answer, /verifiable document citations/i);
      }
      else if (scenario === 'irrelevant-evidence' || scenario === 'mislabelled-refusal') {
        assert.ok(calls.length > 0);
        assert.equal(result.result.outcome, 'empty');
        assert.equal(result.result.citationValidation, 'no-evidence');
        assert.deepEqual(result.result.sources, []);
        assert.ok(result.result.answer.length > 0);
      }
      else if (scenario === 'backend-mixed') {
        assert.match(result.result.answer, /42/);
        assert.ok(result.result.toolsCalled.includes('employee_count'));
        assert.ok(result.result.toolsCalled.includes('documentSearch'));
        assert.deepEqual(result.result.sources.map(source => source.filename), ['risks.md']);
      }
      else if (['custom-independent', 'custom-en', 'custom-ar'].includes(scenario)) {
        const expectedId = scenario === 'custom-en' ? dynamicCatalog[1]!.id : dynamicCatalog[0]!.id;
        assert.ok(result.result.toolsCalled.includes(expectedId));
        assert.deepEqual(calls, []);
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.deepEqual(diagnostic?.availableToolIds, dynamicCatalog.map(tool => tool.id));
        assert.equal(diagnostic?.selectedOperation, 'tool_call');
        assert.equal(diagnostic?.selectedToolId, expectedId);
        assert.equal(diagnostic?.schemaValidationOutcome, 'valid');
        assert.equal(diagnostic?.argumentSchemaValidationOutcome, 'valid');
        assert.ok(Number(diagnostic?.catalogEstimatedTokens) > 0);
      }
      else if (scenario === 'planner-repair') {
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.ok(result.result.toolsCalled.includes(dynamicCatalog[0]!.id));
        assert.equal(modelEvents.filter(event => event === 'planner').length, 2);
        assert.equal(diagnostic?.schemaValidationOutcome, 'valid');
        assert.deepEqual(diagnostic?.validationIssues, [{ attempt: 1, branch: 'tool_call', path: 'toolCall.id', code: 'invalid_format' }]);
      }
      else if (scenario === 'custom-ambiguous') { assert.equal(result.result.outcome, 'clarification'); assert.deepEqual(result.result.toolsCalled, []); assert.deepEqual(calls, []); }
      else if (scenario === 'custom-irrelevant') { assert.ok(calls.length > 0); assert.ok(result.result.toolsCalled.includes('documentSearch')); assert.equal(result.result.toolsCalled.some((id: string) => dynamicCatalog.some(tool => tool.id === id)), false); }
      else if (scenario === 'backend-denied' || scenario === 'backend-missing') {
        assert.equal(result.result.outcome, 'clarification');
        assert.deepEqual(result.result.toolsCalled, []);
        assert.deepEqual(calls, []);
      }
      else if (scenario === 'drawing-revisions') {
        assert.equal(result.result.sources.length, 2);
        assert.match(result.result.answer, /Unverified visual transcription/);
      }
      else if (scenario === 'drawing-missing-revision') {
        assert.equal(result.result.citationValidation, 'no-evidence');
        assert.deepEqual(result.result.sources, []);
      }
      else if (cohortQuestions[scenario]) { assert.match(result.result.answer, /11/); assert.deepEqual(calls, []); }
      else if (scenario === 'mixed-dependent') {
        assert.match(result.result.answer, /E1: 6/);
        assert.match(result.result.answer, /Supported fixture answer/);
        assert.deepEqual(calls, ['What risks are in the safety reports?\nComputed group labels (query scope only): ["E1","E2"]']);
      }
      else if (scenario === 'mixed') {
        assert.match(result.result.answer, /21/);
        assert.match(result.result.answer, /Supported fixture answer/);
        assert.deepEqual(calls, ['describe report risks in safety.md']);
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
