import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { AgentService } from '../src/agent/agent.service.js';
import { StructuredDataService } from '../src/documents/structured-data.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { config } from '../src/config.js';
import type { AuthPrincipal } from '../src/auth/auth.types.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const agent = app.get(AgentService);
const structured = app.get(StructuredDataService);
const prisma = app.get(PrismaService);
const principal: AuthPrincipal = { userId: config.conversationOwnerId, tenantId: config.tenantId, authMethod: 'jwt' };
const datasets = await structured.discoverDatasets(principal.tenantId);
const selectedScenarios = process.env.AGENT_DIAG_SCENARIOS?.split(',').map(value => value.trim()).filter(Boolean);
const runScenario = (name: string) => !selectedScenarios?.length || selectedScenarios.includes(name);

function report(name: string, result: Awaited<ReturnType<AgentService['ask']>>) {
  console.log(JSON.stringify({
    name, model: config.model, toolsCalled: result.toolsCalled,
    citationValidation: result.citationValidation, sourceCount: result.sources.length,
    answerLength: result.answer.length, timing: result.timing,
  }));
}

async function askAndClean(name: string, message: string) {
  let conversationId: string | undefined;
  try {
    const result = await agent.ask(message, undefined, principal);
    conversationId = result.conversationId;
    report(name, result);
  } finally {
    if (conversationId) await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => undefined);
  }
}

console.log(JSON.stringify({ model: config.model, tenantDatasetCount: datasets.length, selectedDataset: datasets[0] ? { documentId: datasets[0].documentId, sheetCount: datasets[0].sheets.length, columnCount: datasets[0].sheets.reduce((n, sheet) => n + sheet.columns.length, 0) } : null }));

let failed = false;
try {
  if (!selectedScenarios?.length && datasets[0]?.sheets[0]) {
    const selected = datasets[0];
    const selectedSheet = selected.sheets[0]!;
    const sqlCount = await structured.aggregate('COUNT', undefined, principal.tenantId, { documentId: selected.documentId, sheetName: selectedSheet.sheetName });
    const sqlGroup = selectedSheet.columns[0]
      ? await structured.aggregate('GROUP_BY', selectedSheet.columns[0], principal.tenantId, { documentId: selected.documentId, sheetName: selectedSheet.sheetName })
      : undefined;
    console.log(JSON.stringify({ sqlProbe: { count: sqlCount.total, datasetCount: sqlCount.datasets.length, sourceCount: sqlCount.sources.length, groupCount: sqlGroup && 'groups' in sqlGroup ? sqlGroup.groups.length : null, groupSourceCount: sqlGroup && 'sources' in sqlGroup ? sqlGroup.sources.length : null } }));
  }
  if (runScenario('dataset-discovery')) await askAndClean('dataset-discovery', 'Show me the available datasets and their columns.');
  if (datasets[0]?.sheets[0]) {
    const dataset = datasets[0];
    const sheet = dataset.sheets[0];
    const column = sheet.columns[0];
    if (!selectedScenarios?.length || runScenario('count')) await askAndClean('count', `Count records in dataset ${dataset.filename}, sheet ${sheet.sheetName}.`);
    if (column && (!selectedScenarios?.length || runScenario('group-by'))) await askAndClean('group-by', `Break down records in dataset ${dataset.filename}, sheet ${sheet.sheetName}, by the column ${column}.`);
    if (!selectedScenarios?.length || runScenario('exact-row-lookup')) {
      const cell = await prisma.appDocumentCell.findFirst({
        where: { tenantId: principal.tenantId, documentId: dataset.documentId, sheetName: sheet.sheetName, rowNumber: { gt: 1 }, value: { not: '' }, document: { status: 'ready', tenantId: principal.tenantId } },
        select: { value: true },
      });
      if (cell?.value) await askAndClean('exact-row-lookup', `Find the exact row containing this cell value: ${cell.value}`);
    }
  }
  if (runScenario('budget-policy')) await askAndClean('budget-policy', 'According to the project policy, is an approved budget documented?');
  if (runScenario('general-conversation')) await askAndClean('general-conversation', 'Hi');
} catch (error) {
  failed = true;
  const detail = error as { code?: string; meta?: { code?: string; message?: string } };
  const databaseMessage = detail.meta?.message?.replace(/'[^']*'/g, "'[redacted]'").slice(0, 240);
  console.log(JSON.stringify({ harnessError: error instanceof Error ? error.name : 'unknown-error', code: detail.code, databaseCode: detail.meta?.code, databaseMessage, message: error instanceof TypeError ? error.message : undefined }));
} finally {
  await app.close();
  process.exit(failed ? 1 : 0);
}
