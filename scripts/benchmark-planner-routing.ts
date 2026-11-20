import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { buildPlannerPrompt, planLLMSchema, planLLMSchemaWithoutTools, plannerGenerationOptions, plannerInstructions } from '../src/agent/agent.workflow.js';
import { config } from '../src/config.js';
import { asMastraModel } from '../src/mastra/runtime-model.js';

const tools = [
  { id: 'custom_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'weather_feed', description: 'Return current temperature, precipitation, and forecast for a city.', input: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }, schema: z.strictObject({ city: z.string() }) },
  { id: 'custom_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'exchange_quote', description: 'Return the latest exchange rate between two ISO currency codes.', input: { type: 'object', properties: { base: { type: 'string' }, quote: { type: 'string' } }, required: ['base', 'quote'], additionalProperties: false }, schema: z.strictObject({ base: z.string(), quote: z.string() }) },
  { id: 'custom_cccccccccccccccccccccccccccccccc', name: 'air_reading', description: 'Return AQI and pollutant readings for an outdoor location.', input: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'], additionalProperties: false }, schema: z.strictObject({ location: z.string() }) },
  { id: 'custom_dddddddddddddddddddddddddddddddd', name: 'product_index', description: 'Search a retail catalog by product description, availability, and price constraints.', input: { type: 'object', properties: { query: { type: 'string' }, inStockOnly: { type: 'boolean' } }, required: ['query'], additionalProperties: false }, schema: z.strictObject({ query: z.string(), inStockOnly: z.boolean().optional() }) },
  { id: 'custom_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'ferry_board', description: 'Get live ferry departures between two ports for a specified date.', input: { type: 'object', properties: { fromPort: { type: 'string' }, toPort: { type: 'string' }, date: { type: 'string' } }, required: ['fromPort', 'toPort'], additionalProperties: false }, schema: z.strictObject({ fromPort: z.string(), toPort: z.string(), date: z.string().optional() }) },
];
const cases = [
  { id: 'weather-en', question: 'What is the temperature and rain forecast in Lisbon?', expected: 'tool_call', expectedTool: 'weather_feed', expectedArgs: { city: 'Lisbon' } },
  { id: 'currency-ar', question: 'كم يساوي اليورو بالدولار اليوم؟', expected: 'tool_call', expectedTool: 'exchange_quote', expectedArgs: { base: 'EUR', quote: 'USD' } },
  { id: 'air-tr', question: 'Bugün Kadıköy’de hava kalitesi ve partikül seviyesi nasıl?', expected: 'tool_call', expectedTool: 'air_reading', expectedArgs: { location: 'Kadıköy' } },
  { id: 'product-en', question: 'Find an in-stock portable induction cooktop under 100 euros.', expected: 'tool_call', expectedTool: 'product_index', expectedArgs: { query: 'induction', inStockOnly: true }, requiredArgText: { query: ['under 100 euros'] } },
  { id: 'unseen-ferry-tr', question: 'Yarın Kadıköy’den Beşiktaş’a vapur saatleri nedir?', expected: 'tool_call', expectedTool: 'ferry_board', expectedArgs: { fromPort: 'Kadıköy', toPort: 'Beşiktaş' } },
  { id: 'document-source', question: 'In the uploaded manual.pdf, what cleaning interval does the manufacturer specify?', expected: 'retrieve' },
  { id: 'excel-aggregate', question: 'Count inventory records whose status is active.', expected: 'aggregate' },
  { id: 'excel-lookup', question: 'What is the status of inventory record 17?', expected: 'lookup', expectedArgs: { value: '17' } },
  { id: 'ambiguous', question: 'What are the current outdoor conditions in Lisbon?', expected: 'clarify', acceptable: [{ operation: 'tool_call', toolName: 'weather_feed', args: { city: 'Lisbon' } }] },
  { id: 'ordinary-chat', question: 'Thanks, that helped.', expected: 'respond' },
  { id: 'no-tool-doc', question: 'What does the uploaded safety policy say about evacuation?', expected: 'retrieve' },
];
const runSettings = { temperature: 0, maxSteps: 1, maxRetries: 0, timeoutMs: 90000 };
const productionOperationDescriptions = Object.fromEntries((z.toJSONSchema(planLLMSchema) as any).oneOf.map((branch: any) => [branch.properties.operation.const, branch.properties.operation.description])) as Record<string, string>;
const diagnosticSchema = (includeTools: boolean) => z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('aggregate').describe(productionOperationDescriptions.aggregate) }),
  z.object({ operation: z.literal('lookup').describe(productionOperationDescriptions.lookup) }),
  z.object({ operation: z.literal('retrieve').describe(productionOperationDescriptions.retrieve) }),
  z.object({ operation: z.literal('discover').describe(productionOperationDescriptions.discover) }),
  z.object({ operation: z.literal('list').describe(productionOperationDescriptions.list) }),
  z.object({ operation: z.literal('respond').describe(productionOperationDescriptions.respond) }),
  z.object({ operation: z.literal('clarify').describe(productionOperationDescriptions.clarify) }),
  ...(includeTools ? [z.object({ operation: z.literal('tool_call').describe(productionOperationDescriptions.tool_call), selectedToolId: z.string().min(1).describe('Exact ID from the provided catalog.'), args: z.object({}).catchall(z.unknown()).describe('Arguments for the selected catalog entry.') })] : []),
] as [z.ZodTypeAny, ...z.ZodTypeAny[]]);

function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const swap = (state >>> 0) % (index + 1);
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}
function classify(item: (typeof cases)[number], actual: string, selectedName?: string, argsValid?: boolean, argsMatchExpected?: boolean, actualArgs: Record<string, unknown> = {}) {
  if ('acceptable' in item && item.acceptable.some(option => option.operation === actual && option.toolName === selectedName && Object.entries(option.args).every(([key, value]) => actualArgs[key] === value))) return 'correct_ambiguous_interpretation';
  if (actual === item.expected && (!('expectedTool' in item) || selectedName === item.expectedTool)) return argsValid === false || argsMatchExpected === false ? 'invalid_arguments' : 'correct';
  if (actual === 'clarify' && item.expected !== 'clarify') return 'inappropriate_clarification';
  if (actual === 'tool_call' && item.expected === 'tool_call' && selectedName !== item.expectedTool) return 'wrong_tool_selection';
  if (actual === 'tool_call' && ['retrieve', 'aggregate', 'lookup'].includes(item.expected)) return 'incorrect_document_excel_routing';
  if (item.expected === 'tool_call' && ['retrieve', 'aggregate', 'lookup'].includes(actual)) return 'incorrect_document_excel_routing';
  if (['retrieve', 'aggregate', 'lookup'].includes(item.expected)) return 'incorrect_document_excel_routing';
  return 'operation_selection_error';
}

const cli = process.argv.slice(2);
const trials = Number(cli.find(arg => arg.startsWith('--trials='))?.split('=')[1] ?? 2);
const seeds = (cli.find(arg => arg.startsWith('--seeds='))?.split('=')[1] ?? '1701,2903').split(',').map(Number);
const models = cli.filter(arg => !arg.startsWith('--'));
if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error('--trials must be an integer from 1 to 10');
if (!seeds.length || seeds.some(seed => !Number.isInteger(seed) || seed <= 0)) throw new Error('--seeds must be a comma-separated list of positive integers');
if (!models.length) throw new Error('Pass installed Ollama model IDs, optionally with --trials=N and --seeds=...');
const available = await fetch(`${config.ollamaUrl.replace(/\/+$/, '')}/api/tags`).then(response => response.json()) as { models: Array<{ name: string }> };
const installed = new Set(available.models.map(model => model.name));
if (models.some(model => !installed.has(model))) throw new Error(`Requested model is not installed. Available: ${[...installed].join(', ')}`);

const fullSchemaJson = z.toJSONSchema(planLLMSchema);
const simpleSchemaJson = z.toJSONSchema(diagnosticSchema(true));
console.log(JSON.stringify({ type: 'benchmark', models, trials, seeds, prompt: 'current production plannerInstructions + buildPlannerPrompt; Ollama does not receive duplicate schema text in prompt', settings: { ...runSettings, provider: 'ollama', ollamaThink: false, maxOutputTokens: config.plannerMaxOutputTokens, temperature: 0 }, schemas: { production: { name: 'planLLMSchema', operations: 8, bytes: Buffer.byteLength(JSON.stringify(fullSchemaJson)), jsonSchema: fullSchemaJson }, diagnostic: { name: 'diagnosticSchema', operations: 8, bytes: Buffer.byteLength(JSON.stringify(simpleSchemaJson)), jsonSchema: simpleSchemaJson } }, tools: tools.map(({ schema: _schema, ...tool }) => tool), cases }));

for (const model of models) {
  const runtime = { provider: 'ollama', model, ollamaThink: false, maxOutputTokens: config.plannerMaxOutputTokens };
  for (const item of cases) {
    const baseCatalog = item.id === 'ordinary-chat' || item.id === 'no-tool-doc' ? [] : tools.map(({ schema: _schema, ...tool }) => tool);
    const catalogVariants = [{ label: 'listed', seed: null as number | null, catalog: baseCatalog }, ...(baseCatalog.length ? seeds.map(seed => ({ label: `seed-${seed}`, seed, catalog: seededShuffle(baseCatalog, seed) })) : [])];
    for (const variant of catalogVariants) {
      const productionSchema = variant.catalog.length ? planLLMSchema : planLLMSchemaWithoutTools;
      const simpleSchema = diagnosticSchema(variant.catalog.length > 0);
      const context = { provider: 'ollama', retrievalLanguage: 'Preserve the user language and literal names/identifiers in retrieval queries.', conversationSummary: '', history: [], contextEntities: [], userMemories: [], evidenceRefs: [], previousSelection: undefined, catalog: variant.catalog, message: item.question };
      for (let trial = 1; trial <= trials; trial++) {
        const styles = trial % 2 ? ['production', 'diagnostic'] as const : ['diagnostic', 'production'] as const;
        const results: Record<string, any> = {};
        for (const schemaStyle of styles) {
          const schema = schemaStyle === 'production' ? productionSchema : simpleSchema;
          const agent = new Agent({ id: `planner-schema-benchmark-${model}-${item.id}-${variant.label}-${trial}-${schemaStyle}`, name: 'Planner schema diagnostic', instructions: plannerInstructions(context.retrievalLanguage), model: asMastraModel(runtime).primary as any, maxRetries: 0 });
          const started = performance.now();
          let result: any;
          let error: string | undefined;
          try {
            result = await agent.generate([{ role: 'user', content: buildPlannerPrompt({ ...context, schema }) }], {
              ...plannerGenerationOptions(runtime), structuredOutput: { schema, errorStrategy: 'strict' }, modelSettings: { maxOutputTokens: config.plannerMaxOutputTokens, temperature: 0 }, maxSteps: 1, abortSignal: AbortSignal.timeout(runSettings.timeoutMs),
            });
          } catch (cause) { error = cause instanceof Error ? cause.name : 'UnknownError'; }
          const raw = result?.object ?? (() => { try { return JSON.parse(result?.text ?? ''); } catch { return undefined; } })();
          const parsed = raw === undefined ? undefined : schema.safeParse(raw);
          const plan = parsed?.success ? parsed.data as any : undefined;
          const actual = plan?.operation ?? 'invalid';
          const selectedId = schemaStyle === 'production' ? plan?.toolCall?.id : plan?.selectedToolId;
          const generatedArgs = schemaStyle === 'production' ? plan?.toolCall?.args : plan?.args;
          const selected = actual === 'tool_call' ? variant.catalog.find((tool: any) => tool.id === selectedId) : undefined;
          const selectedSchema = selected ? tools.find(tool => tool.id === selected.id)?.schema : undefined;
          const argsValidation = generatedArgs && selectedSchema ? selectedSchema.safeParse(generatedArgs) : undefined;
          const expectedArgs = 'expectedArgs' in item ? item.expectedArgs : undefined;
          const requiredArgText = 'requiredArgText' in item ? item.requiredArgText : undefined;
          const semanticArgsMatch = expectedArgs ? Object.entries(expectedArgs).every(([key, expected]) => generatedArgs?.[key] === expected || (typeof generatedArgs?.[key] === 'string' && String(generatedArgs[key]).toLocaleLowerCase().includes(String(expected).toLocaleLowerCase()))) && (!requiredArgText || Object.entries(requiredArgText).every(([key, terms]) => terms.every(term => typeof generatedArgs?.[key] === 'string' && generatedArgs[key].toLocaleLowerCase().includes(term.toLocaleLowerCase())))) : undefined;
          const operationCorrect = actual === item.expected;
          const acceptableAlternative = 'acceptable' in item && item.acceptable.some(option => option.operation === actual && option.toolName === selected?.name && Object.entries(option.args).every(([key, value]) => generatedArgs?.[key] === value));
          const toolIdCorrect = 'expectedTool' in item ? actual === 'tool_call' && selectedId === tools.find(tool => tool.name === item.expectedTool)?.id : undefined;
          const semanticArgumentsCorrect = expectedArgs ? Boolean(operationCorrect && (toolIdCorrect === undefined || toolIdCorrect) && semanticArgsMatch) : undefined;
          const overallCorrect = acceptableAlternative || (operationCorrect && (toolIdCorrect ?? true) && (semanticArgumentsCorrect ?? true));
          const usage = result?.usage ?? result?.totalUsage;
          results[schemaStyle] = { type: 'trial', model, schemaStyle, caseId: item.id, trial, catalogOrder: variant.label, seed: variant.seed, request: item.question, expected: { operation: item.expected, ...( 'expectedTool' in item ? { toolId: tools.find(tool => tool.name === item.expectedTool)?.id } : {}), ...(expectedArgs ? { args: expectedArgs } : {}), ...(requiredArgText ? { requiredArgText } : {}), ...( 'acceptable' in item ? { acceptable: item.acceptable } : {}) }, actual: { operation: actual, ...(actual === 'tool_call' ? { toolId: selectedId ?? null, toolInputSchemaKnown: Boolean(selectedSchema), args: generatedArgs ?? null } : {}) }, validation: { plannerSchema: Boolean(parsed?.success), selectedToolArguments: argsValidation?.success ?? null, semanticArgumentsMatch: semanticArgsMatch ?? null }, accuracy: { operation: operationCorrect, acceptableOutcome: operationCorrect || acceptableAlternative, toolId: toolIdCorrect ?? null, semanticArguments: semanticArgumentsCorrect ?? null, overall: overallCorrect && (semanticArgsMatch ?? true) }, failureClass: classify(item, actual, selected?.name, argsValidation?.success, semanticArgsMatch, generatedArgs), usage: { inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null }, latencyMs: Math.round(performance.now() - started), ...(error ? { error } : {}) };
        }
        console.log(JSON.stringify({ type: 'paired_trial', model, caseId: item.id, trial, catalogOrder: variant.label, seed: variant.seed, request: item.question, expected: results.production.expected, production: results.production, diagnostic: results.diagnostic }));
      }
    }
  }
}
