import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { TypegraphModule } from '../src/typegraph/typegraph.module.js';
import { TypegraphService } from '../src/typegraph/typegraph.service.js';
import { StructuredDataService } from '../src/documents/structured-data.service.js';
import { config } from '../src/config.js';

const baseUrl = `http://127.0.0.1:${config.port}`;
const password = `S!tePilot-${randomUUID()}-secure`;

async function json(response: Response) { return response.json() as Promise<Record<string, any>>; }
async function bearer(accessToken: string) { return { authorization: `Bearer ${accessToken}` }; }
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
async function waitReady(accessToken: string, jobId: string) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: await bearer(accessToken) });
    assert.equal(response.status, 200);
    const job = await json(response);
    if (job.status === 'ready') return;
    assert.ok(!['failed', 'cancelled'].includes(job.status), `job terminal failure: ${JSON.stringify(job)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail(`Job ${jobId} did not finish`);
}
async function register(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, displayName: 'Synthetic Tenant Test' }) });
  assert.equal(response.status, 201);
  const payload = await json(response);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie?.includes('HttpOnly'));
  assert.ok(setCookie?.includes('SameSite=Strict'));
  return { ...payload, cookie: setCookie!.split(';', 1)[0] } as { accessToken: string; user: { id: string }; tenant: { id: string; role: string }; cookie: string };
}

test('real authentication, refresh rotation, tenant authorization and TypeGraph isolation', {
  skip: process.env.RUN_AUTH_E2E !== 'true' ? 'Set RUN_AUTH_E2E=true with the local API, PostgreSQL, Redis, TypeGraph and Ollama' : false,
  timeout: 300000,
}, async () => {
  const prisma = new PrismaClient();
  const context = await NestFactory.createApplicationContext(TypegraphModule, { logger: false });
  let a: Awaited<ReturnType<typeof register>> | undefined;
  let b: Awaited<ReturnType<typeof register>> | undefined;
  let c: Awaited<ReturnType<typeof register>> | undefined;
  let docA: { id: string; jobId: string } | undefined;
  let docB: { id: string; jobId: string } | undefined;
  let csvB: { id: string; jobId: string } | undefined;
  let conversationId: string | undefined;
  try {
    const suffix = randomUUID();
    a = await register(`tenant-a-${suffix}@example.test`);
    b = await register(`tenant-b-${suffix}@example.test`);
    c = await register(`tenant-member-${suffix}@example.test`);
    console.log('auth E2E: registered three isolated users');
    assert.notEqual(a.tenant.id, b.tenant.id);
    assert.equal(a.tenant.role, 'TENANT_ADMIN');

    const members = await fetch(`${baseUrl}/api/auth/members`, { headers: await bearer(a.accessToken) });
    assert.equal(members.status, 200);
    const deniedMembers = await fetch(`${baseUrl}/api/auth/members`, { headers: await bearer(b.accessToken) });
    assert.equal(deniedMembers.status, 200, 'new tenant admin may manage only their own tenant');

    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `tenant-a-${suffix}@example.test`, password }) });
    assert.equal(login.status, 200);
    const oldCookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
    const rotated = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: oldCookie } });
    assert.equal(rotated.status, 200);
    const newCookie = rotated.headers.get('set-cookie')!.split(';', 1)[0]!;
    assert.notEqual(newCookie, oldCookie);
    const reuse = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: oldCookie } });
    assert.equal(reuse.status, 401, 'rotated refresh token reuse must be rejected');
    // Log in again because reuse detection revokes the whole token family.
    const relogin = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `tenant-a-${suffix}@example.test`, password }) });
    assert.equal(relogin.status, 200);
    a.accessToken = (await json(relogin)).accessToken;

    const switchDenied = await fetch(`${baseUrl}/api/auth/tenant`, { method: 'POST', headers: { ...(await bearer(a.accessToken)), 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: b.tenant.id }) });
    assert.equal(switchDenied.status, 403, 'tenant switching must verify database membership');
    const addMember = await fetch(`${baseUrl}/api/auth/members`, { method: 'POST', headers: { ...(await bearer(a.accessToken)), 'content-type': 'application/json' }, body: JSON.stringify({ email: `tenant-member-${suffix}@example.test`, role: 'READ_ONLY' }) });
    assert.equal(addMember.status, 201);
    const memberSwitch = await fetch(`${baseUrl}/api/auth/tenant`, { method: 'POST', headers: { ...(await bearer(c.accessToken)), 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: a.tenant.id }) });
    assert.equal(memberSwitch.status, 201);
    c.accessToken = (await json(memberSwitch)).accessToken;
    const readOnlyUpload = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', headers: { ...(await bearer(c.accessToken)), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(readOnlyUpload.status, 403, 'read-only members cannot upload documents');
    console.log('auth E2E: refresh rotation, tenant switching, and RBAC passed');

    const markerA = `TENANT-A-${suffix}`;
    const markerB = `TENANT-B-${suffix}`;
    docA = await upload(a.accessToken, `tenant-a-${suffix}.txt`, `Synthetic private tenant A record ${markerA}`);
    docB = await upload(b.accessToken, `tenant-b-${suffix}.txt`, `Synthetic private tenant B record ${markerB}. Mercury Enterprise plan costs 741 credits per month.`);
    const codeB = `B-PRIVATE-${suffix}`;
    csvB = await uploadCsv(b.accessToken, `tenant-b-${suffix}.csv`, `reference,value\n${codeB},CELL-PRIVATE-${suffix}`);
    await Promise.all([waitReady(a.accessToken, docA.jobId), waitReady(b.accessToken, docB.jobId), waitReady(b.accessToken, csvB.jobId)]);

    const listA = await fetch(`${baseUrl}/api/documents`, { headers: { ...(await bearer(a.accessToken)), 'x-tenant-id': b.tenant.id } });
    const docsA = await json(listA) as unknown as Array<{ id: string }>;
    assert.ok(docsA.some(doc => doc.id === docA!.id));
    assert.equal(docsA.some(doc => doc.id === docB!.id), false, 'forged x-tenant-id cannot change scope');
    for (const [path, method] of [
      [`/api/documents/${docB.id}`, 'GET'], [`/api/jobs/${docB.jobId}`, 'GET'],
      [`/api/jobs/${docB.jobId}/events`, 'GET'], [`/api/jobs/${docB.jobId}/cancel`, 'POST'],
      [`/api/documents/${docB.id}`, 'DELETE'],
    ] as const) {
      const response: Response = await fetch(`${baseUrl}${path}`, { method, headers: await bearer(a.accessToken) });
      assert.equal(response.status, 404, `${method} ${path} must be tenant-hidden`);
    }
    const adminDenied = await fetch(`${baseUrl}/api/admin/workers/overview`, { headers: await bearer(a.accessToken) });
    assert.equal(adminDenied.status, 200, 'tenant admins may view worker health and aggregate queue diagnostics');
    const adminJobDenied = await fetch(`${baseUrl}/api/admin/workers/jobs/${docB.jobId}`, { headers: await bearer(a.accessToken) });
    assert.equal(adminJobDenied.status, 404, 'tenant admins must not enumerate another tenant job details');
    const tenantJobs = await json(await fetch(`${baseUrl}/api/admin/workers/jobs`, { headers: await bearer(a.accessToken) })) as { jobs: Array<{ id: string }> };
    assert.ok(tenantJobs.jobs.some(job => job.id === docA!.id));
    assert.equal(tenantJobs.jobs.some(job => job.id === docB!.id), false, 'admin job inventory remains tenant scoped');

    const typegraph = context.get(TypegraphService);
    const [searchA, searchB] = await Promise.all([
      typegraph.searchDocuments(markerA, 8, a.tenant.id, a.user.id),
      typegraph.searchDocuments(markerA, 8, b.tenant.id, b.user.id),
    ]);
    assert.ok(searchA.hits.some(hit => hit.citation.documentId === docA!.id));
    assert.equal(searchB.hits.some(hit => hit.citation.documentId === docA!.id), false, 'TypeGraph hard tenant namespace must isolate vector retrieval');
    assert.equal(searchA.hits.some(hit => hit.citation.documentId === docB!.id), false);

    const prismaStructured = new StructuredDataService(prisma);
    const cellsA = await prismaStructured.lookup(markerB, a.tenant.id);
    assert.equal(cellsA.hits.some(hit => hit.citation.documentId === csvB!.id), false, 'tenant A must not retrieve tenant B spreadsheet cells');
    const cellsB = await prismaStructured.lookup(codeB, b.tenant.id);
    assert.equal(cellsB.hits.some(hit => hit.citation.documentId === csvB!.id), true);
    console.log('auth E2E: document, job, TypeGraph and spreadsheet tenant isolation passed');

    const { AgentService } = await import('../src/agent/agent.service.js');
    const { AppModule } = await import('../src/app.module.js');
    const agentContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      console.log('auth E2E: asking Mastra against Tenant A only');
      const answer = await agentContext.get(AgentService).ask('What is the Mercury Enterprise monthly plan price in the uploaded documents?', undefined, { userId: a.user.id, tenantId: a.tenant.id, role: 'TENANT_ADMIN', authMethod: 'jwt' });
      assert.ok(answer.toolsCalled.includes('documentSearch'), `Agent did not call tenant-scoped TypeGraph search: ${JSON.stringify(answer.toolsCalled)}`);
      assert.equal(answer.sources.some(source => source.documentId === docB!.id || source.documentId === csvB!.id), false, 'Agent must not receive Tenant B source citations');
      assert.equal(answer.answer.includes('741'), false, 'Agent must not expose Tenant B facts');
      assert.ok(answer.sources.every(source => source.documentId === docA!.id), 'Agent sources must remain within Tenant A');
      console.log('auth E2E: Mastra did not retrieve or cite Tenant B evidence');
    } finally { await agentContext.close(); }

    const ownConversation = await fetch(`${baseUrl}/api/agent/conversations`, { method: 'POST', headers: await bearer(a.accessToken) });
    assert.equal(ownConversation.status, 201);
    conversationId = (await json(ownConversation)).id as string;
    const otherConversation = await fetch(`${baseUrl}/api/agent/conversations/${conversationId}`, { headers: await bearer(b.accessToken) });
    assert.equal(otherConversation.status, 404, 'conversation history must enforce owner and tenant');

    const openapiResponse = await fetch(`${baseUrl}/api/docs-json`);
    assert.equal(openapiResponse.status, 200);
    const openapi = await json(openapiResponse);
    const paths = openapi.paths as Record<string, unknown>;
    for (const path of ['/api/auth/register', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/members', '/api/documents/upload', '/api/jobs/{jobId}/events', '/api/admin/workers/overview', '/api/admin/workers/health', '/api/admin/workers/jobs', '/api/admin/workers/jobs/{jobId}', '/api/admin/workers/metrics', '/api/admin/workers/events', '/api/agent/ask', '/api/agent/stream', '/api/agent/conversations/{id}']) {
      assert.ok(paths[path], `Swagger is missing ${path}`);
    }
    assert.ok((openapi.components as { securitySchemes?: Record<string, unknown> }).securitySchemes?.bearer);
    console.log('auth E2E: Swagger contract passed');
  } finally {
    if (a && docA) await fetch(`${baseUrl}/api/documents/${docA.id}`, { method: 'DELETE', headers: await bearer(a.accessToken) }).catch(() => undefined);
    if (b && docB) await fetch(`${baseUrl}/api/documents/${docB.id}`, { method: 'DELETE', headers: await bearer(b.accessToken) }).catch(() => undefined);
    if (b && csvB) await fetch(`${baseUrl}/api/documents/${csvB.id}`, { method: 'DELETE', headers: await bearer(b.accessToken) }).catch(() => undefined);
    if (conversationId) await prisma.conversation.deleteMany({ where: { id: conversationId } }).catch(() => undefined);
    if (a) await prisma.tenant.deleteMany({ where: { id: a.tenant.id } }).catch(() => undefined);
    if (b) await prisma.tenant.deleteMany({ where: { id: b.tenant.id } }).catch(() => undefined);
    if (c) await prisma.tenant.deleteMany({ where: { id: c.tenant.id } }).catch(() => undefined);
    if (a || b || c) await prisma.user.deleteMany({ where: { id: { in: [a?.user.id, b?.user.id, c?.user.id].filter((id): id is string => !!id) } } }).catch(() => undefined);
    await prisma.$disconnect();
    await context.close();
  }
});
