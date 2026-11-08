import { qualityDocuments } from '../test/fixtures/quality-documents.js';
// Explicit opt-in prevents accidental uploads into an existing company workspace.
if (process.env.CONFIRM_ISOLATED_QUALITY_WORKSPACE !== 'true') throw new Error('Set CONFIRM_ISOLATED_QUALITY_WORKSPACE=true only for the disposable audit workspace');
const base = process.env.AGENT_E2E_URL, token = process.env.AGENT_E2E_BEARER;
if (!base || !token) throw new Error('Set AGENT_E2E_URL and AGENT_E2E_BEARER');
for (const document of await qualityDocuments()) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(document.buffer)]), document.filename);
  const response = await fetch(`${base}/api/documents/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`Upload ${document.filename}: HTTP ${response.status}`);
  const jobId = result.document?.jobId;
  if (!jobId) throw new Error(`No job ID for ${document.filename}`);
  const deadline = Date.now() + 300000;
  let ready = false;
  while (Date.now() < deadline) {
    const jobResponse = await fetch(`${base}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${token}` } });
    if (!jobResponse.ok) throw new Error(`Job HTTP ${jobResponse.status}`);
    const job = await jobResponse.json() as any;
    if (job.status === 'ready') { ready = true; break; }
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(`Job ${jobId}: ${job.status}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`Indexing timeout: ${document.filename}`);
  console.log(JSON.stringify({ filename: document.filename, documentId: result.document.id, jobId, status: 'ready' }));
}
// Existing ingestion E2Es also cover persisted progress events, versioning and retries.
