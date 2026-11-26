import test from 'node:test';
import assert from 'node:assert/strict';
import { persistUsage, persistUsageEvent, type UsageContext } from '../src/llm-admin/usage-recorder.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { modelForRole, modelRequestTimeoutMs, resolveRuntimeModel, resolveRuntimeModels } from '../src/llm-admin/runtime-model.js';

function setup(){const rows:any[]=[];const prisma={llmUsage:{create:async({data}:any)=>{rows.push(data);return data;}}} as unknown as PrismaService;const context:UsageContext={tenantId:'tenant-a',userId:'user-a',conversationId:'00000000-0000-4000-8000-000000000001',logicalRequestId:'request-a',runtime:{provider:'openrouter',model:'provider/model:free',ollamaThink:false}};return{prisma,context,rows};}

test('usage recorder persists provider counts and actual response model without request content',async()=>{
  const {prisma,context,rows}=setup();
  await persistUsage(prisma,context,{usage:{inputTokens:13,outputTokens:7,totalTokens:20,cachedInputTokens:2,reasoningTokens:1},actualModel:'provider/actual:free',status:'success',latencyMs:42,source:'test-provider'});
  assert.equal(rows.length,1);assert.equal(rows[0].configuredModelId,context.runtime.model);assert.equal(rows[0].modelId,'provider/actual:free');assert.equal(rows[0].totalTokens,20);assert.equal(rows[0].inputTokens,13);assert.equal(rows[0].outputTokens,7);assert.equal(rows[0].cachedTokens,2);assert.equal(rows[0].accuracy,'provider-reported');assert.equal(rows[0].conversationId,context.conversationId);assert.equal('prompt'in rows[0],false);assert.equal('content'in rows[0],false);
});

test('usage recorder tags each invocation with its model role',async()=>{
  const {prisma,context,rows}=setup();context.runtime.role='PLANNER';await persistUsage(prisma,context,{status:'success',latencyMs:1,source:'test'});assert.equal(rows[0].role,'PLANNER');
});

test('unavailable usage stays null and recorder persistence failures do not affect generation',async()=>{
  const {prisma,context,rows}=setup();await persistUsage(prisma,context,{status:'failed',latencyMs:5,source:'test-provider',error:new Error('failure')});assert.equal(rows[0].inputTokens,null);assert.equal(rows[0].outputTokens,null);assert.equal(rows[0].totalTokens,null);assert.equal(rows[0].accuracy,'unavailable');
  const broken={llmUsage:{create:async()=>{throw new Error('db down');}}} as unknown as PrismaService;await assert.doesNotReject(()=>persistUsage(broken,context,{status:'success',latencyMs:1,source:'test'}));
});

test('usage write failures emit a structured warning without record values',async()=>{
  const broken={llmUsage:{create:async()=>{throw new Error('sensitive database detail');}}} as unknown as PrismaService;
  const warnings:string[]=[];const warn=console.warn;console.warn=(message?:unknown)=>warnings.push(String(message));
  try{await persistUsageEvent(broken,{userId:'private-user',prompt:'private prompt'});}finally{console.warn=warn;}
  assert.deepEqual(warnings.map(value=>JSON.parse(value)),[{event:'llm_usage_persistence_failed',errorType:'Error'}]);
});

test('runtime resolver observes a new database model snapshot on the next request',async()=>{
  let provider='ollama',selected='qwen3:4b-instruct-2507-q4_K_M';const prisma:any={runtimeSetting:{findMany:async()=>[{key:'MASTRA_PROVIDER',value:provider},{key:'MASTRA_MODEL',value:selected},{key:'OLLAMA_THINK',value:'false'}]},registeredModel:{findUnique:async({where}:any)=>where.provider_modelId.provider===provider&&where.provider_modelId.modelId===selected?{enabled:true,available:true,compatible:true}:null}};
  const first=await resolveRuntimeModel(prisma);selected='qwen3:8b';const second=await resolveRuntimeModel(prisma);provider='openrouter';selected='provider/model-a:free';const third=await resolveRuntimeModel(prisma);selected='provider/model-b:free';const fourth=await resolveRuntimeModel(prisma);assert.equal(first.model,'qwen3:4b-instruct-2507-q4_K_M');assert.equal(second.model,'qwen3:8b');assert.equal(third.provider,'openrouter');assert.equal(third.model,'provider/model-a:free');assert.equal(fourth.model,'provider/model-b:free');
});

test('runtime resolver selects planner and answer models independently and keeps a request snapshot',async()=>{
  const values:any={MASTRA_PROVIDER:'ollama',MASTRA_MODEL:'shared',PLANNER_PROVIDER:'google',PLANNER_MODEL:'gemini-test',ANSWER_PROVIDER:'ollama',ANSWER_MODEL:'answer-v1',ANSWER_MAX_OUTPUT_TOKENS:'384',ANSWER_MAX_CONTEXT_CHARS:'8000',AGENT_REQUEST_TIMEOUT_MS:'180000'};
  const prisma:any={runtimeSetting:{findMany:async()=>Object.entries(values).map(([key,value])=>({key,value}))},registeredModel:{findUnique:async({where}:any)=>({enabled:true,available:true,compatible:true,provider:where.provider_modelId.provider,modelId:where.provider_modelId.modelId})}};
  const snapshot=await resolveRuntimeModels(prisma);assert.equal(snapshot.planner.provider,'google');assert.equal(snapshot.planner.model,'gemini-test');assert.equal(snapshot.answer.provider,'ollama');assert.equal(snapshot.answer.model,'answer-v1');assert.equal(snapshot.answer.maxOutputTokens,384);assert.equal(snapshot.answer.maxContextChars,8000);assert.equal(modelRequestTimeoutMs(snapshot.answer),180000);assert.equal(modelRequestTimeoutMs(snapshot.planner),180000);assert.equal(modelForRole(snapshot,'PLANNER').model,'gemini-test');assert.equal(modelForRole(snapshot,'ANSWER').model,'answer-v1');
  values.PLANNER_MODEL='gemini-next';const next=await resolveRuntimeModels(prisma);assert.equal(modelForRole(snapshot,'PLANNER').model,'gemini-test');assert.equal(next.planner.model,'gemini-next');
  delete values.PLANNER_PROVIDER;delete values.PLANNER_MODEL;delete values.ANSWER_PROVIDER;delete values.ANSWER_MODEL;const legacy=await resolveRuntimeModels(prisma);assert.equal(legacy.planner.provider,'ollama');assert.equal(legacy.answer.model,'shared');
});

test('an unset role output budget follows provider defaults and a known model maximum is enforced',async()=>{
  const values:any={MASTRA_PROVIDER:'ollama',MASTRA_MODEL:'shared',PLANNER_PROVIDER:'google',PLANNER_MODEL:'gemini-test',ANSWER_PROVIDER:'openai',ANSWER_MODEL:'gpt-test',PLANNER_MAX_OUTPUT_TOKENS:'',ANSWER_MAX_OUTPUT_TOKENS:''};
  const prisma:any={runtimeSetting:{findMany:async()=>Object.entries(values).map(([key,value])=>({key,value}))},registeredModel:{findUnique:async({where}:any)=>({enabled:true,available:true,compatible:true,capabilities:{maxOutputTokens:8192},provider:where.provider_modelId.provider,modelId:where.provider_modelId.modelId})}};
  const snapshot=await resolveRuntimeModels(prisma);assert.equal(snapshot.planner.maxOutputTokens,undefined);assert.equal(snapshot.answer.maxOutputTokens,undefined);
  values.PLANNER_MAX_OUTPUT_TOKENS='9000';await assert.rejects(resolveRuntimeModels(prisma),/OUTPUT_TOKEN_LIMIT_EXCEEDS_MODEL_MAXIMUM/);
});
