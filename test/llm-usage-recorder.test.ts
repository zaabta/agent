import test from 'node:test';
import assert from 'node:assert/strict';
import { instrumentAgent, persistUsage, type UsageContext } from '../src/llm-admin/usage-recorder.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { asMastraModel, resolveRuntimeModel } from '../src/mastra/runtime-model.js';

function setup(){const rows:any[]=[];const prisma={llmUsage:{create:async({data}:any)=>{rows.push(data);return data;}}} as unknown as PrismaService;const context:UsageContext={tenantId:'tenant-a',userId:'user-a',conversationId:'00000000-0000-4000-8000-000000000001',logicalRequestId:'request-a',runtime:{provider:'openrouter',model:'provider/model:free',ollamaThink:false}};return{prisma,context,rows};}

test('usage recorder persists provider counts and actual response model without request content',async()=>{
  const {prisma,context,rows}=setup();
  await persistUsage(prisma,context,{usage:{inputTokens:13,outputTokens:7,totalTokens:20,cachedInputTokens:2,reasoningTokens:1},actualModel:'provider/actual:free',status:'success',latencyMs:42,source:'test-provider'});
  assert.equal(rows.length,1);assert.equal(rows[0].modelId,'provider/actual:free');assert.equal(rows[0].totalTokens,20);assert.equal(rows[0].inputTokens,13);assert.equal(rows[0].outputTokens,7);assert.equal(rows[0].cachedTokens,2);assert.equal(rows[0].accuracy,'provider-reported');assert.equal(rows[0].conversationId,context.conversationId);assert.equal('prompt'in rows[0],false);assert.equal('content'in rows[0],false);
});

test('unavailable usage stays null and recorder persistence failures do not affect generation',async()=>{
  const {prisma,context,rows}=setup();await persistUsage(prisma,context,{status:'failed',latencyMs:5,source:'test-provider',error:new Error('failure')});assert.equal(rows[0].inputTokens,null);assert.equal(rows[0].outputTokens,null);assert.equal(rows[0].totalTokens,null);assert.equal(rows[0].accuracy,'unavailable');
  const broken={llmUsage:{create:async()=>{throw new Error('db down');}}} as unknown as PrismaService;await assert.doesNotReject(()=>persistUsage(broken,context,{status:'success',latencyMs:1,source:'test'}));
});

test('legacy agent generate and streamed model steps record usage once per actual model response',async()=>{
  const {prisma,context,rows}=setup();const base:any={generate:async()=>({text:'answer',steps:[{usage:{inputTokens:2,outputTokens:3,totalTokens:5},response:{modelId:'openrouter/actual:free'}}]}),stream:async()=>({fullStream:(async function*(){yield{type:'step-start',payload:{}};yield{type:'step-finish',payload:{output:{usage:{inputTokens:4,outputTokens:6,totalTokens:10},response:{modelId:'ollama/qwen3:8b'}}}};})()})};
  const agent=instrumentAgent(base,prisma,context);await agent.generate([]);const stream=await agent.stream([]);for await(const _chunk of stream.fullStream){};assert.equal(rows.length,2);assert.equal(rows[0].modelId,'openrouter/actual:free');assert.equal(rows[1].modelId,'ollama/qwen3:8b');assert.equal(rows[1].totalTokens,10);assert.notEqual(rows[0].invocationId,rows[1].invocationId);
});

test('runtime resolver observes a new database model snapshot on the next request',async()=>{
  let selected='qwen3:4b-instruct-2507-q4_K_M';const prisma:any={runtimeSetting:{findMany:async()=>[{key:'MASTRA_PROVIDER',value:'ollama'},{key:'MASTRA_MODEL',value:selected},{key:'OLLAMA_THINK',value:'false'}]},registeredModel:{findUnique:async({where}:any)=>where.provider_modelId.modelId===selected?{available:true,compatible:true}:null}};
  const first=await resolveRuntimeModel(prisma);selected='qwen3:8b';const second=await resolveRuntimeModel(prisma);assert.equal(first.model,'qwen3:4b-instruct-2507-q4_K_M');assert.equal(second.model,'qwen3:8b');assert.equal((asMastraModel(second).primary as any).modelId,'qwen3:8b');
});
