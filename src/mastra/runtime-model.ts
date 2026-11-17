import type { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { effectiveCredential, type CloudProvider } from '../llm-admin/provider-credentials.js';

export type LlmRole = 'PLANNER' | 'ANSWER';
export interface RuntimeModelSnapshot { provider:string; model:string; fallback?:string; ollamaThink:boolean; apiKey?:string; requestTimeoutMs?:number; maxOutputTokens?:number; role?:LlmRole; }
export interface RuntimeModelRolesSnapshot { planner:RuntimeModelSnapshot; answer:RuntimeModelSnapshot; }
export type RuntimeModelInput = RuntimeModelSnapshot | RuntimeModelRolesSnapshot;

/** Read authoritative settings for every logical request; never cache across requests/instances. */
export async function resolveRuntimeModel(prisma:PrismaService):Promise<RuntimeModelSnapshot>{ return (await resolveRuntimeModels(prisma)).planner; }

export async function resolveRuntimeModels(prisma:PrismaService):Promise<RuntimeModelRolesSnapshot>{
  const fallback={provider:config.modelProvider,model:config.model,fallback:config.modelFallback,ollamaThink:config.ollamaThink,requestTimeoutMs:config.agentTimeoutMs,maxOutputTokens:config.plannerMaxOutputTokens};
  if(!(prisma as any).runtimeSetting||!(prisma as any).registeredModel)return {planner:{...fallback,role:'PLANNER'},answer:{...fallback,role:'ANSWER'}};
  const rows=await prisma.runtimeSetting.findMany({where:{key:{in:['MASTRA_PROVIDER','MASTRA_MODEL','MASTRA_FALLBACK_MODEL','OLLAMA_THINK','AGENT_REQUEST_TIMEOUT_MS','PLANNER_PROVIDER','PLANNER_MODEL','ANSWER_PROVIDER','ANSWER_MODEL','PLANNER_MAX_OUTPUT_TOKENS']}}});
  const v=Object.fromEntries(rows.map(r=>[r.key,r.value]));
  const sharedProvider=v.MASTRA_PROVIDER??config.modelProvider, sharedModel=v.MASTRA_MODEL??config.model;
  const make=async(role:LlmRole):Promise<RuntimeModelSnapshot>=>{
    const configured=v[`${role}_PROVIDER`]!==undefined&&v[`${role}_MODEL`]!==undefined;
    const provider=configured?v[`${role}_PROVIDER`]:sharedProvider, model=configured?v[`${role}_MODEL`]:sharedModel;
    const registered=await prisma.registeredModel.findUnique({where:{provider_modelId:{provider,modelId:model}}});
    if(rows.length && (!registered||!registered.enabled||!registered.available||!registered.compatible)) throw new Error('ACTIVE_MODEL_UNAVAILABLE');
    const fallback=provider===sharedProvider&&model===sharedModel?(v.MASTRA_FALLBACK_MODEL||undefined):undefined;
    if(fallback){const row=await prisma.registeredModel.findUnique({where:{provider_modelId:{provider,modelId:fallback}}});if(!row?.available||!row.compatible)throw new Error('FALLBACK_MODEL_UNAVAILABLE');}
    const apiKey=['google','openrouter','openai'].includes(provider)?(await effectiveCredential(prisma,provider as CloudProvider)).key:undefined;
    return {provider,model,fallback,ollamaThink:(v.OLLAMA_THINK??String(config.ollamaThink))==='true',apiKey,requestTimeoutMs:Number(v.AGENT_REQUEST_TIMEOUT_MS??config.agentTimeoutMs),...(role==='PLANNER'?{maxOutputTokens:Number(v.PLANNER_MAX_OUTPUT_TOKENS??config.plannerMaxOutputTokens)}:{}),role};
  };
  const [planner,answer]=await Promise.all([make('PLANNER'),make('ANSWER')]); return {planner,answer};
}

export function modelForRole(runtime:RuntimeModelInput|undefined,role:LlmRole):RuntimeModelSnapshot {
  if(runtime&&'planner' in runtime)return role==='PLANNER'?runtime.planner:runtime.answer;
  return {...(runtime??{provider:config.modelProvider,model:config.model,fallback:config.modelFallback,ollamaThink:config.ollamaThink}),role};
}

function providerModel(provider:string,id:string,apiKey?:string) {
  if(provider==='ollama')return {providerId:'ollama',modelId:id,url:`${config.ollamaUrl.replace(/\/+$/,'')}/v1`,apiKey:'local-ollama',api:'chat' as const};
  if(provider==='google')return apiKey?createGoogleGenerativeAI({apiKey})(id.replace(/^google\//,'')):`google/${id.replace(/^google\//,'')}`;
  if(provider==='openai')return createOpenAI({apiKey}).chat(id.replace(/^openai\//,''));
  if(provider==='openrouter')return apiKey?createOpenAI({name:'openrouter',baseURL:'https://openrouter.ai/api/v1',apiKey}).chat(id.replace(/^openrouter\//,'')):`openrouter/${id.replace(/^openrouter\//,'')}`;
  return id;
}

export function asMastraModel(snapshot:RuntimeModelSnapshot){
  return {primary:providerModel(snapshot.provider,snapshot.model,snapshot.apiKey),fallback:snapshot.fallback?providerModel(snapshot.provider,snapshot.fallback,snapshot.apiKey):undefined};
}
