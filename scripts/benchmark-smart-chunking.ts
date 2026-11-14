import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseDocument } from '../src/documents/parser.js';
import { estimateTokens, smartChunk, smartChunkSettings } from '../src/documents/smart-chunker.js';

const rows = Math.max(1000, Number(process.env.BENCHMARK_ROWS || 25000));
const marker = `SITEPILOT-BENCH-${randomUUID()}`;
const headers = ['Account ID', 'Form Number', 'Branch', 'Period', 'Description', 'Debit', 'Credit', 'Currency', 'Owner', 'Reference'];
const tempDir = await mkdtemp(join(tmpdir(), 'sitepilot-smart-chunk-benchmark-'));
const filename = join(tempDir, `${marker}.csv`);
let peakRss = process.memoryUsage().rss;
const sampleMemory = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
const cpuStart = process.cpuUsage();
const wallStart = performance.now();

try {
  const output = [headers.join(',')];
  for (let index = 1; index <= rows; index++) {
    const account = String(100000 + index).padStart(8, '0');
    const form = `${index % 2 ? 'AP' : 'AR'}-${String(index).padStart(7, '0')}`;
    output.push([account, form, `IST-${index % 30 + 1}`, `2026-${String(index % 12 + 1).padStart(2, '0')}`, `Benchmark row ${index} ${marker}`, (index * 17.25).toFixed(2), (index * 3.5).toFixed(2), 'TRY', `User ${index % 200}`, `REF-${marker}-${index}`].map(value => `"${value.replaceAll('"', '""')}"`).join(','));
  }
  await writeFile(filename, output.join('\n'));
  const buffer = await readFile(filename);
  const parseStart = performance.now();
  const parsed = await parseDocument(filename, buffer);
  const parsingMs = Math.round(performance.now() - parseStart);
  const chunkStart = performance.now();
  const chunks = smartChunk(parsed.text, parsed.extension, { documentId: 'benchmark', documentVersionId: 'benchmark-v1', originalFilename: filename.split('/').at(-1) }, parsed.structuredCells);
  const chunkingMs = Math.round(performance.now() - chunkStart);
  const index = process.env.AGENT_E2E_BEARER ? await ingestThroughApi(filename, marker) : null;
  const cpu = process.cpuUsage(cpuStart);
  peakRss = Math.max(peakRss, process.resourceUsage().maxRSS * 1024);
  console.log(JSON.stringify({
    fixture: 'synthetic 10-column accounting CSV', rows,
    sourceBytes: buffer.length,
    parsingMs,
    chunkingMs,
    chunkCount: chunks.length,
    averageRowsPerChunk: Number((chunks.reduce((total, chunk) => total + (chunk.rowStart && chunk.rowEnd ? chunk.rowEnd - chunk.rowStart + 1 : 0), 0) / Math.max(1, chunks.length)).toFixed(2)),
    maxRowsPerChunk: Math.max(...chunks.map(chunk => chunk.rowStart && chunk.rowEnd ? chunk.rowEnd - chunk.rowStart + 1 : 0)),
    maxEstimatedChunkTokens: Math.max(...chunks.map(chunk => estimateTokens(chunk.content))),
    chunkSettings: smartChunkSettings,
    peakRssBytes: peakRss,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    localWallMs: Math.round(performance.now() - wallStart),
    indexingAndRetrieval: index,
    note: index ? undefined : 'Set AGENT_E2E_BEARER and API_BASE_URL to measure Ollama embedding, TypeGraph indexing, and retrieval quality.',
  }, null, 2));
} finally {
  clearInterval(sampleMemory);
  await rm(tempDir, { recursive: true, force: true });
}

async function ingestThroughApi(path: string, sentinel: string) {
  const baseUrl = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3220}`;
  const form = new FormData();
  const bytes = await readFile(path);
  form.append('file', new Blob([bytes], { type: 'text/csv' }), path.split('/').at(-1)!);
  const startedAt = performance.now();
  const authorization = { authorization: `Bearer ${process.env.AGENT_E2E_BEARER!}` };
  const upload = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', headers: authorization, body: form });
  if (!upload.ok) throw new Error(`Benchmark upload failed (${upload.status}): ${await upload.text()}`);
  const accepted = await upload.json() as { version: { jobId: string }; document: { id: string } };
  let job: { status: string; progressDetails?: { stages?: Array<{ stage: string; elapsedMs: number; embeddingDurationMs?: number | null }> } } | undefined;
  for (let attempt = 0; attempt < 1800; attempt++) {
    const response = await fetch(`${baseUrl}/api/jobs/${accepted.version.jobId}`, { headers: authorization });
    if (!response.ok) throw new Error(`Benchmark job read failed (${response.status})`);
    job = await response.json() as typeof job;
    if (['ready', 'failed', 'cancelled'].includes(job!.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (job?.status !== 'ready') throw new Error(`Benchmark indexing ended in ${job?.status || 'timeout'}`);
  const events = job.progressDetails?.stages || [];
  const searchStart = performance.now();
  const search = await fetch(`${baseUrl}/api/documents/search`, {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ query: `exact reference ${sentinel} REF`, limit: 8 }),
  });
  if (!search.ok) throw new Error(`Benchmark retrieval failed (${search.status})`);
  const result = await search.json() as { hits?: Array<{ content: string; citation: { documentId: string } }> };
  const matching = result.hits?.filter(hit => hit.citation.documentId === accepted.document.id && hit.content.includes(sentinel)) || [];
  return {
    documentId: accepted.document.id,
    totalIndexingWallMs: Math.round(performance.now() - startedAt),
    embeddingMs: events.reduce((total, event) => total + (event.embeddingDurationMs || 0), 0),
    indexingStageMs: events.filter(event => ['smart_chunking', 'preparing', 'checking', 'embedding', 'persisting', 'pruning', 'committing'].includes(event.stage)).reduce((total, event) => total + event.elapsedMs, 0),
    retrievalMs: Math.round(performance.now() - searchStart),
    retrievalQuality: { exactSentinelHit: matching.length > 0, matchingHits: matching.length },
    sourceChecksum: createHash('sha256').update(await readFile(path)).digest('hex'),
  };
}
