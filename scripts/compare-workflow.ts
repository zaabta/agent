import { mock } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { writeFile } from 'node:fs/promises';
const moduleName = process.env.WORKFLOW_COMPARISON_MODULE ?? '../src/agent/agent.workflow.js';
const { createAgentWorkflow } = await import(moduleName);
process.env.MASTRA_OBSERVABILITY = 'false';
const label = process.env.EVAL_LABEL ?? 'after';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid EVAL_LABEL');
const results = [];
for (const [kind, question] of [
  ['simple', 'What is the Orion budget?'],
  ['complex', 'Compare Orion costs and risks across documents'],
  ['followup', 'قارن بينهما'],
  ['followup', 'İkisini karşılaştır'],
  ['followup', 'Compare them'],
]) {
  let historySeen = false;
  const queries: string[] = [];
  const plan = { operation: 'retrieve', retrievalQuery: 'Orion budget', ...(kind !== 'simple' ? { standaloneQuestion: 'Compare Orion costs and risks', retrievalQueries: ['Orion costs', 'Orion risks'] } : {}) };
  const generate = mock.method(Agent.prototype, 'generate', async function(this: Agent, messages: any) {
    const prompt = messages[0].content;
    if (this.id.startsWith('sitepilot-planner')) { historySeen ||= prompt.includes('context-marker'); return { object: plan } as any; }
    const ids = [...prompt.matchAll(/(?:^|\n)(E\d+):/g)].map((m: any) => m[1]);
    return { object: { answer: 'Controlled fixture answer.', evidenceSufficient: true, evidenceIds: ids } } as any;
  });
  const stream = mock.method(Agent.prototype, 'stream', async () => ({ fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'Controlled fixture answer.' } }; })(), getFullOutput: async () => ({ text: 'Controlled fixture answer.' }) }) as any);
  const typegraph: any = { searchDocuments: async (query: string) => {
    queries.push(query);
    const id = query.includes('risks') ? 'risks' : 'costs';
    return { query, hits: [{ score: 0.8, content: `Orion ${id} facts.`, sourceRef: id, metadata: {}, citation: { documentId: id, filename: `${id}.txt`, bucketId: 'documents', chunkIndex: 0, chunkCount: 1 } }], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } };
  } };
  const started = performance.now();
  try {
    const workflow = createAgentWorkflow(typegraph, { discoverDatasets: async () => [] } as any, { userId: 'comparison-user', tenantId: 'comparison-workspace', role: 'MEMBER', authMethod: 'jwt' });
    const run = await workflow.createRun();
    const execution = await run.start({ inputData: { message: question, history: [{ role: 'user', content: 'context-marker: compare the Orion cost and risk documents' }] } });
    if (execution.status !== 'success') throw execution.error;
    results.push({ kind, question, historySeen, queries, latencyMs: Math.round(performance.now() - started), result: execution.result });
  } finally { generate.mock.restore(); stream.mock.restore(); }
}
await writeFile(`docs/audit/workflow-${label}.json`, JSON.stringify({ mode: 'controlled mocked-model execution; injected plans; no live inference or retrieval benchmark', results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(r => ({ kind: r.kind, historySeen: r.historySeen, llmCalls: r.result.timing.llmCalls, queries: r.queries.length, citedDocuments: r.result.sources.length }))));
