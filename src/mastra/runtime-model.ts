import type { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { effectiveCredential, type CloudProvider } from '../llm-admin/provider-credentials.js';

export interface RuntimeModelSnapshot { provider:string; model:string; fallback?:string; ollamaThink:boolean; apiKey?:string; }

/** Read authoritative settings for every logical request; never cache across requests/instances. */
export async function resolveRuntimeModel(prisma:PrismaService):Promise<RuntimeModelSnapshot>{
  if(!(prisma as any).runtimeSetting||!(prisma as any).registeredModel)return {provider:config.modelProvider,model:config.model,fallback:config.modelFallback,ollamaThink:config.ollamaThink};
  const rows=await prisma.runtimeSetting.findMany({where:{key:{in:['MASTRA_PROVIDER','MASTRA_MODEL','MASTRA_FALLBACK_MODEL','OLLAMA_THINK']}}});
  const v=Object.fromEntries(rows.map(r=>[r.key,r.value]));
  const provider=v.MASTRA_PROVIDER??config.modelProvider; const model=v.MASTRA_MODEL??config.model;
  const registered=await prisma.registeredModel.findUnique({where:{provider_modelId:{provider,modelId:model}}});
  if(rows.length && (!registered||!registered.enabled||!registered.available||!registered.compatible)) throw new Error('ACTIVE_MODEL_UNAVAILABLE');
  const fallback=v.MASTRA_FALLBACK_MODEL||undefined;
  if(fallback){const row=await prisma.registeredModel.findUnique({where:{provider_modelId:{provider,modelId:fallback}}});if(!row?.available||!row.compatible)throw new Error('FALLBACK_MODEL_UNAVAILABLE');}
  const apiKey = ['google','openrouter','openai'].includes(provider)
    ? (await effectiveCredential(prisma, provider as CloudProvider)).key
    : undefined;
  return {provider,model,fallback,ollamaThink:(v.OLLAMA_THINK??String(config.ollamaThink))==='true',apiKey};
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
