import { z } from 'zod';
import { BackendTools } from '../src/agent/backend-tools.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { createAgentWorkflow } from '../src/agent/agent.workflow.js';
import { readLocalWorkflowDiagnostic } from '../src/mastra/observability.js';
import { safeAgentFailure } from '../src/agent/provider-errors.js';

function planResult(plan: any) {
  if (!plan || typeof plan.operation !== 'string') return { object: plan } as any;
  if (plan.requiredSources) return { object: plan } as any;
  const requiredSources = plan.operation === 'retrieve' ? ['documents']
    : ['aggregate', 'lookup', 'discover'].includes(plan.operation) ? ['structured_data']
      : plan.operation === 'list' ? ['document_catalog']
        : plan.operation === 'tool_call' ? ['registered_tool', ...(plan.documentQuestion ? ['documents'] : [])]
          : [];
  if (plan.operation === 'aggregate' && plan.documentQuestion) requiredSources.push('documents');
  return { object: { ...plan, requiredSources } } as any;
}

for (const scenario of ['narrative', 'citation-table-label', 'unknown-column', 'aggregate-unique', 'aggregate-year', 'mixed', 'mixed-dependent', 'mixed-no-doc-evidence', 'cohort-ar', 'cohort-tr', 'cohort-en', 'drawing-revisions', 'drawing-missing-revision', 'drawing-title-scale', 'citation-repair', 'citation-repair-invalid', 'citation-repair-call-failed', 'partial-paragraph-repair', 'useful-clarification', 'semantic-partial', 'backend-mixed', 'backend-denied', 'backend-missing', 'custom-independent', 'custom-en', 'custom-ar', 'custom-multiple', 'custom-mixed', 'custom-ambiguous', 'custom-irrelevant', 'planner-invalid', 'planner-repair', 'planner-unknown-id-repair', 'planner-unknown-id-unrepaired', 'planner-timeout', 'truncated-answer', 'continued-answer', 'continuation-failed', 'answer-missing-finish', 'answer-other-finish', 'answer-google-complete', 'evidence-requirement-pdf', 'evidence-requirement-docx', 'evidence-requirement-unrepaired', 'evidence-requirement-followup', 'followup', 'followup-ar', 'followup-tr', 'respond-history', 'same-source-chunks', 'irrelevant-evidence', 'mislabelled-refusal', 'invalid-verifier-refusal', 'semantic-unsupported', 'oversized-evidence'] as const) {
  test(`workflow routing recovery: ${scenario}`, { concurrency: false }, async () => {
    const previous = process.env.MASTRA_OBSERVABILITY;
    process.env.MASTRA_OBSERVABILITY = 'false';
    const calls: string[] = [];
    const modelEvents: string[] = [];
    const plannerOptions: any[] = [];
    const answerGenerationOptions: any[] = [];
    const providerEvents: any[] = [];
    const usageEvents: any[] = [];
    const textDeltas: string[] = [];
    const workflowDeltas: string[] = [];
    const resetReasons: string[] = [];
    const workflowDiagnostics: any[] = [];
    const continuationOptions: any[] = [];
    const customExecutions: any[] = [];
    const selectedModels: Array<{ role:string; model:any }> = [];
    let citationRepairPrompt = '';
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
    const dynamicScenarios = ['custom-independent', 'custom-en', 'custom-ar', 'custom-multiple', 'custom-mixed', 'custom-ambiguous', 'custom-irrelevant', 'planner-repair', 'planner-unknown-id-repair', 'planner-unknown-id-unrepaired'];
    const workflowTools = dynamicScenarios.includes(scenario) ? {
      catalog: async () => dynamicCatalog,
      execute: async (call: any, _principal: any, _signal: any, _onStart: any, context: any) => {
        customExecutions.push(call);
        context?.onSchemaValidation?.('valid');
        if (scenario === 'custom-independent' || scenario === 'custom-ar') assert.deepEqual(call, { id: dynamicCatalog[0]!.id, args: { city: 'Istanbul' } });
        if (scenario === 'custom-en') assert.deepEqual(call, { id: dynamicCatalog[1]!.id, args: { base: 'EUR', quote: 'JPY' } });
        if (scenario === 'custom-multiple') return call.id === dynamicCatalog[1]!.id ? { rate: 160.25 } : { temperatureC: 22, condition: 'clear' };
        return scenario === 'custom-en' ? { rate: 160.25 } : { temperatureC: 22, condition: 'clear' };
      },
    } as any : backendTools;
    const generate = mock.method(Agent.prototype, 'generate', async function(this: Agent, messages: any, options: any) {
      const prompt = messages[0].content;
      if (this.id.startsWith('sitepilot-planner')) {
        plannerOptions.push(options);
        selectedModels.push({role:'PLANNER',model:(this as any).model});
        modelEvents.push('planner');
        if (scenario === 'planner-timeout') throw Object.assign(new Error('private provider timeout'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
        if (scenario === 'evidence-requirement-pdf' || scenario === 'evidence-requirement-docx') {
          if (prompt.includes('Validation findings from the previous plan:')) return planResult({ operation: 'retrieve', requiredSources: ['documents'], retrievalQuery: scenario.endsWith('pdf') ? 'inspection interval and equipment checks' : 'handover and commissioning procedure' });
          return planResult({ operation: 'respond', requiredSources: ['documents'], reply: 'The document contents are unavailable.' });
        }
        if (scenario === 'evidence-requirement-unrepaired') return planResult({ operation: 'respond', requiredSources: ['documents'], reply: 'The requested document is unavailable.' });
        if (scenario === 'evidence-requirement-followup') return planResult({ operation: 'respond', requiredSources: [], reply: 'I can restate the earlier summary.' });
        if (scenario === 'drawing-title-scale') return planResult({ operation: 'retrieve', requiredSources: ['documents'], retrievalQuery: 'project title and drawing scale', retrievalQueries: ['architectural drawing structural details', 'drawing title block project name and scale ratio'] });
        if (scenario === 'citation-repair' || scenario === 'citation-repair-invalid' || scenario === 'citation-repair-call-failed') return planResult({ operation: 'retrieve', requiredSources: ['documents'], retrievalQuery: 'foundation types on the drawing' });
        if (prompt.startsWith('Decide whether')) return { object: scenario === 'narrative' ? { mode: 'retrieve', retrievalQueries: ['project budget', 'project risks'] } : { mode: 'structured' } } as any;
        if (cohortQuestions[scenario]) {
          if (!prompt.includes('Authorized schema:')) assert.match(prompt, /"values":\["E1","E2"\]/);
          return planResult({ operation: 'aggregate', aggregate: 'COUNT', usePreviousSelection: !prompt.includes('Authorized schema:') });
        }
        if (scenario === 'drawing-revisions' || scenario === 'drawing-missing-revision') return planResult({ operation: 'retrieve', compareDrawingRevisions: true, retrievalQueries: ['revision A', 'revision B'] });
        if (scenario.startsWith('backend-')) {
          if (scenario === 'backend-denied') assert.doesNotMatch(prompt, /Count registered employees/);
          else assert.match(prompt, /Count registered employees/);
          if (scenario === 'backend-denied') return planResult({ operation: 'clarify', reply: 'I cannot use that capability for this request.' });
          return planResult({ operation: 'tool_call', toolCall: { id: scenario === 'backend-missing' ? 'missing' : 'employee_count', args: { department: 'Safety' } }, documentQuestion: 'What risks are in the safety reports?' });
        }
        if (scenario === 'custom-independent' || scenario === 'custom-ar') {
          assert.match(prompt, /Return current weather for a city/);
          assert.match(prompt, /Return the latest exchange rate/);
          assert.match(prompt, /Return current outdoor air quality/);
          return planResult({ operation: 'tool_call', toolCall: { id: dynamicCatalog[0]!.id, args: { city: 'Istanbul' } } });
        }
        if (scenario === 'custom-en') {
          assert.match(prompt, /Return the latest exchange rate between two ISO currency codes/);
          assert.match(prompt, /"base":\s*\{\s*"type":"string"/);
          return planResult({ operation: 'tool_call', toolCall: { id: dynamicCatalog[1]!.id, args: { base: 'EUR', quote: 'JPY' } } });
        }
        if (scenario === 'custom-multiple') return planResult({ operation: 'tool_call', toolCalls: [
          { id: dynamicCatalog[0]!.id, args: { city: 'Istanbul' } },
          { id: dynamicCatalog[1]!.id, args: { base: 'EUR', quote: 'JPY' } },
        ] });
        if (scenario === 'custom-mixed') return planResult({ operation: 'tool_call', toolCall: { id: dynamicCatalog[0]!.id, args: { city: 'Istanbul' } }, documentQuestion: 'What are the project facts?' });
        if (scenario === 'custom-ambiguous') return planResult({ operation: 'clarify', reply: 'Do you mean weather or air quality?' });
        if (scenario === 'custom-irrelevant') return planResult({ operation: 'retrieve', retrievalQuery: 'evacuation instructions in the safety handbook' });
        if (scenario === 'planner-invalid') return { object: { operation: 'invalid_operation' } } as any;
        if (scenario === 'planner-repair') {
          if (prompt.includes('Validation findings from the previous plan:')) {
            assert.match(prompt, /toolCall/);
            assert.doesNotMatch(prompt, /invalid id/i);
            return planResult({ operation: 'tool_call', toolCall: { id: dynamicCatalog[0]!.id, args: { city: 'Oslo' } } });
          }
          return planResult({ operation: 'tool_call', toolCall: { id: 'invalid id', args: { city: 'Oslo' } } });
        }
        if (scenario === 'planner-unknown-id-repair' || scenario === 'planner-unknown-id-unrepaired') {
          if (prompt.includes('Validation findings from the previous plan:')) {
            assert.match(prompt, /unknown_tool_id/);
            return planResult({ operation: 'tool_call', toolCall: { id: scenario === 'planner-unknown-id-repair' ? dynamicCatalog[0]!.id : 'conflict_resolution', args: { city: 'Oslo' } } });
          }
          return planResult({ operation: 'tool_call', toolCall: { id: 'conflict_resolution', args: { city: 'Oslo' } } });
        }
        if (scenario === 'mixed-dependent') return planResult({ operation: 'aggregate', aggregate: 'GROUP_BY', columnName: 'Employee', groupLimit: 2, filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }], documentQuestion: 'What risks are in the safety reports?', searchRankedGroups: true });
        if (scenario === 'mixed-no-doc-evidence') return planResult({ operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }], documentQuestion: 'What additional constraints are described in the narrative report?' });
        if (scenario === 'mixed' && !prompt.includes('Authorized schema:')) return planResult({ operation: 'lookup', standaloneQuestion: 'Count violations from violations.xlsx' });
        if (scenario === 'mixed') assert.match(prompt, /describe report risks in safety\.md/i);
        if (scenario === 'mixed') return planResult({ operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }], documentQuestion: 'What risks are in the safety reports?' });
        if (scenario === 'aggregate-year') return planResult({ operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }] });
        if (scenario === 'aggregate-unique' && prompt.includes('Authorized schema:')) return planResult({ operation: 'aggregate', aggregate: 'COUNT', filters: [{ columnName: 'Project', operator: 'EQ', value: 'Orion' }] });
        if (scenario === 'oversized-evidence') return planResult({ operation: 'retrieve', retrievalQuery: 'large report' });
        if (scenario === 'citation-table-label' || ['truncated-answer', 'continued-answer', 'continuation-failed', 'answer-missing-finish', 'answer-other-finish', 'answer-google-complete'].includes(scenario)) return planResult({ operation: 'retrieve', retrievalQuery: 'footing schedule' });
        if (scenario === 'partial-paragraph-repair') return planResult({ operation: 'retrieve', retrievalQuery: 'plan recorded items' });
        if (scenario === 'useful-clarification') return planResult({ operation: 'retrieve', retrievalQuery: 'concrete cost inputs' });
        if (scenario === 'same-source-chunks' || scenario === 'semantic-partial' || scenario === 'irrelevant-evidence' || scenario === 'mislabelled-refusal' || scenario === 'invalid-verifier-refusal' || scenario === 'semantic-unsupported') return planResult({ operation: 'retrieve', retrievalQueries: ['first fact', 'second fact'] });
        if (scenario === 'respond-history') return planResult({ operation: 'respond', requiredSources: [], reply: 'Hello' });
        if (scenario.startsWith('followup')) {
          if (prompt.includes('Validation findings from the previous plan:')) return planResult({ operation: 'retrieve', requiredSources: ['documents'], retrievalQuery: 'project risks' });
          return planResult({ operation: 'respond', requiredSources: ['documents'], standaloneQuestion: 'What project risks are documented?', reply: 'How can I help?' });
        }
        return planResult({ operation: 'aggregate', aggregate: 'SUM', columnName: scenario === 'aggregate-unique' ? 'Cost' : 'Budget' });
      }
      selectedModels.push({role:'ANSWER',model:(this as any).model});
      if (prompt.includes('Uncited factual spans')) {
        if (scenario === 'citation-repair-call-failed') throw new Error('citation repair provider unavailable');
        citationRepairPrompt = prompt;
        return { object: { mappings: scenario === 'citation-repair-invalid' ? [{ spanIndex: 0, evidenceIds: [] }, { spanIndex: 1, evidenceIds: [] }]
          : scenario === 'useful-clarification' ? [{ spanIndex: 0, evidenceIds: [] }]
          : scenario === 'invalid-verifier-refusal'
          ? [{ spanIndex: 0, evidenceIds: [] }, { spanIndex: 1, evidenceIds: [] }]
          : scenario === 'partial-paragraph-repair'
            ? [{ spanIndex: 0, evidenceIds: ['E1'] }, { spanIndex: 1, evidenceIds: [] }]
          : [{ spanIndex: 0, evidenceIds: ['E1'] }], ...(scenario === 'useful-clarification' ? { missingInputs: ['total concrete quantity', 'unit price'] } : {}), ...(scenario === 'citation-repair-invalid' ? { qualifiedExplanation: 'The extracted table does not clearly associate each value with its row.' } : {}) } } as any;
      }
      if (prompt.startsWith('Assess whether each factual claim')) {
        const payload = JSON.parse(prompt.split('Claims and their cited evidence (JSON): ')[1]!);
        return { object: { assessments: payload.map((claim: any) => ({ claimId: claim.claimId, supported: scenario === 'semantic-partial' ? claim.claimId === 0 : scenario !== 'semantic-unsupported', evidenceIds: claim.evidence.map((item: any) => item.id), reason: scenario === 'semantic-partial' && claim.claimId === 1 ? 'Value is associated with a different source row.' : undefined })) }, finishReason: 'stop' } as any;
      }
      if (['custom-independent', 'custom-en', 'custom-ar', 'custom-multiple', 'custom-mixed'].includes(scenario)) answerGenerationOptions.push(options);
      if (scenario === 'respond-history') {
        assert.match(messages[0].content, /Previous relevant exchange/);
        return { text: 'Hello' } as any;
      }
      if (scenario.startsWith('followup') || scenario === 'evidence-requirement-followup') {
        assert.match(messages[0].content, /Conversation context/);
        return { text: 'The prior conversation contains the project information.' } as any;
      }
      if (dynamicScenarios.includes(scenario) && scenario !== 'custom-irrelevant') {
        if (scenario === 'custom-en') { assert.match(messages[0].content, /160.25/); return { object: { answer: 'The EUR to JPY rate is 160.25 [T1].' } } as any; }
        if (scenario === 'custom-multiple') { assert.match(messages[0].content, /temperatureC/); assert.match(messages[0].content, /160.25/); return { object: { answer: 'The weather is clear at 22 C [T1]. The rate is 160.25 [T2].' } } as any; }
        assert.match(messages[0].content, /temperatureC/);
        return { object: { answer: scenario === 'custom-ar' ? 'درجة الحرارة في إسطنبول 22 مئوية [T1].' : 'Istanbul is 22 C [T1].' } } as any;
      }
      return { object: { answer: 'unused' } } as any;
    });
    const stream = mock.method(Agent.prototype, 'stream', async function(this: Agent, messages: any, options: any) {
      if (scenario === 'citation-repair-call-failed') {
        const answer = 'Supported fixture answer [E1]. The drawing records an unsupported revision date.';
        return ({ fullStream: (async function* () { yield { type: 'text-delta', payload: { text: answer } }; yield { type: 'step-finish', payload: { output: { usage: { inputTokens: 10, outputTokens: 8 }, response: { modelId: 'fixture' } }, stepResult: { reason: 'stop' } } }; })(), getFullOutput: async () => ({ text: answer }) }) as any;
      }
      if (scenario === 'citation-repair') {
        assert.match(messages[0].content, /Allowed document labels: E1/);
        const answer = '# Foundation types\nThe drawing lists these types:\n\n- R.C.C. FOOTING [E1]\n- P.C.C. [E1]\n\nThese foundation labels appear in the drawing.';
        return ({ fullStream: (async function* () {
          yield { type: 'text-delta', payload: { text: answer } };
          yield { type: 'step-finish', payload: { output: { usage: { inputTokens: 10, outputTokens: 25 }, response: { modelId: 'fixture' } }, stepResult: { reason: 'stop' } } };
        })(), getFullOutput: async () => ({ text: answer }) }) as any;
      }
      if (scenario === 'citation-repair-invalid') {
        const answer = '| Footing | Size | Citation |\n| --- | --- | --- |\n| F1 | 2800 x 2800 | |\n\nThe extracted table does not clearly associate each value with its row.';
        return ({ fullStream: (async function* () { yield { type: 'text-delta', payload: { text: answer } }; yield { type: 'step-finish', payload: { output: { usage: { inputTokens: 10, outputTokens: 15 }, response: { modelId: 'fixture' } }, stepResult: { reason: 'stop' } } }; })(), getFullOutput: async () => ({ text: answer }) }) as any;
      }
      if (scenario === 'useful-clarification') {
        const answer = 'A reliable calculation needs the total concrete quantity and unit price.';
        return ({ fullStream: (async function* () { yield { type: 'text-delta', payload: { text: answer } }; yield { type: 'step-finish', payload: { output: { usage: { inputTokens: 10, outputTokens: 12 }, response: { modelId: 'fixture' } }, stepResult: { reason: 'stop' } } }; })(), getFullOutput: async () => ({ text: answer }) }) as any;
      }
      if (['truncated-answer', 'continued-answer', 'continuation-failed', 'answer-missing-finish', 'answer-other-finish', 'answer-google-complete'].includes(scenario)) {
        selectedModels.push({ role: 'ANSWER', model: (this as any).model });
        assert.equal(options.structuredOutput, undefined);
        assert.match(messages[0].content, /Authorized document evidence/);
        continuationOptions.push(options);
        if (scenario === 'continuation-failed' && continuationOptions.length === 2) throw new Error('continuation unavailable');
        const isContinuation = continuationOptions.length === 2;
        const answer = isContinuation ? ' | CF4 [E1]' : 'Footing schedule | CF3 [E1]';
        if (['continued-answer', 'truncated-answer', 'continuation-failed'].includes(scenario)) assert.equal(options.modelSettings.maxOutputTokens, 512, 'continuation retains the configured per-call budget');
        const finishReason = ['answer-missing-finish'].includes(scenario) ? undefined : ['answer-other-finish'].includes(scenario) ? 'other' : (scenario === 'truncated-answer' || scenario === 'continued-answer' || scenario === 'continuation-failed') && !isContinuation ? 'length' : 'stop';
        if (scenario === 'continued-answer' && isContinuation) assert.equal(options.providerOptions.google.continuationToken, 'fixture-continuation-token');
        if (scenario === 'continuation-failed' && isContinuation) assert.fail('failed continuation must throw before stream creation');
        return ({ fullStream: (async function* () {
          yield { type: 'text-delta', payload: { text: answer } };
          if (finishReason) yield { type: 'step-finish', payload: { output: { usage: { inputTokens: isContinuation ? 15 : 80, outputTokens: isContinuation ? 12 : 512 }, response: { modelId: scenario === 'truncated-answer' ? 'qwen3:8b' : 'gemini-test' }, ...(finishReason === 'length' ? { providerMetadata: { google: { continuationToken: 'fixture-continuation-token' } } } : {}) }, stepResult: { reason: finishReason } } };
        })(), getFullOutput: async () => ({ text: answer }) }) as any;
      }
      if (scenario === 'custom-mixed') {
        assert.match(messages[0].content, /Authorized registered-tool evidence/);
        assert.match(messages[0].content, /temperatureC/);
      } else assert.match(messages[0].content, /Allowed document labels: E1/);
      const labels = [...messages[0].content.matchAll(/(?:^|\n)(E\d+) \|/g)].map((match: any) => match[1]);
      const refusal = scenario === 'irrelevant-evidence' ? 'I could not find enough evidence in the available documents.'
        : scenario === 'mislabelled-refusal' ? 'The requested company is not mentioned in the available documents.' : undefined;
      const answer = scenario === 'custom-mixed'
        ? 'Istanbul is 22 C [T1]. Supported fixture answer [E1]'
        : scenario === 'drawing-title-scale'
        ? `The project is North Annex Renovation and the drawing scale is 1:100 [${labels[0] ?? 'E1'}]`
        : scenario === 'backend-mixed'
        ? 'Registered employees: 42 [T1]. Supported fixture answer [E1]'
        : scenario === 'citation-table-label'
        ? '| Footing ID | Dimensions | Citation |\n| --- | --- | --- |\n| F-10 | 3500 x 3500 | E1 |'
        : scenario === 'partial-paragraph-repair'
        ? 'The plan records 17 items. The unrelated note is not supported by the retrieved excerpt.'
        : scenario === 'semantic-partial'
        ? 'Recorded amount is 17 [E1]. The unrelated amount is 99 [E2].'
        : refusal ?? (scenario === 'invalid-verifier-refusal' ? 'Sa\u011flanan metinlerden istenen bilgiyi do\u011frulayam\u0131yorum; tahmin etmeyece\u011fim.' : `Supported fixture answer ${labels.map((id: string) => `[${id}]`).join(' ')}`);
      if (scenario === 'same-source-chunks') { assert.ok(messages[0].content.includes('First fact 17')); assert.ok(messages[0].content.includes('Second fact 29')); }
      const fullStream = async function* () {
        if (scenario === 'same-source-chunks') {
        modelEvents.push('model-delta-1'); yield { type: 'text-delta', payload: { text: 'Supported ' } };
        modelEvents.push('model-delta-2'); yield { type: 'text-delta', payload: { text: answer.slice('Supported '.length) } };
        } else yield { type: 'text-delta', payload: { text: answer } };
        yield { type: 'step-finish', payload: { output: { usage: { inputTokens: 10, outputTokens: 5 }, response: { modelId: 'fixture' } }, stepResult: { reason: 'stop' } } };
      };
      return ({ fullStream: fullStream(), getFullOutput: async () => ({ text: answer }) }) as any; });
    const typegraph: any = { listDocuments: async () => ({ documents: [], durationMs: 0 }), searchDocuments: async (query: string) => {
      calls.push(query);
      if (scenario === 'mixed-no-doc-evidence') return { query, hits: [], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      if (scenario === 'drawing-title-scale') {
        const hits = query.includes('title block') ? [{ score: 0.8, content: 'Project name: North Annex Renovation. Scale: 1:100.', sourceRef: 'Campus-A2-07.drawing.pdf (page 1)', metadata: {}, citation: { documentId: 'campus-a2-07', filename: 'Campus-A2-07.drawing.pdf', bucketId: 'documents', chunkIndex: 0, chunkCount: 1, pageNumber: 1 } }] : [];
        return { query, hits, timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      }
      if (scenario === 'citation-repair-invalid') return { query, hits: [{ score: 0.8, content: 'Extracted table: row association unclear.', sourceRef: 'schedule.pdf (page 1)', metadata: { chunkerVersion: 'smart-2' }, citation: { documentId: 'schedule', filename: 'schedule.pdf', bucketId: 'documents', chunkIndex: 0, chunkCount: 1, pageNumber: 1, chunkerVersion: 'smart-2' } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      if (scenario === 'useful-clarification') return { query, hits: [{ score: 0.8, content: 'Concrete schedule with M25 specification.', sourceRef: 'cost-plan.pdf (page 2)', metadata: {}, citation: { documentId: 'cost-plan', filename: 'cost-plan.pdf', bucketId: 'documents', chunkIndex: 0, chunkCount: 1, pageNumber: 2 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      if (scenario === 'semantic-partial') {
        const first = query.startsWith('first');
        const content = first ? 'Recorded amount is 17.' : 'Different source row has amount 98.';
        return { query, hits: [{ score: 0.8, content, sourceRef: `table.pdf (page 1, chunk ${first ? 1 : 2})`, metadata: {}, citation: { documentId: 'table', filename: 'table.pdf', bucketId: 'documents', chunkIndex: first ? 0 : 1, chunkCount: 2, pageNumber: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      }
      if (scenario === 'evidence-requirement-pdf' || scenario === 'evidence-requirement-docx') {
        const isPdf = scenario.endsWith('pdf');
        const filename = isPdf ? 'inspection-record.pdf' : 'handover-guide.docx';
        return { query, hits: [{ score: 0.8, content: 'Inspection information from the uploaded document.', sourceRef: `${filename} (page 2)`, metadata: {}, citation: { documentId: filename, filename, bucketId: 'documents', chunkIndex: 0, chunkCount: 1, pageNumber: 2 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      }
      if (scenario === 'drawing-revisions' || scenario === 'drawing-missing-revision') {
        const name = query.endsWith('B') && scenario === 'drawing-revisions' ? 'B' : 'A';
        return { query, hits: [{ score: 0.8, content: 'Unverified dimension', sourceRef: `${name}.drawing.pdf (page 1)`, metadata: {}, citation: { documentId: name, filename: `${name}.drawing.pdf`, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      }
      if (scenario === 'same-source-chunks') { const first = query.startsWith('first'); return { query, hits: [{ score: 0.8, content: first ? 'First fact 17' : 'Second fact 29', sourceRef: 'shared.pdf (page 1)', metadata: {}, citation: { documentId: 'shared', filename: 'shared.pdf', bucketId: 'documents', chunkIndex: first ? 0 : 1, chunkCount: 2 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } }; }
      if (scenario === 'oversized-evidence') return { query, hits: [{ score: 0.8, content: 'x'.repeat(101), sourceRef: 'large.pdf (page 1)', metadata: {}, citation: { documentId: 'large', filename: 'large.pdf', bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
      const id = scenario === 'citation-repair' ? 'foundation-plan' : scenario === 'partial-paragraph-repair' ? 'partial-plan' : query.includes('budget') ? 'budget' : 'risks';
      const content = scenario === 'citation-repair' ? 'Foundation types labeled R.C.C. FOOTING, P.C.C., and PEDESTAL.'
        : scenario === 'partial-paragraph-repair' ? 'The plan records 17 items.'
        : scenario === 'citation-table-label' ? 'Footing F-10 is 3500 x 3500.'
        : ['truncated-answer', 'continued-answer', 'continuation-failed', 'answer-missing-finish', 'answer-other-finish', 'answer-google-complete'].includes(scenario) ? 'Footing schedule items CF3 and CF4.'
          : `Project ${id} facts`;
      return { query, hits: [{ score: 0.7, content, sourceRef: id, metadata: {}, citation: { documentId: id, filename: `${id}.md`, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
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
        if (scenario === 'aggregate-year' || scenario === 'mixed' || scenario === 'mixed-no-doc-evidence') {
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
      const runtime = ['custom-independent', 'planner-repair', 'planner-invalid', 'planner-unknown-id-repair', 'planner-unknown-id-unrepaired', 'planner-timeout', 'oversized-evidence', 'truncated-answer', 'continued-answer', 'continuation-failed', 'answer-missing-finish', 'answer-other-finish', 'answer-google-complete'].includes(scenario) ? {
        planner: { provider: scenario === 'planner-invalid' ? 'google' : 'ollama', model: 'planner-model', ollamaThink: false },
        answer: { provider: ['custom-independent', 'continued-answer', 'continuation-failed', 'answer-missing-finish', 'answer-other-finish', 'answer-google-complete'].includes(scenario) ? 'google' : 'ollama', model: scenario === 'truncated-answer' ? 'qwen3:8b' : 'answer-model', ollamaThink: false, ...(scenario === 'oversized-evidence' ? { maxContextChars: 100, maxOutputTokens: 128 } : {}), ...(['truncated-answer', 'continued-answer', 'continuation-failed'].includes(scenario) ? { maxOutputTokens: 512 } : {}) },
      } : undefined;
      let textResetCount = 0;
      const workflow = createAgentWorkflow(typegraph, structured, { userId: 'user', tenantId: 'tenant', authMethod: 'jwt' }, undefined, {
        onTextDelta: async text => { workflowDeltas.push(text); if (['truncated-answer', 'continued-answer', 'continuation-failed'].includes(scenario)) textDeltas.push(text); if (scenario === 'same-source-chunks') modelEvents.push(text === 'Supported ' ? 'sse-delta-1' : 'sse-delta-2'); },
        onTextReset: async reason => { textResetCount++; resetReasons.push(reason); },
        onDiagnostic: async diagnostic => { workflowDiagnostics.push(diagnostic); },
        onProviderTelemetry: async telemetry => { providerEvents.push(telemetry); },
      }, workflowTools, runtime as any, async record => { usageEvents.push(record); });
      const run = await workflow.createRun();
      const followupHistory = scenario === 'respond-history'
        ? [{ role: 'user' as const, content: 'Previous relevant exchange' }]
        : scenario === 'followup-tr'
        ? [
            { role: 'user' as const, content: 'Summarize the Orion project' },
            { role: 'assistant' as const, content: 'The project has documented risks. [[project.md (line 1)]]' },
            { role: 'user' as const, content: 'ماذا عن التكاليف؟' },
            { role: 'assistant' as const, content: 'التكاليف مذكورة في المستند. [[project.md (page 2)]]' },
          ]
        : scenario.startsWith('followup') || scenario === 'evidence-requirement-followup'
          ? [{ role: 'user' as const, content: 'Describe the project' }, { role: 'assistant' as const, content: 'Project evidence [[project.md (line 1)]]' }]
          : [];
      const followupMessage = scenario === 'followup-ar' ? 'ماذا عن المخاطر؟'
        : scenario === 'followup-tr' ? 'Peki proje riskleri?'
          : 'What about the project risks?';
      const scenarioMessages: Record<string, string> = {
        narrative: 'Compare project Budget and risks across reports', 'aggregate-unique': 'Sum Orion item costs',
        'citation-table-label': 'Show the footing schedule as a table',
        'evidence-requirement-pdf': 'According to the uploaded inspection PDF, how frequently should the equipment be checked?',
        'evidence-requirement-docx': 'Summarize the handover steps in the attached Word document.',
        'evidence-requirement-unrepaired': 'What does the uploaded project memo say about next steps?',
        'evidence-requirement-followup': 'Can you rephrase the summary from our previous turn?',
        'drawing-title-scale': 'Çizimdeki proje adını ve ölçek bilgisini bulabilir misin?',
        'citation-repair-invalid': 'Compare the values in the extracted table.',
        'citation-repair-call-failed': 'What revision date is recorded in the drawing?',
        'useful-clarification': 'Calculate the concrete cost from the uploaded file.',
        'semantic-partial': 'Compare the two recorded amounts.',
        'citation-repair': 'List the foundation types named in the drawing.',
        'mixed-no-doc-evidence': 'Count the 2025 records and include any narrative constraints from the report.',
        'mixed-dependent': 'Top two employees in 2025 and the report risks for them',
        mixed: 'Count violations in 2025 from violations.xlsx and independently describe report risks in safety.md',
        'aggregate-year': 'How many violations were recorded in 2025?',
        'custom-independent': 'What is the weather in Istanbul?', 'custom-en': 'What is the EUR to JPY exchange rate?',
        'custom-ar': 'كم تبلغ درجة الحرارة في إسطنبول الآن؟', 'custom-multiple': 'Give me the current weather and EUR to JPY rate.',
        'custom-mixed': 'What is the weather and what project facts do the documents report?', 'custom-ambiguous': 'Tell me the current conditions outside.',
        'custom-irrelevant': 'What does the safety handbook say about evacuation?', 'planner-invalid': 'Please handle this request.',
        'oversized-evidence': 'Summarize the large report', 'truncated-answer': 'Show the footing schedule as a table',
        'continued-answer': 'Show the footing schedule as a table', 'continuation-failed': 'Show the footing schedule as a table',
        'answer-missing-finish': 'Show the footing schedule as a table', 'answer-other-finish': 'Show the footing schedule as a table',
        'answer-google-complete': 'Show the footing schedule as a table', 'planner-repair': 'What is the weather in Oslo?',
        'invalid-verifier-refusal': 'F\u00f6l\u00e7ek nedir? L\u00fctfen belgeden do\u011frula.',
        'planner-unknown-id-repair': 'What is the weather in Oslo?', 'planner-unknown-id-unrepaired': 'What is the weather in Oslo?',
        'planner-timeout': 'What is the weather in Oslo?',
      };
      const message = cohortQuestions[scenario] ?? (scenario.startsWith('followup') ? followupMessage : scenarioMessages[scenario] ?? 'Sum the Budget column');
      const result = await run.start({ inputData: { previousSelection: cohortQuestions[scenario] ? previousSelection : undefined, message, history: followupHistory, userMemories: [], evidenceRefs: [], contextEntities: [], conversationSummary: '' } });
      if (scenario === 'truncated-answer') {
        assert.equal(result.status, 'failed');
        assert.equal(safeAgentFailure(result.error)?.code, 'OUTPUT_TRUNCATED');
        assert.equal(selectedModels.filter(item => item.role === 'ANSWER').length, 1);
        assert.deepEqual(providerEvents, [], 'output truncation is not a provider transport error');
        assert.deepEqual(textDeltas, ['Footing schedule | CF3 [E1]']);
        const answerUsage = usageEvents.find(item => item.outputTokens === 512);
        assert.ok(answerUsage, 'provider-reported output tokens are recorded on failure');
        assert.equal(answerUsage.status, 'failed');
        assert.equal(answerUsage.errorCategory, 'OUTPUT_TRUNCATED');
        const diagnostic = readLocalWorkflowDiagnostic(String(workflow.id).replace(/^sitepilot-answer-/, '').replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.equal(diagnostic?.stage, 'answer-generation');
        assert.equal(diagnostic?.finishReason, 'length');
        assert.equal(diagnostic?.provider, 'ollama');
        assert.equal(diagnostic?.model, 'qwen3:8b');
        assert.equal(diagnostic?.inputTokens, 80);
        assert.equal(diagnostic?.outputTokens, 512);
        assert.equal(diagnostic?.maxOutputTokens, 512);
        assert.equal(typeof diagnostic?.generationMs, 'number');
        return;
      }
      if (['continued-answer', 'continuation-failed', 'answer-missing-finish', 'answer-other-finish'].includes(scenario)) {
        if (scenario === 'continued-answer') {
          assert.equal(result.status, 'success');
          assert.equal(result.result.outcome, 'success', JSON.stringify({ answer: result.result.answer, tools: result.result.toolsCalled, diagnostic: readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') }));
          assert.match(result.result.answer, /CF3 \[\[risks\]\]/);
          assert.match(result.result.answer, /CF4 \[\[risks\]\]/);
          assert.equal(continuationOptions.length, 2);
          assert.deepEqual(textDeltas, ['Footing schedule | CF3 [E1]', ' | CF4 [E1]']);
          assert.equal(usageEvents.filter(item => item.finishReason === 'length').length, 1);
          assert.equal(usageEvents.filter(item => item.finishReason === 'stop').length, 1);
        } else {
          if (scenario === 'continuation-failed') {
            assert.equal(result.status, 'success');
            assert.equal(result.result.outcome, 'failure', 'transport failure after continuation is not task success or token exhaustion');
            const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
            assert.equal(diagnostic?.errorType, 'Error');
            assert.equal(result.result.citationValidation, 'fallback');
          } else {
            assert.equal(result.status, 'failed');
            assert.equal(safeAgentFailure(result.error)?.code, 'CONNECTION_FAILED');
          }
        }
        assert.equal(providerEvents.length, 0, 'incomplete output and malformed completion metadata are not provider transport failures');
        return;
      }
      if (scenario === 'answer-google-complete') {
        assert.equal(result.status, 'success');
        assert.equal(result.result.outcome, 'success');
        assert.equal(result.result.citationValidation, 'valid');
        assert.equal(continuationOptions.length, 1);
        return;
      }
      if (scenario === 'planner-invalid') {
        assert.equal(result.status, 'failed');
        assert.equal(safeAgentFailure(result.error)?.code, 'INVALID_MODEL_OUTPUT');
        assert.equal(plannerOptions.length, 2);
        assert.ok(plannerOptions.every(option => option.structuredOutput?.schema && option.structuredOutput.errorStrategy === 'strict'));
        assert.equal(plannerOptions[0].providerOptions.google.structuredOutputs, false);
        assert.equal(calls.length, 0);
        return;
      }
      if (scenario === 'planner-unknown-id-unrepaired' || scenario === 'planner-timeout') {
        assert.equal(result.status, 'failed');
        assert.equal(safeAgentFailure(result.error)?.code, scenario === 'planner-timeout' ? 'TIMEOUT' : 'INVALID_MODEL_OUTPUT');
        assert.deepEqual(customExecutions, []);
        if (scenario === 'planner-timeout') {
          assert.equal(plannerOptions.length, 1);
          assert.equal(providerEvents.length, 1);
          assert.equal(providerEvents[0].code, 'TIMEOUT');
          assert.equal(providerEvents[0].providerRetries, 0);
        } else assert.equal(plannerOptions.length, 2);
        return;
      }
      if (scenario === 'evidence-requirement-unrepaired') {
        assert.equal(result.status, 'failed');
        assert.equal(safeAgentFailure(result.error)?.code, 'INVALID_MODEL_OUTPUT');
        assert.deepEqual(calls, [], 'an unresolved source mismatch cannot fall through to answer generation or retrieval');
        return;
      }
      if (scenario === 'backend-missing') {
        assert.equal(result.status, 'failed');
        assert.equal(safeAgentFailure((result as any).error)?.code, 'INVALID_MODEL_OUTPUT');
        assert.deepEqual((result as any).result?.toolsCalled ?? [], []);
        assert.deepEqual(calls, []);
        return;
      }
      assert.equal(result.status, 'success', result.status === 'failed' ? JSON.stringify(readLocalWorkflowDiagnostic(String(workflow.id).replace(/^sitepilot-answer-/, '').replace(/-/g, ''), 'tenant')) : undefined);
      if (result.status !== 'success') return;
      if (scenario === 'oversized-evidence') {
        assert.equal(result.result.outcome, 'clarification');
        assert.match(result.result.answer, /too large to verify safely/);
        assert.equal(modelEvents.length, 1, 'only the planner runs when retrieved evidence exceeds the cap');
        return;
      }
      if (scenario === 'citation-table-label') {
        assert.equal(result.result.outcome, 'success', JSON.stringify(readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant')));
        assert.equal(result.result.citationValidation, 'valid');
        assert.match(result.result.answer, /F-10/);
        assert.match(result.result.answer, /\[\[risks\]\]/);
        assert.equal(result.result.sources.length, 1);
      }
      if (scenario === 'narrative') {
        assert.equal(result.result.timing.llmCalls, 5, 'this multi-document route performs three planning requests, an answer stream, and evidence verification');
        assert.equal(typeof result.result.timing.llmLatencyMs, 'number');
        assert.equal(typeof result.result.timing.promptTokens, 'number');
        assert.equal(typeof result.result.timing.completionTokens, 'number');
        assert.match(result.result.answer, /\[\[budget\]\]/);
        assert.match(result.result.answer, /\[\[risks\]\]/);
      }
      if (scenario === 'custom-independent') { assert.equal((selectedModels.find(item=>item.role==='PLANNER')?.model as any).modelId,'planner-model');assert.equal(selectedModels.find(item=>item.role==='ANSWER')?.model,'google/answer-model'); }
      if (scenario === 'same-source-chunks') {
        assert.equal(result.result.timing.llmCalls, 3, 'one planner request, one answer stream, and one evidence verification');
        assert.deepEqual(modelEvents, ['planner', 'model-delta-1', 'sse-delta-1', 'model-delta-2', 'sse-delta-2']);
      }
      if (scenario === 'respond-history') { assert.equal(result.result.outcome, 'success'); assert.equal(result.result.answer, 'Hello'); assert.deepEqual(result.result.toolsCalled, []); assert.equal(result.result.verificationStatus, 'not_required'); }
      else if (scenario.startsWith('followup')) {
        assert.equal(result.result.outcome, 'success');
        assert.ok(result.result.toolsCalled.includes('documentSearch'));
        assert.ok(calls.length > 0);
        assert.equal(result.result.verificationStatus, 'verified');
        assert.equal(result.result.sources.length, 1);
      }
      else if (scenario === 'evidence-requirement-pdf' || scenario === 'evidence-requirement-docx') {
        assert.equal(plannerOptions.length, 2, 'an incompatible respond plan is repaired before answer generation');
        assert.equal(result.result.outcome, 'success');
        assert.equal(result.result.executionStatus, 'completed');
        assert.equal(result.result.verificationStatus, 'verified');
        assert.ok(result.result.toolsCalled.includes('documentSearch'));
        assert.equal(result.result.sources[0]?.filename, scenario.endsWith('pdf') ? 'inspection-record.pdf' : 'handover-guide.docx');
        assert.deepEqual(calls, [scenario.endsWith('pdf') ? 'inspection interval and equipment checks' : 'handover and commissioning procedure']);
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.equal(diagnostic?.initialOperation, 'respond', 'diagnostics preserve the original Planner selection');
        assert.equal(diagnostic?.selectedOperation, 'retrieve', 'diagnostics record the repaired executable operation');
        assert.deepEqual(diagnostic?.requiredSources, ['documents']);
      }
      else if (scenario === 'evidence-requirement-followup') {
        assert.equal(result.result.outcome, 'success');
        assert.equal(result.result.verificationStatus, 'not_required');
        assert.deepEqual(result.result.toolsCalled, []);
        assert.deepEqual(calls, [], 'conversation-only follow-ups do not trigger document searches');
      }
      else if (scenario === 'mixed-no-doc-evidence') {
        assert.equal(result.result.executionStatus, 'completed');
        assert.equal(result.result.outcome, 'empty', 'a generated no-evidence response is not task success');
        assert.equal(result.result.citationValidation, 'no-evidence');
        assert.equal(result.result.verificationStatus, 'unverified');
        assert.ok(result.result.toolsCalled.includes('documentSearch'));
        assert.deepEqual(result.result.sources.map((source: any) => source.filename), ['violations.xlsx'], 'structured result provenance remains attached while the document requirement is explicitly unsatisfied');
      }
      else if (scenario === 'unknown-column') { assert.equal(result.result.outcome, 'clarification'); assert.deepEqual(calls, []); }
      else if (scenario === 'invalid-verifier-refusal') {
        assert.equal(result.result.outcome, 'empty', JSON.stringify({ result: result.result, diagnostic: readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant'), citationRepairPrompt }));
        assert.equal(result.result.citationValidation, 'no-evidence');
        assert.equal(result.result.verificationStatus, 'unverified');
        assert.match(result.result.answer, /\u0130stenen bilgi/u);
        assert.deepEqual(result.result.sources, []);
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.equal(diagnostic?.groundingReasonCodes, undefined);
        assert.equal(diagnostic?.finalizationReasonCodes, undefined);
      }
      else if (scenario === 'semantic-unsupported') {
        assert.equal(result.result.outcome, 'failure');
        assert.equal(result.result.verificationStatus, 'unverified');
        assert.equal(result.result.citationValidation, 'fallback');
        assert.deepEqual(result.result.sources, []);
        assert.match(result.result.answer, /every factual claim is supported/i);
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.equal(diagnostic?.finalizationReasonCodes, undefined, 'a verified refusal must not be overwritten as a missing-citation failure');
        assert.deepEqual(diagnostic?.rejectedClaimIds, [0], 'semantic verification identifies rejected claim spans without storing claim text');
        assert.equal(diagnostic?.claimFindings?.[0]?.kind, 'paragraph');
        assert.match(diagnostic?.claimFindings?.[0]?.claimExcerpt ?? '', /Supported fixture answer/);
        assert.deepEqual(diagnostic?.claimFindings?.[0]?.evidenceIds, ['E1']);
        assert.ok(diagnostic?.claimFindings?.[0]?.evidenceLocations?.[0]?.evidenceExcerpt);
        assert.equal(diagnostic?.claimFindings?.[0]?.failureClass, 'semantic_verifier');
      }
      else if (scenario === 'useful-clarification') {
        assert.equal(result.result.outcome, 'clarification');
        assert.equal(result.result.verificationStatus, 'unverified');
        assert.equal(result.result.citationValidation, 'no-evidence');
        assert.match(result.result.answer, /total concrete quantity.*unit price/i);
        assert.doesNotMatch(result.result.answer, /could not verify|could not find matching evidence/i);
      }
      else if (scenario === 'citation-repair-invalid') {
        assert.equal(result.result.outcome, 'clarification');
        assert.equal(result.result.verificationStatus, 'unverified');
        assert.equal(result.result.citationValidation, 'no-evidence');
        assert.match(result.result.answer, /could not verify the table-row associations/i);
        assert.match(result.result.answer, /does not clearly associate each value/i);
        assert.doesNotMatch(result.result.answer, /\| Footing \||2800/);
        const diagnostic = workflowDiagnostics.find(item => item.stage === 'citation-repair-complete');
        assert.equal(diagnostic?.repaired, false);
        assert.ok(diagnostic?.remainingIssues.includes('missing_evidence_labels'));
        assert.ok(workflowDiagnostics.some(item => item.stage === 'retrieval-complete' && item.indexVersions.includes('smart-2')));
        assert.ok(resetReasons.includes('citation-repair'));
        assert.doesNotMatch(workflowDeltas.at(-1) ?? '', /\| Footing \||2800/);
      }
      else if (scenario === 'citation-repair-call-failed') {
        assert.equal(result.result.outcome, 'success');
        assert.equal(result.result.verificationStatus, 'verified');
        assert.equal(result.result.citationValidation, 'valid');
        assert.match(result.result.answer, /Supported fixture answer/);
        assert.doesNotMatch(result.result.answer, /unsupported revision date/);
        const diagnostic = workflowDiagnostics.find(item => item.stage === 'citation-repair-complete');
        assert.equal(diagnostic?.repaired, false);
        assert.ok(diagnostic?.remainingIssues.includes('citation_repair_execution_failed'));
        assert.equal(diagnostic?.disposition, 'uncited_claims_removed');
        assert.equal(result.result.timing.citationVerificationMs > 0, true);
      }
      else if (scenario === 'semantic-partial') {
        assert.equal(result.result.outcome, 'success');
        assert.equal(result.result.verificationStatus, 'verified');
        assert.match(result.result.answer, /17/);
        assert.doesNotMatch(result.result.answer, /99/);
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.deepEqual(diagnostic?.removedClaimIds, [1]);
        assert.deepEqual(diagnostic?.claimFindings?.find((finding: any) => finding.claimId === 1)?.reasonCodes, ['numeric_value_not_in_source']);
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
        assert.equal(answerGenerationOptions.length, 1);
        assert.ok(answerGenerationOptions[0].structuredOutput?.schema.safeParse({ answer: 'valid' }).success);
        assert.equal(answerGenerationOptions[0].structuredOutput.errorStrategy, 'strict');
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
      else if (scenario === 'custom-multiple') {
        assert.equal(customExecutions.length, 2);
        assert.deepEqual(result.result.toolsCalled, [dynamicCatalog[0]!.id, dynamicCatalog[1]!.id]);
        assert.match(result.result.answer, /22 C/);
        assert.match(result.result.answer, /160\.25/);
        assert.deepEqual(result.result.sources, []);
        assert.deepEqual(calls, []);
      }
      else if (scenario === 'custom-mixed') {
        assert.ok(result.result.toolsCalled.includes(dynamicCatalog[0]!.id));
        assert.ok(result.result.toolsCalled.includes('documentSearch'));
        assert.match(result.result.answer, /Istanbul is 22 C/);
        assert.match(result.result.answer, /Supported fixture answer/);
        assert.deepEqual(result.result.sources.map((source: any) => source.filename), ['risks.md']);
        assert.deepEqual(calls, ['What are the project facts?']);
      }
      else if (scenario === 'planner-repair') {
        assert.equal(plannerOptions.length, 2);
        assert.ok(plannerOptions.every(option => option.structuredOutput?.schema && option.structuredOutput.errorStrategy === 'strict'));
        assert.ok(plannerOptions.every(option => option.providerOptions?.google === undefined));
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.ok(result.result.toolsCalled.includes(dynamicCatalog[0]!.id));
        assert.equal(modelEvents.filter(event => event === 'planner').length, 2);
        assert.equal(diagnostic?.schemaValidationOutcome, 'valid');
        assert.deepEqual(diagnostic?.validationIssues, [{ attempt: 1, branch: 'tool_call', path: 'toolCall.id', code: 'invalid_format' }]);
      }
      else if (scenario === 'planner-unknown-id-repair') {
        assert.equal(plannerOptions.length, 2);
        assert.ok(result.result.toolsCalled.includes(dynamicCatalog[0]!.id));
        assert.deepEqual(customExecutions, [{ id: dynamicCatalog[0]!.id, args: { city: 'Oslo' } }]);
        const diagnostic = readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant') as Record<string, any> | undefined;
        assert.equal(diagnostic?.selectedToolId, dynamicCatalog[0]!.id);
        assert.deepEqual(diagnostic?.validationIssues, [{ attempt: 1, branch: 'tool_call', path: 'toolCall.id', code: 'unknown_tool_id' }]);
      }
      else if (scenario === 'custom-ambiguous') { assert.equal(result.result.outcome, 'clarification'); assert.deepEqual(result.result.toolsCalled, []); assert.deepEqual(calls, []); }
      else if (scenario === 'custom-irrelevant') { assert.ok(calls.length > 0); assert.ok(result.result.toolsCalled.includes('documentSearch')); assert.equal(result.result.toolsCalled.some((id: string) => dynamicCatalog.some(tool => tool.id === id)), false); }
      else if (scenario === 'backend-denied') {
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
      else if (scenario === 'drawing-title-scale') {
        assert.match(result.result.answer, /North Annex Renovation/);
        assert.match(result.result.answer, /1:100/);
        assert.deepEqual(calls, ['architectural drawing structural details', 'drawing title block project name and scale ratio']);
        assert.equal(result.result.sources[0]?.filename, 'Campus-A2-07.drawing.pdf');
      }
      else if (scenario === 'citation-repair') {
        assert.equal(result.result.outcome, 'success', JSON.stringify({ result: result.result, diagnostic: readLocalWorkflowDiagnostic(result.result.requestId.replace(/-/g, ''), 'tenant'), citationRepairPrompt }));
        assert.equal(result.result.citationValidation, 'valid');
        assert.match(citationRepairPrompt, /Validation findings:.*uncited_factual_paragraph/s);
        assert.match(citationRepairPrompt, /spanIndex.*These foundation labels appear in the drawing\./s);
        assert.match(citationRepairPrompt, /Preserve all existing facts and their current references/);
        assert.match(result.result.answer, /R\.C\.C\. FOOTING/);
        assert.match(result.result.answer, /P\.C\.C\.\s+\[\[foundation-plan\]\]/);
        assert.match(result.result.answer, /These foundation labels appear in the drawing\.\s+\[\[foundation-plan\]\]/);
        assert.equal(textResetCount, 1, 'the uncited provisional draft is discarded before the citation repair is shown');
      }
      else if (scenario === 'partial-paragraph-repair') {
        assert.equal(result.result.outcome, 'success');
        assert.equal(result.result.citationValidation, 'valid');
        assert.match(result.result.answer, /The plan records 17 items\.\s+\[\[partial-plan\]\]/);
        assert.doesNotMatch(result.result.answer, /unrelated note/);
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
        assert.deepEqual(calls, ['What risks are in the safety reports?']);
        assert.deepEqual(result.result.sources.map(source => source.filename).sort(), ['risks.md', 'violations.xlsx']);
      }
      else if (scenario === 'aggregate-year') { assert.match(result.result.answer, /21/); assert.deepEqual(calls, []); }
      else if (scenario === 'aggregate-unique') { assert.match(result.result.answer, /300/); assert.deepEqual(calls, []); }
      else { assert.ok(calls.length > 0); assert.ok(result.result.toolsCalled.includes('documentSearch')); assert.equal(result.result.citationValidation, 'valid'); if (scenario === 'narrative') assert.equal(result.result.sources.length, 2); if (scenario === 'same-source-chunks') assert.equal(result.result.sources.length, 2); }
    } finally {
      generate.mock.restore(); stream.mock.restore();
      if (previous === undefined) delete process.env.MASTRA_OBSERVABILITY; else process.env.MASTRA_OBSERVABILITY = previous;
    }
  });
}
