import { qualityDocuments } from '../test/fixtures/quality-documents.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { auditSession } from '../test/helpers/audit-session.js';
// Explicit opt-in prevents accidental uploads into an existing company workspace.
if (process.env.CONFIRM_ISOLATED_QUALITY_WORKSPACE !== 'true') throw new Error('Set CONFIRM_ISOLATED_QUALITY_WORKSPACE=true only for the disposable audit workspace');
const base = process.env.AGENT_E2E_URL, token = process.env.AGENT_E2E_BEARER;
if (!base || !token) throw new Error('Set AGENT_E2E_URL and AGENT_E2E_BEARER');
const request = auditSession(base, token, process.env.AGENT_E2E_REFRESH_COOKIE);
const label = process.env.EVAL_LABEL ?? 'seed';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid EVAL_LABEL');
const uploads: any[] = [];
await mkdir('docs/audit', { recursive: true });
for (const document of await qualityDocuments()) {
  const started = performance.now();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(document.buffer)]), document.filename);
  const response = await request('/api/documents/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`Upload ${document.filename}: HTTP ${response.status}`);
  const jobId = result.document?.jobId;
  if (!jobId) throw new Error(`No job ID for ${document.filename}`);
  const deadline = Date.now() + 300000;
  let ready = false;
  let finalJob: any;
  while (Date.now() < deadline) {
    const jobResponse = await request(`/api/jobs/${jobId}`, { signal: AbortSignal.timeout(30000) });
    if (!jobResponse.ok) throw new Error(`Job HTTP ${jobResponse.status}`);
    const job = await jobResponse.json() as any;
    finalJob = job;
    if (job.status === 'ready') { ready = true; break; }
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(`Job ${jobId}: ${job.status}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`Indexing timeout: ${document.filename}`);
  uploads.push({ filename: document.filename, documentId: result.document.id, jobId, duplicate: result.duplicate, status: 'ready', durationMs: Math.round(performance.now() - started), progress: finalJob.progressDetails ?? null });
  await writeFile(`docs/audit/uploads-${label}.json`, JSON.stringify({ complete: uploads.length === 6, uploads }, null, 2) + '\n');
  console.log(JSON.stringify({ filename: document.filename, documentId: result.document.id, jobId, status: 'ready' }));
}
// Existing ingestion E2Es also cover persisted progress events, versioning and retries.
