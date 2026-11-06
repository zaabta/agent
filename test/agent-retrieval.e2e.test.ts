import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { TypegraphModule } from '../src/typegraph/typegraph.module.js';
import { TypegraphService } from '../src/typegraph/typegraph.service.js';

const baseUrl = process.env.AGENT_E2E_URL;
const enabled = process.env.RUN_AGENT_RETRIEVAL_E2E === 'true';

async function ask(accessToken: string, message: string) {
  const response = await fetch(`${baseUrl}/api/agent/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ message }),
  });
  assert.equal(response.status, 201);
  return await response.json() as {
    answer: string;
    sources: Array<{ sourceRef: string }>;
    toolsCalled: string[];
    citationValidation: string;
  };
}

test('real local Agent skips retrieval for greetings and retrieves/refuses unsupported multilingual workspace facts', {
  skip: !enabled || !baseUrl ? 'Set RUN_AGENT_RETRIEVAL_E2E=true, AGENT_E2E_URL, and run local API/PostgreSQL/Redis/TypeGraph/Ollama' : false,
  timeout: 600000,
}, async () => {
  const prisma = new PrismaClient();
  let principal: { accessToken: string; user: { id: string }; tenant: { id: string } } | undefined;
  let typegraphContext: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  let typegraph: TypegraphService | undefined;
  let fixtureId: string | undefined;
  try {
    const suffix = randomUUID();
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `retrieval-${suffix}@example.test`, password: `S!tePilot-${suffix}-Secure`, displayName: 'Isolated retrieval test' }),
    });
    assert.equal(registration.status, 201);
    principal = await registration.json() as typeof principal;
    assert.ok(principal?.accessToken);

    const greeting = await ask(principal.accessToken, 'Hi');
    assert.deepEqual(greeting.toolsCalled, []);
    assert.deepEqual(greeting.sources, []);

    for (const question of ['Who is the project leader?', 'Proje lideri kim?', 'من هو قائد المشروع؟', 'Kaç tane kritik bulgu var?']) {
      const result = await ask(principal.accessToken, question);
      assert.ok(result.toolsCalled.includes('documentSearch'), `No authorized TypeGraph retrieval occurred for ${question}`);
      assert.equal(result.citationValidation, 'no-evidence');
      assert.deepEqual(result.sources, []);
      assert.match(result.answer.toLowerCase(), /do not provide evidence/);
      assert.doesNotMatch(result.answer, /Deniz Kaya|\b2\b/);
      assert.doesNotMatch(result.answer.toLowerCase(), /filename|file name|which document/);
    }

    typegraphContext = await NestFactory.createApplicationContext(TypegraphModule, { logger: false });
    const typegraphService = typegraphContext.get(TypegraphService);
    typegraph = typegraphService;
    fixtureId = `agent-e2e-${suffix}`;
    const fixtureName = 'agent-verified-project.md';
    const fixtureContent = `# SitePilot Project Inspection\n\nEnglish: The project leader is Deniz Kaya. Inspection records contain exactly 2 critical findings. The approved project budget is not specified.\n\nTurkish: Proje lideri Deniz Kaya. İnceleme kayıtlarında tam olarak 2 kritik bulgu var. Onaylanan proje bütçesi belirtilmemiştir.\n\nArabic: قائد المشروع هو Deniz Kaya. تتضمن سجلات التفتيش نتيجتين حرجتين بالضبط. لم يتم تحديد ميزانية المشروع المعتمدة.`;
    const ingestion = await typegraphService.ingestDocument({ id: fixtureId, name: fixtureName, content: fixtureContent, metadata: { test: 'synthetic-agent-retrieval' } }, undefined, principal.tenant.id, principal.user.id);
    assert.equal(ingestion.result.status, 'complete');

    for (const question of ['Who is the project leader?', 'Proje lideri kim?', 'من هو قائد المشروع؟']) {
      const result = await ask(principal.accessToken, question);
      assert.ok(result.toolsCalled.includes('documentSearch'));
      assert.equal(result.citationValidation, 'valid', `Citation validation failed for ${question}: ${result.answer}`);
      assert.match(result.answer, /Deniz Kaya/, `Grounded answer missing for ${question}: ${result.answer}`);
      assert.ok(result.sources.length > 0);
      assert.ok(result.answer.includes(`[[${result.sources[0]!.sourceRef}]]`));
    }

    const count = await ask(principal.accessToken, 'Kaç tane kritik bulgu var?');
    assert.ok(count.toolsCalled.includes('documentSearch'));
    assert.match(count.answer, /\b2\b|٢/);
    assert.equal(count.citationValidation, 'valid');

    const budget = await ask(principal.accessToken, 'What is the approved project budget?');
    assert.ok(budget.toolsCalled.includes('documentSearch'));
    assert.doesNotMatch(budget.answer, /\b(?:USD|EUR|TRY|credits?)\b|\$\s?\d|\b\d[\d,.]*\s?(?:million|billion|k|m)\b/i);

    const summary = await ask(principal.accessToken, 'Summarize the documents in my workspace');
    assert.ok(summary.toolsCalled.includes('documentSearch'));
    assert.match(summary.answer, /Deniz Kaya/);
    assert.match(summary.answer, /2|٢/);
    assert.equal(summary.citationValidation, 'valid');

    const inventory = await ask(principal.accessToken, 'List my documents');
    assert.ok(inventory.toolsCalled.includes('listDocuments'));
    assert.match(inventory.answer, /agent-verified-project\.md/);

    const conversationResponse = await fetch(`${baseUrl}/api/agent/conversations`, {
      method: 'POST', headers: { authorization: `Bearer ${principal.accessToken}` },
    });
    assert.equal(conversationResponse.status, 201);
    const conversation = await conversationResponse.json() as { id: string };
    const streamResponse = await fetch(`${baseUrl}/api/agent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${principal.accessToken}` },
      body: JSON.stringify({ message: 'Who is the project leader?', conversationId: conversation.id }),
    });
    assert.equal(streamResponse.status, 200);
    const events: Array<{ name: string; data: Record<string, any> }> = [];
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        if (line.startsWith('event: ')) currentEvent = line.slice(7);
        if (line.startsWith('data: ')) events.push({ name: currentEvent, data: JSON.parse(line.slice(6)) });
      }
    }
    assert.ok(events.some(event => event.name === 'tool-start' && event.data.toolName === 'documentSearch'));
    const done = events.find(event => event.name === 'done')?.data;
    assert.ok(done);
    assert.equal(done.citationValidation, 'valid');
    assert.ok(done.sources.length > 0);
    assert.match(String(done.answer), /Deniz Kaya/);
    assert.ok((done.sources as Array<{ sourceRef: string }>).some(source => String(done.answer).includes(`[[${source.sourceRef}]]`)));
  } finally {
    if (typegraph && fixtureId && principal) await typegraph.deleteDocument(fixtureId, principal.tenant.id, principal.user.id).catch(() => undefined);
    if (principal) await prisma.conversation.deleteMany({ where: { ownerId: principal.user.id } }).catch(() => undefined);
    if (typegraphContext) await typegraphContext.close();
    if (principal) {
      await prisma.tenant.deleteMany({ where: { id: principal.tenant.id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: principal.user.id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
});
