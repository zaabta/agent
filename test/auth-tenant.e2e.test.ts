import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { config } from '../src/config.js';
import { StructuredDataService } from '../src/documents/structured-data.service.js';

const baseUrl = `http://127.0.0.1:${config.port}`;
const password = `S!tePilot-${randomUUID()}-secure`;
type Account = { user: { id: string }; accessToken: string; cookie: string; tenant: { id: string; role: string } };

async function json(response: Response) { return response.json() as Promise<Record<string, any>>; }
async function bearer(accessToken: string) { return { authorization: `Bearer ${accessToken}` }; }
async function register(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: 'Shared Workspace E2E' }),
  });
  assert.equal(response.status, 201);
  const payload = await json(response);
  assert.equal(payload.status, 'pending_workspace_membership');
  assert.equal(response.headers.get('set-cookie'), null, 'pending users receive no authenticated session');
  return payload.user as { id: string };
}
async function login(email: string): Promise<Account> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const payload = await json(response);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie?.includes('HttpOnly'));
  assert.ok(cookie?.includes('SameSite=Strict'));
  return { ...payload, cookie: cookie!.split(';', 1)[0] } as Account;
}
async function upload(accessToken: string, filename: string, text: string) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/plain' }), filename);
  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', headers: await bearer(accessToken), body: form });
  assert.equal(response.status, 202);
  return (await json(response)).document as { id: string; jobId: string };
}
async function uploadCsv(accessToken: string, filename: string, text: string) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), filename);
  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', headers: await bearer(accessToken), body: form });
  assert.equal(response.status, 202);
  return (await json(response)).document as { id: string; jobId: string };
}
async function uploadVersion(accessToken: string, documentId: string, filename: string, text: string) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/plain' }), filename);
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, { method: 'POST', headers: await bearer(accessToken), body: form });
  assert.equal(response.status, 202);
  return (await json(response)).version as { id: string; jobId: string };
}
async function waitReady(accessToken: string, jobId: string, prisma: PrismaClient) {
  const deadline = Date.now() + 90000;
  let lastState: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: await bearer(accessToken) });
    assert.equal(response.status, 200);
    const job = await json(response);
    lastState = { status: job.status, stage: job.stage, progress: job.progress, failureCode: job.failureCode, queueState: job.queueState };
    if (job.status === 'ready') return;
    assert.ok(!['failed', 'cancelled'].includes(job.status), `job reached terminal state ${job.status}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const [version, document] = await Promise.all([
    prisma.appDocumentVersion.findFirst({ where: { jobId }, select: { id: true, status: true, cancelRequested: true, jobId: true, documentId: true, tenantId: true } }),
    prisma.appDocument.findFirst({ where: { jobId }, select: { id: true, status: true, stage: true, activeVersionId: true, cancelRequested: true, tenantId: true } }),
  ]);
  const detail = {
    ...lastState,
    versionStatus: version?.status,
    versionCancelRequested: version?.cancelRequested,
    versionDocumentMatches: Boolean(version && document && version.documentId === document.id),
    versionTenantMatches: Boolean(version && document && version.tenantId === document.tenantId),
    documentStatus: document?.status,
    documentStage: document?.stage,
    documentCancelRequested: document?.cancelRequested,
    activePointerMatchesVersion: Boolean(version && document?.activeVersionId === version.id),
  };
  assert.fail(`Document indexing did not finish before the E2E deadline: ${JSON.stringify(detail)}`);
}
async function search(accessToken: string | undefined, query: string) {
  return fetch(`${baseUrl}/api/documents/search`, {
    method: 'POST', headers: { ...(accessToken ? await bearer(accessToken) : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ query, limit: 8 }),
  });
}

test('authorized company users share documents and datasets while conversations stay private', {
  skip: process.env.RUN_AUTH_E2E !== 'true' ? 'Set RUN_AUTH_E2E=true with the local API, PostgreSQL, Redis, TypeGraph, worker, and Ollama' : false,
  timeout: 300000,
}, async () => {
  const workspaceId = config.companyWorkspaceId;
  assert.ok(workspaceId, 'COMPANY_WORKSPACE_ID must point at the existing company workspace');
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const emailX = `company-user-x-${suffix}@example.test`;
  const emailY = `company-user-y-${suffix}@example.test`;
  const emailUnauthorized = `company-pending-${suffix}@example.test`;
  let userX: { id: string } | undefined;
  let userY: { id: string } | undefined;
  let userUnauthorized: { id: string } | undefined;
  let docX: { id: string; jobId: string } | undefined;
  let csvX: { id: string; jobId: string } | undefined;
  let conversationX: string | undefined;
  let conversationY: string | undefined;
  let accountX: Account | undefined;
  let accountY: Account | undefined;
  try {
    const beforeTenants = await prisma.tenant.count();
    userX = await register(emailX);
    userY = await register(emailY);
    userUnauthorized = await register(emailUnauthorized);
    assert.equal(await prisma.tenant.count(), beforeTenants, 'registration must not provision per-user workspaces');

    // The fixture bootstrap grants only User X admin membership in the already
    // configured workspace. User Y is added through the authenticated admin API.
    await prisma.membership.create({ data: { tenantId: workspaceId, userId: userX.id, role: 'TENANT_ADMIN' } });
    accountX = await login(emailX);
    assert.equal(accountX.tenant.id, workspaceId);
    assert.equal(accountX.tenant.role, 'TENANT_ADMIN');

    const addY = await fetch(`${baseUrl}/api/auth/members`, {
      method: 'POST', headers: { ...(await bearer(accountX.accessToken)), 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailY, role: 'MEMBER' }),
    });
    assert.equal(addY.status, 201);
    accountY = await login(emailY);
    assert.equal(accountY.tenant.id, accountX.tenant.id, 'both users must authenticate into the same canonical workspace');

    const existingLegacy = await prisma.appDocumentVersion.findFirst({
      where: { tenantId: workspaceId, status: 'ready', chunkingStrategy: 'legacy' },
      include: { document: { select: { id: true, filename: true, activeVersionId: true, status: true } } },
    });
    if (existingLegacy?.document.status === 'ready' && existingLegacy.document.activeVersionId === existingLegacy.id) {
      const legacySearch = await search(accountY.accessToken, existingLegacy.document.filename);
      assert.equal(legacySearch.status, 200);
      const legacyHits = (await json(legacySearch)).hits as Array<{ citation: { documentId: string; documentVersionId?: string } }>;
      assert.ok(legacyHits.some(hit => hit.citation.documentId === existingLegacy.document.id && hit.citation.documentVersionId === existingLegacy.id), 'a pre-existing active legacy index remains searchable by another authorized user');
    }

    const unapprovedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailUnauthorized, password }),
    });
    assert.equal(unapprovedLogin.status, 403, 'valid credentials without company membership cannot access documents');
    const anonymous = await search(undefined, 'unauthorized access check');
    assert.equal(anonymous.status, 401, 'anonymous users cannot access company documents');

    const marker = `SHARED-COMPANY-${suffix}`;
    const oldMarker = `SUPERSEDED-${suffix}`;
    const newMarker = `CURRENT-${suffix}`;
    docX = await upload(accountX.accessToken, `shared-company-${suffix}.txt`, `${marker} company report with ${oldMarker} financial total.`);
    await waitReady(accountX.accessToken, docX.jobId, prisma);
    const rowKey = `ROW-${suffix}`;
    csvX = await uploadCsv(accountX.accessToken, `shared-company-data-${suffix}.csv`, `reference,value\n${rowKey},SHARED-VALUE-${suffix}`);
    await waitReady(accountX.accessToken, csvX.jobId, prisma);

    const [searchX, searchY] = await Promise.all([search(accountX.accessToken, marker), search(accountY.accessToken, marker)]);
    assert.equal(searchX.status, 200);
    assert.equal(searchY.status, 200);
    const hitsX = (await json(searchX)).hits as Array<{ citation: { documentId: string; documentVersionId?: string; filename: string } }>;
    const hitsY = (await json(searchY)).hits as Array<{ citation: { documentId: string; documentVersionId?: string; filename: string } }>;
    assert.ok(hitsX.some(hit => hit.citation.documentId === docX!.id));
    assert.ok(hitsY.some(hit => hit.citation.documentId === docX!.id), 'User Y must retrieve User X document evidence');
    assert.ok(hitsY.find(hit => hit.citation.documentId === docX!.id)?.citation.documentVersionId, 'shared result must carry a version citation');
    assert.deepEqual(hitsY.map(hit => hit.citation.documentId), hitsX.map(hit => hit.citation.documentId), 'authorized users receive the same ranked workspace result IDs');

    const structured = await new StructuredDataService(prisma).lookup(rowKey, accountY.tenant.id);
    assert.ok(structured.hits.some(hit => hit.citation.documentId === csvX!.id && hit.citation.documentVersionId), 'User Y can query User X structured dataset with active-version citation in the shared workspace');

    const version = await uploadVersion(accountX.accessToken, docX.id, `shared-company-${suffix}.txt`, `${marker} company report now says ${newMarker} financial total.`);
    await waitReady(accountX.accessToken, version.jobId, prisma);
    const [supersededSearch, currentSearch] = await Promise.all([
      search(accountY.accessToken, oldMarker), search(accountY.accessToken, newMarker),
    ]);
    assert.equal(supersededSearch.status, 200);
    assert.equal(currentSearch.status, 200);
    const oldHits = (await json(supersededSearch)).hits as Array<{ content: string; citation: { documentId: string; documentVersionId?: string } }>;
    const currentHits = (await json(currentSearch)).hits as Array<{ content: string; citation: { documentId: string; documentVersionId?: string } }>;
    const supersededEvidence = oldHits.filter(hit => hit.content.includes(oldMarker));
    assert.equal(supersededEvidence.length, 0, `superseded passage content must not be returned; versions=${JSON.stringify(oldHits.filter(hit => hit.citation.documentId === docX!.id).map(hit => hit.citation.documentVersionId))}`);
    assert.ok(currentHits.some(hit => hit.citation.documentId === docX!.id && hit.citation.documentVersionId === version.id));

    const createX = await fetch(`${baseUrl}/api/agent/conversations`, { method: 'POST', headers: await bearer(accountX.accessToken) });
    const createY = await fetch(`${baseUrl}/api/agent/conversations`, { method: 'POST', headers: await bearer(accountY.accessToken) });
    assert.equal(createX.status, 201);
    assert.equal(createY.status, 201);
    conversationX = (await json(createX)).id as string;
    conversationY = (await json(createY)).id as string;
    assert.equal((await fetch(`${baseUrl}/api/agent/conversations/${conversationX}`, { headers: await bearer(accountY.accessToken) })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/agent/conversations/${conversationY}`, { headers: await bearer(accountX.accessToken) })).status, 404);

    const wrongPassword = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailX, password: 'incorrect-password' }),
    });
    assert.equal(wrongPassword.status, 401);
  } finally {
    if (accountX && docX) await fetch(`${baseUrl}/api/documents/${docX.id}`, { method: 'DELETE', headers: await bearer(accountX.accessToken) }).catch(() => undefined);
    if (accountX && csvX) await fetch(`${baseUrl}/api/documents/${csvX.id}`, { method: 'DELETE', headers: await bearer(accountX.accessToken) }).catch(() => undefined);
    const userIds = [userX?.id, userY?.id, userUnauthorized?.id].filter((id): id is string => Boolean(id));
    if (userIds.length) {
      await prisma.conversation.deleteMany({ where: { ownerId: { in: userIds } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
});
