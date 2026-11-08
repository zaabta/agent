import { readFile, writeFile, mkdir } from 'node:fs/promises';
const cases = JSON.parse(await readFile(new URL('../test/quality/cases.json', import.meta.url), 'utf8'));
const base = process.env.AGENT_E2E_URL;
const token = process.env.AGENT_E2E_BEARER;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const label = process.env.EVAL_LABEL ?? 'after';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid EVAL_LABEL');
const results = [];
for (const item of cases) {
  const started = performance.now();
  const record: any = { ...item, actualAnswer: null, retrievedDocuments: null, citationValidity: null, latencyMs: null, llmCalls: null, pass: null, status: 'skipped', reason: 'Requires isolated seeded API, database, index, Ollama and generation provider credentials' };
  if (base && token) {
    try {
      const ask = async (message: string, conversationId?: string) => {
        const response = await fetch(`${base}/api/agent/ask`, { method: 'POST', headers, body: JSON.stringify({ message, conversationId }), signal: AbortSignal.timeout(240000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json() as any;
      };
      let conversationId: string | undefined;
      for (const message of item.history) conversationId = (await ask(message, conversationId)).conversationId;
      const result = await ask(item.question, conversationId);
      const cited = [...result.answer.matchAll(/\[\[([^\]]+)\]\]/g)].map((m: any) => m[1]);
      const refs = new Set(result.sources.map((s: any) => s.sourceRef));
      const documents = [...new Set(result.sources.map((s: any) => s.filename))];
      const valid = result.citationValidation === 'valid' && cited.every((ref: string) => refs.has(ref)) && (!item.expectedSourceDocuments.length || cited.length > 0);
      const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[,.\s]/g, '');
      record.actualAnswer = result.answer;
      // The API exposes cited sources, not the complete raw retrieval set.
      record.retrievedDocuments = null;
      record.citedDocuments = documents;
      record.citationValidity = valid;
      record.llmCalls = result.timing?.llmCalls ?? null;
      record.pass = valid && item.expectedSourceDocuments.every((d: string) => documents.includes(d)) && item.expectedFacts.every((f: string) => normalize(result.answer).includes(normalize(f)));
      if (item.category === 'missing') record.pass = result.citationValidation === 'no-evidence' || (!result.sources.length && /insufficient|not.*evidence|could not find/i.test(result.answer));
      record.status = record.pass ? 'passed' : 'failed'; record.reason = null;
      record.latencyMs = Math.round(performance.now() - started);
    } catch (error) { record.status = 'failed'; record.pass = false; record.reason = error instanceof Error ? error.message : 'Unknown failure'; }
  }
  results.push(record);
}
await mkdir('docs/audit', { recursive: true });
await writeFile(`docs/audit/quality-${label}.json`, JSON.stringify({ mode: base && token ? 'live' : 'blocked', label, results }, null, 2) + '\n');
console.log(JSON.stringify({ total: results.length, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, skipped: results.filter(r => r.status === 'skipped').length }));
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
