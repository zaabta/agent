import 'dotenv/config';
import { createHash } from 'node:crypto';
import { chmod, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AgentId, typegraphInit } from '@typegraph-ai/sdk';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { config } from '../src/config.js';
import { EmbeddingsService } from '../src/typegraph/embeddings.service.js';
import { typegraphConfig } from '../src/typegraph/typegraph.config.js';
import { redisConnection } from '../src/documents/redis-connection.js';

type Candidate = {
  documentId: string;
  tenantId: string;
  documentChecksum: string | null;
  documentFilename: string;
  documentStatus: string;
  documentStage: string;
  documentProgress: number | null;
  documentCompletedAt: Date | null;
  documentJobId: string | null;
  documentActiveVersionId: string | null;
  documentCancelled: boolean;
  documentDeleteRequested: boolean;
  versions: Array<{
    id: string;
    documentId: string;
    tenantId: string;
    versionNumber: number;
    filename: string;
    checksum: string | null;
    status: string;
    jobId: string | null;
    chunkingStrategy: string | null;
    indexGeneration: number;
    activeIndexGeneration: number | null;
  }>;
  progressEvents: Array<{ jobId: string; stage: string; status: string }>;
};

type IndexedDocument = { id: string; name: string; metadata: Record<string, unknown> };
type Report = {
  documentIdHash: string;
  tenantHash: string;
  versionIdHash?: string;
  indexedIdHash?: string;
  eligible: boolean;
  category: 'eligible' | 'skipped' | 'rejected';
  reasons: string[];
};

const hash = (value: string | null | undefined) => value
  ? createHash('sha256').update(value).digest('hex').slice(0, 12)
  : undefined;
const apply = process.argv.includes('--apply');
const tenantHashArg = process.argv.find((arg, index) => process.argv[index - 1] === '--tenant-hash');
const backupArg = process.argv.find((arg, index) => process.argv[index - 1] === '--backup');

function assertLocalDevelopmentDatabase() {
  if (process.env.NODE_ENV === 'production') throw new Error('REFUSING_PRODUCTION_ENVIRONMENT');
  const url = new URL(config.databaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  if (url.pathname !== '/sitepilot') throw new Error('REFUSING_UNEXPECTED_DATABASE_NAME');
  if (!url.searchParams.has('schema') && url.pathname !== '/sitepilot') throw new Error('REFUSING_UNEXPECTED_DATABASE_SCHEMA');
  return url;
}

async function listAll(client: Awaited<ReturnType<typeof typegraphInit>>): Promise<IndexedDocument[]> {
  const documents: IndexedDocument[] = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const page = await client.document.list({ bucketId: 'documents' }, { context: { agentId: AgentId('sitepilot-legacy-backfill-preflight') } }, { limit: pageSize, offset });
    const items = Array.isArray(page) ? page : page.items;
    documents.push(...items);
    if (items.length < pageSize || (Array.isArray(page))) break;
    offset += items.length;
  }
  return documents;
}

async function getQueueStates(jobIds: string[]) {
  const states = new Map<string, string>();
  if (!jobIds.length) return states;
  const connection = redisConnection(config.redisUrl);
  const queue = new Queue(config.documentQueue, { connection });
  try {
    for (const jobId of [...new Set(jobIds)]) {
      const job = await queue.getJob(jobId);
      states.set(jobId, job ? await job.getState() : 'missing');
    }
    return states;
  } finally {
    await queue.close();
  }
}

function inspectCandidate(document: Candidate, index: IndexedDocument[], queueState: string | undefined): Report {
  const reasons: string[] = [];
  const isCandidate = document.documentStatus === 'ready' && !document.documentActiveVersionId
    && index.some(item => item.id === document.documentId || item.metadata.documentId === document.documentId || item.id.split('::')[0] === document.documentId);
  const version = document.versions.find(item => item.versionNumber === 1);
  const logicalEntries = index.filter(item => item.id === document.documentId || item.metadata.documentId === document.documentId || item.id.split('::')[0] === document.documentId);
  const legacyEntry = index.find(item => item.id === document.documentId);

  if (!isCandidate) {
    return {
      documentIdHash: hash(document.documentId)!, tenantHash: hash(document.tenantId)!,
      ...(version ? { versionIdHash: hash(version.id) } : {}),
      eligible: false, category: 'skipped', reasons: [document.documentActiveVersionId ? 'ACTIVE_POINTER_ALREADY_SET' : 'NO_READY_LEGACY_INDEX_ENTRY'],
    };
  }

  if (document.documentStatus !== 'ready') reasons.push('DOCUMENT_NOT_READY');
  if (document.documentStage !== 'completed' || document.documentProgress !== 100 || !document.documentCompletedAt) reasons.push('INGESTION_NOT_COMPLETED');
  if (document.documentCancelled || document.documentDeleteRequested) reasons.push('CANCELLED_OR_DELETE_REQUESTED');
  if (!document.documentChecksum || !document.documentJobId) reasons.push('DOCUMENT_CHECKSUM_OR_JOB_MISSING');
  if (document.versions.length !== 1) reasons.push('VERSION_HISTORY_NOT_UNAMBIGUOUS');
  if (!version || version.versionNumber !== 1) reasons.push('VERSION_ONE_MISSING');
  if (version && version.tenantId !== document.tenantId) reasons.push('VERSION_TENANT_MISMATCH');
  if (version && version.documentId !== document.documentId) reasons.push('VERSION_DOCUMENT_ID_MISMATCH');
  if (version && version.filename !== document.documentFilename) reasons.push('VERSION_FILENAME_MISMATCH');
  if (version && version.checksum !== document.documentChecksum) reasons.push('VERSION_CHECKSUM_MISMATCH');
  if (version && version.jobId !== document.documentJobId) reasons.push('VERSION_JOB_MISMATCH');
  if (version && !['queued', 'ready'].includes(version.status)) reasons.push('VERSION_STATE_NOT_RECOVERABLE');
  if (version && ![null, 'legacy'].includes(version.chunkingStrategy)) reasons.push('VERSION_STRATEGY_CONFLICT');
  if (!document.progressEvents.some(event => event.jobId === document.documentJobId && event.stage === 'completed' && event.status === 'completed')) reasons.push('COMPLETION_EVENT_MISSING');
  if (queueState && !['completed', 'missing'].includes(queueState)) reasons.push(`QUEUE_JOB_NOT_TERMINAL:${queueState}`);
  if (logicalEntries.length !== 1 || !legacyEntry || legacyEntry.id !== document.documentId) reasons.push('TYPEGRAPH_IDENTITY_AMBIGUOUS');
  if (legacyEntry && typeof legacyEntry.metadata.documentId === 'string' && legacyEntry.metadata.documentId !== document.documentId) reasons.push('TYPEGRAPH_DOCUMENT_ID_MISMATCH');
  if (legacyEntry && legacyEntry.metadata.tenantId !== document.tenantId) reasons.push('TYPEGRAPH_TENANT_MISMATCH');
  if (legacyEntry && legacyEntry.metadata.checksum !== document.documentChecksum) reasons.push('TYPEGRAPH_CHECKSUM_MISMATCH');
  if (legacyEntry && legacyEntry.metadata.originalFilename !== document.documentFilename && legacyEntry.name !== document.documentFilename) reasons.push('TYPEGRAPH_FILENAME_MISMATCH');

  const ambiguousReasons = new Set([
    'VERSION_HISTORY_NOT_UNAMBIGUOUS', 'VERSION_ONE_MISSING', 'VERSION_TENANT_MISMATCH',
    'VERSION_DOCUMENT_ID_MISMATCH', 'VERSION_FILENAME_MISMATCH', 'VERSION_CHECKSUM_MISMATCH',
    'VERSION_JOB_MISMATCH', 'VERSION_STATE_NOT_RECOVERABLE', 'VERSION_STRATEGY_CONFLICT',
    'COMPLETION_EVENT_MISSING', 'TYPEGRAPH_IDENTITY_AMBIGUOUS', 'TYPEGRAPH_DOCUMENT_ID_MISMATCH',
    'TYPEGRAPH_TENANT_MISMATCH', 'TYPEGRAPH_CHECKSUM_MISMATCH', 'TYPEGRAPH_FILENAME_MISMATCH',
  ]);
  const rejected = reasons.some(reason => ambiguousReasons.has(reason) || reason.startsWith('QUEUE_JOB_NOT_TERMINAL:'));
  const eligible = isCandidate && reasons.length === 0;
  return {
    documentIdHash: hash(document.documentId)!, tenantHash: hash(document.tenantId)!,
    ...(version ? { versionIdHash: hash(version.id) } : {}), ...(legacyEntry ? { indexedIdHash: hash(legacyEntry.id) } : {}),
    eligible, category: eligible ? 'eligible' : rejected ? 'rejected' : 'skipped',
    reasons: reasons.length ? reasons : ['ALL_INTEGRITY_AND_TERMINAL_STATE_CHECKS_PASSED'],
  };
}

async function makeBackup(databaseUrl: URL) {
  const backupPath = backupArg || join(tmpdir(), `sitepilot-dev-pre-legacy-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  const password = decodeURIComponent(databaseUrl.password);
  const args = [
    '--format=custom', '--no-owner', '--no-acl', '--no-password',
    '--host', databaseUrl.hostname, '--port', databaseUrl.port || '5432',
    '--username', decodeURIComponent(databaseUrl.username), '--dbname', databaseUrl.pathname.slice(1),
    '--file', backupPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pg_dump', args, { env: { ...process.env, PGPASSWORD: password }, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`PG_DUMP_FAILED:${code}`)));
  });
  await chmod(backupPath, 0o600);
  const info = await stat(backupPath);
  if (!info.size) throw new Error('PG_DUMP_EMPTY');
  return { path: backupPath, bytes: info.size };
}

async function applyBackfill(prisma: PrismaClient, reports: Report[], documents: Candidate[]) {
  const byHash = new Map(reports.map(report => [report.documentIdHash, report]));
  const eligible = documents.filter(document => byHash.get(hash(document.documentId)!)?.eligible);
  await prisma.$transaction(async tx => {
    for (const document of eligible) {
      const version = document.versions[0]!;
      const versionResult = await tx.appDocumentVersion.updateMany({
        where: {
          id: version.id, documentId: document.documentId, tenantId: document.tenantId,
          versionNumber: 1, filename: document.documentFilename, checksum: document.documentChecksum,
          jobId: document.documentJobId, status: version.status, chunkingStrategy: version.chunkingStrategy,
        },
        data: { status: 'ready', chunkingStrategy: 'legacy', chunkerVersion: 'legacy-0', activeIndexGeneration: version.indexGeneration },
      });
      if (versionResult.count !== 1) throw new Error(`VERSION_CONCURRENCY_GUARD:${hash(version.id)}`);
      const documentResult = await tx.appDocument.updateMany({
        where: {
          id: document.documentId, tenantId: document.tenantId, status: 'ready', stage: 'completed',
          progress: 100, completedAt: { not: null }, activeVersionId: null,
          cancelRequested: false, deleteRequested: false, checksum: document.documentChecksum,
          filename: document.documentFilename, jobId: document.documentJobId,
        },
        data: { activeVersionId: version.id },
      });
      if (documentResult.count !== 1) throw new Error(`DOCUMENT_CONCURRENCY_GUARD:${hash(document.documentId)}`);
    }
  }, { isolationLevel: 'Serializable', timeout: 30000 });
  return eligible.length;
}

async function main() {
  const databaseUrl = assertLocalDevelopmentDatabase();
  if (apply && !tenantHashArg) throw new Error('APPLY_REQUIRES_EXPLICIT_TENANT_HASH');
  const prisma = new PrismaClient();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const embeddings = new EmbeddingsService();
  const reports: Report[] = [];
  const candidateRows: Candidate[] = [];
  let queueStates = new Map<string, string>();
  let queueStateError = false;
  try {
    await prisma.$connect();
    const rawDocuments = await prisma.appDocument.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        versions: { orderBy: { versionNumber: 'asc' }, select: { id: true, documentId: true, tenantId: true, versionNumber: true, filename: true, checksum: true, status: true, jobId: true, chunkingStrategy: true, indexGeneration: true, activeIndexGeneration: true } },
        progressEvents: { orderBy: { startedAt: 'desc' }, take: 100, select: { jobId: true, stage: true, status: true } },
      },
    });
    const byTenant = new Map<string, typeof rawDocuments>();
    for (const document of rawDocuments) byTenant.set(document.tenantId, [...(byTenant.get(document.tenantId) ?? []), document]);
    const indexByTenant = new Map<string, IndexedDocument[]>();
    for (const [tenantId] of byTenant) {
      const client = await typegraphInit(typegraphConfig(pool, embeddings, tenantId));
      indexByTenant.set(tenantId, await listAll(client));
    }
    try {
      queueStates = await getQueueStates(rawDocuments.flatMap(document => document.jobId ? [document.jobId] : []));
    } catch {
      queueStateError = true;
    }
    for (const document of rawDocuments) {
      const typed: Candidate = {
        documentId: document.id, tenantId: document.tenantId, documentChecksum: document.checksum,
        documentFilename: document.filename, documentStatus: document.status, documentStage: document.stage,
        documentProgress: document.progress, documentCompletedAt: document.completedAt, documentJobId: document.jobId,
        documentActiveVersionId: document.activeVersionId, documentCancelled: document.cancelRequested,
        documentDeleteRequested: document.deleteRequested,
        versions: document.versions, progressEvents: document.progressEvents,
      };
      const index = indexByTenant.get(document.tenantId) ?? [];
      const potentialIndex = index.some(item => item.id === document.id || item.metadata.documentId === document.id || item.id.split('::')[0] === document.id);
      if (document.status !== 'ready' && !potentialIndex) continue;
      const report = inspectCandidate(typed, index, queueStateError ? 'unavailable' : (document.jobId ? queueStates.get(document.jobId) : undefined));
      // Keep already-versioned ready documents in the dry-run report so a
      // second run demonstrates idempotence instead of hiding its candidates.
      if (report.category !== 'skipped' || document.status === 'ready') reports.push(report);
      candidateRows.push(typed);
    }
    const totals = {
      documentsInspected: rawDocuments.length,
      indexedDocumentsByTenant: [...indexByTenant.entries()].map(([tenantId, index]) => ({ tenantHash: hash(tenantId), count: index.length })),
      eligible: reports.filter(report => report.eligible).length,
      skipped: reports.filter(report => report.category === 'skipped').length,
      rejected: reports.filter(report => report.category === 'rejected').length,
      configuredTenantHash: hash(config.tenantId),
      configuredTenantOwnsDocuments: rawDocuments.some(document => document.tenantId === config.tenantId),
      queueStateInspectionAvailable: !queueStateError,
    };
    console.log(JSON.stringify({ mode: apply ? 'apply-requested' : 'dry-run', totals, documents: reports }, null, 2));

    if (!apply) return;
    const targetReports = reports.filter(report => report.tenantHash === tenantHashArg && report.category !== 'skipped');
    if (!targetReports.length) throw new Error('NO_CANDIDATES_FOR_TENANT_HASH');
    if (targetReports.some(report => !report.eligible)) throw new Error('REFUSING_APPLY_WHEN_ANY_CANDIDATE_IS_AMBIGUOUS');
    if (queueStateError) throw new Error('REFUSING_APPLY_WITHOUT_QUEUE_STATE_VERIFICATION');
    const backup = await makeBackup(databaseUrl);
    const targetDocs = candidateRows.filter(document => hash(document.tenantId) === tenantHashArg);
    const applied = await applyBackfill(prisma, targetReports, targetDocs);
    const verification = await prisma.appDocument.findMany({
      where: { tenantId: targetDocs[0]!.tenantId, id: { in: targetDocs.map(document => document.documentId) } },
      select: { activeVersionId: true, versions: { where: { chunkingStrategy: 'legacy', status: 'ready' }, select: { id: true } } },
    });
    const verified = verification.filter(document => document.activeVersionId && document.versions.some(version => version.id === document.activeVersionId)).length;
    if (verified !== applied) throw new Error(`POST_APPLY_VERIFICATION_FAILED:${verified}/${applied}`);
    console.log(JSON.stringify({ applied, verified, backup }, null, 2));
  } finally {
    await pool.end();
    await prisma.$disconnect();
  }
}

main().catch(error => {
  const code = error instanceof Error ? error.message.split(':')[0] : 'LEGACY_BACKFILL_FAILED';
  console.error(JSON.stringify({ errorCode: code }));
  process.exitCode = 1;
});
