import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createAgentWorkflow } from '../src/agent/agent.workflow.js';

// Supplemental inference check, deliberately NOT an end-to-end RAG benchmark.
// Mastra and generation are real; retrieval is a fixed authorized evidence fixture.
if (process.env.RUN_LIVE_OLLAMA_FIXTURES !== 'true') throw new Error('Set RUN_LIVE_OLLAMA_FIXTURES=true with local Ollama configured');
if (process.env.MASTRA_PROVIDER !== 'ollama') throw new Error('This supplemental check requires local Ollama');
const facts = [
  ['requirements.md', 'Orion requires safety review. Proposed Orion budget is 150000 USD; this conflicts with the base cost estimate.'],
  ['costs.txt', 'Orion base budget is 120000 USD.'],
  ['risks.pdf', 'Orion main delivery risk is supplier delay.'],
  ['timeline.docx', 'Orion launch date is 2027-03-15.'],
];
const hits = facts.map(([filename, content], i) => ({ content, score: 0.9, sourceRef: `${filename} (fixture excerpt)`, metadata: {}, citation: { documentId: `fixture-${i}`, filename, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }));
const cases = [
  { id: 'synthesis-en', question: 'Compare Orion requirements, costs, risks and launch date across the documents.' },
  { id: 'synthesis-ar', question: 'قارن متطلبات وتكاليف ومخاطر وموعد إطلاق Orion عبر الملفات.' },
  { id: 'synthesis-tr', question: 'Belgeler arasında Orion gereksinim, maliyet, risk ve başlangıç tarihini karşılaştır.' },
  { id: 'followup-ar', question: 'وماذا عن مخاطره؟' },
  { id: 'missing-ar', question: 'ما اسم شركة التأمين لمشروع Orion؟' },
];
const results: any[] = [];
await mkdir('docs/audit', { recursive: true });
const path = 'docs/audit/quality-live-ollama-controlled-evidence.json';
const save = (complete: boolean) => writeFile(path, JSON.stringify({ mode: 'real local Ollama / real Mastra workflow / fixed retrieval fixture; NOT TypeGraph retrieval or HTTP/database E2E', model: process.env.MASTRA_MODEL, complete, totalCases: cases.length, humanReviewRequired: true, results }, null, 2) + '\n');
await save(false);
for (const item of cases) {
  const started = performance.now();
  const queries: string[] = [], deltas: Array<{ ms: number; text: string }> = [];
  const stages: any[] = [];
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('SUPPLEMENTAL_EVAL_TIMEOUT')), 240000);
  const result: any = { ...item, actualAnswer: null, pass: false };
  try {
    const workflow = createAgentWorkflow({ searchDocuments: async (query: string) => { queries.push(query); return { query, hits, timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } }; } } as any, { discoverDatasets: async () => [] } as any, { userId: 'fixture-user', tenantId: 'fixture-workspace', role: 'MEMBER', authMethod: 'jwt' }, controller.signal, {
      onTextDelta: async text => { deltas.push({ ms: Math.round(performance.now() - started), text }); },
      onProgress: async stage => { stages.push({ ...stage, ms: Math.round(performance.now() - started) }); },
    });
    const run = await workflow.createRun();
    const execution = await run.start({ inputData: { message: item.question, history: item.id === 'followup-ar' ? [{ role: 'user', content: cases[0]!.question }, { role: 'assistant', content: results[0]?.actualAnswer ?? 'Orion project [[requirements.md (fixture excerpt)]]' }] : [] } });
    assert.equal(execution.status, 'success');
    if (execution.status !== 'success') throw new Error('WORKFLOW_EXECUTION_FAILED');
    const output = execution.result;
    result.actualAnswer = output.answer;
    result.sources = output.sources;
    result.citationValidation = output.citationValidation;
    result.outcome = output.outcome;
    result.timing = output.timing;
    const cited = [...output.answer.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
    result.referenceIdentityValid = cited.every(ref => output.sources.some(s => s.sourceRef === ref));
    result.arabicPresent = /\p{Script=Arabic}/u.test(output.answer);
    if (item.id.startsWith('synthesis')) result.pass = output.citationValidation === 'valid' && result.referenceIdentityValid && facts.every(([filename]) => output.sources.some(s => s.filename === filename)) && /120[,. ]?000/.test(output.answer) && /2027-03-15|15.*2027/u.test(output.answer) && (!item.id.endsWith('ar') || result.arabicPresent);
    else if (item.id === 'followup-ar') result.pass = result.arabicPresent && output.citationValidation === 'valid' && output.sources.some(s => s.filename === 'risks.pdf') && /تأخ|تاخ|تأجيل|تأخر|تأخير/u.test(output.answer);
    else result.pass = result.arabicPresent && output.citationValidation === 'no-evidence' && output.sources.length === 0;
  } catch (error) { result.error = error instanceof Error ? error.message : 'Unknown error'; }
  finally { clearTimeout(deadline); }
  Object.assign(result, { latencyMs: Math.round(performance.now() - started), queries, firstTextMs: deltas[0]?.ms ?? null, deltaCount: deltas.length, provisionalText: deltas.map(d => d.text).join(''), stages });
  results.push(result); await save(false);
  console.log(JSON.stringify({ id: item.id, pass: result.pass, latencyMs: result.latencyMs, llmCalls: result.timing?.llmCalls ?? null }));
}
await save(true);
if (results.some(result => !result.pass)) process.exitCode = 1;
