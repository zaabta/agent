import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { auditSession } from '../test/helpers/audit-session.js';
const cases = JSON.parse(await readFile(new URL('../test/quality/cases.json', import.meta.url), 'utf8'));
const base = process.env.AGENT_E2E_URL;
const token = process.env.AGENT_E2E_BEARER;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const request = base && token ? auditSession(base, token, process.env.AGENT_E2E_REFRESH_COOKIE) : undefined;
const label = process.env.EVAL_LABEL ?? 'after';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid EVAL_LABEL');
let previousResults: any[] = [];
if (process.env.EVAL_RESUME === 'true' && base && token) {
  try { previousResults = JSON.parse(await readFile(`docs/audit/quality-${label}.json`, 'utf8')).results ?? []; } catch {}
}
const results: any[] = [];
await mkdir('docs/audit', { recursive: true });
if (base && token) await writeFile(`docs/audit/quality-${label}.json`, JSON.stringify({ mode: 'live', label, complete: false, totalCases: cases.length, results: previousResults }, null, 2) + '\n');
for (const item of cases) {
  const previous = previousResults.find(record => record.id === item.id);
  if (previous?.actualAnswer !== null && previous?.actualAnswer !== undefined) { results.push(previous); continue; }
  const started = performance.now();
  const record: any = { ...item, actualAnswer: null, retrievedDocuments: null, citationValidity: null, latencyMs: null, llmCalls: null, pass: null, status: 'skipped', reason: 'Requires isolated seeded API, database, index, Ollama and generation provider credentials' };
  if (previous) record.attempts = [...(previous.attempts ?? []), { status: previous.status, reason: previous.reason, latencyMs: previous.latencyMs }];
  if (base && token) {
    try {
      const ask = async (message: string, conversationId?: string) => {
        const response = await request!('/api/agent/ask', { method: 'POST', headers, body: JSON.stringify({ message, conversationId }), signal: AbortSignal.timeout(240000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json() as any;
      };
      let conversationId: string | undefined;
      for (const message of item.history) conversationId = (await ask(message, conversationId)).conversationId;
      const result = await ask(item.question, conversationId);
      const cited = [...result.answer.matchAll(/\[\[([^\]]+)\]\]/g)].map((m: any) => m[1]);
      const refs = new Set(result.sources.map((s: any) => s.sourceRef));
      const documents = [...new Set(result.sources.map((s: any) => s.filename))];
      const validNoEvidence = item.category === 'missing' && result.citationValidation === 'no-evidence' && cited.length === 0 && refs.size === 0;
      const valid = validNoEvidence || result.citationValidation === 'valid' && cited.every((ref: string) => refs.has(ref)) && (!item.expectedSourceDocuments.length || cited.length > 0);
      const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/\p{M}/gu, '').replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[,.\s]/g, '');
      const factAlternatives: Record<string, string[]> = {
        'safety review': ['safety review', 'مراجعة السلامة', 'مراجعة للسلامة', 'فحص السلامة', 'تقييم السلامة', 'güvenlik incelemesi', 'güvenlik değerlendirmesi', 'güvenlik kontrolü'],
        'supplier delay': ['supplier delay', 'تأخر المورد', 'تأخير المورد', 'تأخر الموردين', 'تأخير الموردين', 'tedarikçi gecikmesi', 'tedarikçi gecikmeleri', 'tedarik gecikmesi'],
        '2027-03-15': ['2027-03-15', '15 مارس 2027', '15 آذار 2027', '15 Mart 2027', '15.03.2027', '15/03/2027'],
      };
      record.actualAnswer = result.answer;
      record.conversationId = result.conversationId;
      record.toolsCalled = result.toolsCalled ?? [];
      // The API exposes cited sources, not the complete raw retrieval set.
      record.retrievedDocuments = null;
      record.citedDocuments = documents;
      record.citationValidity = valid;
      record.llmCalls = result.timing?.llmCalls ?? null;
      record.timing = result.timing ?? null;
      record.inputTokens = result.timing?.promptTokens ?? null;
      record.outputTokens = result.timing?.completionTokens ?? null;
      record.languageCheck = item.language === 'ar' ? /\p{Script=Arabic}/u.test(result.answer) : 'human-review';
      record.pass = valid && item.expectedSourceDocuments.every((d: string) => documents.includes(d)) && item.expectedFacts.every((f: string) => (factAlternatives[f] ?? [f]).some(variant => normalize(result.answer).includes(normalize(variant))));
      record.checks = {
        facts: item.expectedFacts.map((fact: string) => ({ fact, found: (factAlternatives[fact] ?? [fact]).some(variant => normalize(result.answer).includes(normalize(variant))) })),
        sources: item.expectedSourceDocuments.map((document: string) => ({ document, cited: documents.includes(document) })),
        requiredTool: !item.expectedAnyTools?.length || item.expectedAnyTools.some((name: string) => result.toolsCalled?.includes(name)),
      };
      if (item.expectedAnyTools?.length && !item.expectedAnyTools.some((name: string) => result.toolsCalled?.includes(name))) record.pass = false;
      if (item.category === 'missing') record.pass = result.citationValidation === 'no-evidence' || (!result.sources.length && /insufficient|not.*evidence|could not find/i.test(result.answer));
      if (record.languageCheck === false) record.pass = false;
      record.status = record.pass ? 'passed' : 'failed'; record.reason = null;
      record.latencyMs = Math.round(performance.now() - started);
    } catch (error) { record.status = 'failed'; record.pass = false; record.reason = error instanceof Error ? error.message : 'Unknown failure'; record.latencyMs = Math.round(performance.now() - started); }
  }
  results.push(record);
  if (base && token) {
    const completedIds = new Set(results.map(record => record.id));
    const checkpoint = [...results, ...previousResults.filter(record => !completedIds.has(record.id))];
    await writeFile(`docs/audit/quality-${label}.json`, JSON.stringify({ mode: 'live', label, complete: false, totalCases: cases.length, results: checkpoint }, null, 2) + '\n');
    console.log(JSON.stringify({ case: item.id, status: record.status, latencyMs: record.latencyMs, llmCalls: record.llmCalls }));
  }
}
await mkdir('docs/audit', { recursive: true });
await writeFile(`docs/audit/quality-${label}.json`, JSON.stringify({ mode: base && token ? 'live' : 'blocked', label, complete: true, totalCases: cases.length, results }, null, 2) + '\n');
console.log(JSON.stringify({ total: results.length, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, skipped: results.filter(r => r.status === 'skipped').length }));
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
