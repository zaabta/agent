import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { qualityDocuments } from '../test/fixtures/quality-documents.js';

// Uses existing services and a real authenticated session. No mock providers,
// account provisioning, deletes, or production deployment are performed here.
if (process.env.CONFIRM_ISOLATED_E2E !== 'true') throw new Error('Set CONFIRM_ISOLATED_E2E=true only for a disposable audit workspace');
const base = process.env.AGENT_E2E_URL;
const bearer = process.env.AGENT_E2E_BEARER;
if (!base || !bearer) throw new Error('Set AGENT_E2E_URL and AGENT_E2E_BEARER');
const label = process.env.EVAL_LABEL ?? 'live-audit';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid EVAL_LABEL');
const output = `docs/audit/${label}.json`;
const report: { uploads: any[]; questions: any[]; stream?: any; error?: string; complete: boolean } = { uploads: [], questions: [], complete: false };
const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
await mkdir('docs/audit', { recursive: true });
async function save() { await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
async function api(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(300_000) });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${path}: ${value.code ?? value.message ?? 'request failed'}`);
  return value;
}
try {
  for (const fixture of await qualityDocuments()) {
    const started = performance.now();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(fixture.buffer)], { type: 'application/octet-stream' }), fixture.filename);
    const response = await fetch(`${base}/api/documents/upload`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: form, signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 202);
    const uploaded = await response.json() as any;
    const deadline = Date.now() + 300_000;
    let job: any;
    do {
      job = await api(`/api/jobs/${uploaded.document.jobId}`);
      if (['ready', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    report.uploads.push({ filename: fixture.filename, duplicate: uploaded.duplicate, documentId: uploaded.document.id, jobId: uploaded.document.jobId, status: job.status, progress: job.progressDetails, durationMs: Math.round(performance.now() - started) });
    await save(); assert.equal(job.status, 'ready');
    console.log(JSON.stringify({ filename: fixture.filename, status: job.status, duplicate: uploaded.duplicate }));
  }
  let conversationId: string | undefined;
  for (const question of [
    'What is the Orion base budget?',
    'Compare Orion requirements, costs, risks and timeline across the documents.',
    'وماذا عن المخاطر؟',
    'What is the warning for Form No 4 in Orion?',
    'What is the sum of Orion item costs?',
  ]) {
    const started = performance.now();
    const result = await api('/api/agent/ask', { message: question, ...(conversationId ? { conversationId } : {}) });
    conversationId = result.conversationId;
    report.questions.push({ question, ...result, durationMs: Math.round(performance.now() - started) });
    await save();
    console.log(JSON.stringify({ question, outcome: result.outcome, citationValidation: result.citationValidation }));
  }
  const started = performance.now();
  const response = await fetch(`${base}/api/agent/stream`, { method: 'POST', headers, body: JSON.stringify({ message: 'متى إطلاق مشروع Orion؟' }), signal: AbortSignal.timeout(300_000) });
  assert.equal(response.status, 200); assert.ok(response.body);
  let pending = '', firstTextMs: number | null = null;
  const frames: Array<{ name: string; data: any }> = [];
  for await (const bytes of response.body) {
    pending += Buffer.from(bytes).toString();
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      const name = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
      if (!name || !data) continue;
      frames.push({ name, data: JSON.parse(data) });
      if (name === 'text-delta' && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
    }
  }
  const done = frames.find(frame => frame.name === 'done')?.data;
  const persisted = done ? await api(`/api/agent/conversations/${done.conversationId}`) : null;
  report.stream = { events: frames.map(frame => frame.name), firstTextMs, durationMs: Math.round(performance.now() - started), done, persistedMatches: Boolean(done && done.answer === persisted?.messages?.at(-1)?.content), terminalCount: frames.filter(frame => ['done', 'error', 'cancelled'].includes(frame.name)).length };
  await save(); assert.ok(done); assert.equal(report.stream.terminalCount, 1); assert.equal(report.stream.persistedMatches, true);
  report.complete = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally { await save(); }
