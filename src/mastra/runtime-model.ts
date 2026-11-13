import type { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';

export interface RuntimeModelSnapshot { provider:string; model:string; fallback?:string; ollamaThink:boolean; }

/** Read authoritative settings for every logical request; never cache across requests/instances. */
export async function resolveRuntimeModel(prisma:PrismaService):Promise<RuntimeModelSnapshot>{
  if(!(prisma as any).runtimeSetting||!(prisma as any).registeredModel)return {provider:config.modelProvider,model:config.model,fallback:config.modelFallback,ollamaThink:config.ollamaThink};
  const rows=await prisma.runtimeSetting.findMany({where:{key:{in:['MASTRA_PROVIDER','MASTRA_MODEL','MASTRA_FALLBACK_MODEL','OLLAMA_THINK']}}});
  const v=Object.fromEntries(rows.map(r=>[r.key,r.value]));
  const provider=v.MASTRA_PROVIDER??config.modelProvider; const model=v.MASTRA_MODEL??config.model;
  const registered=await prisma.registeredModel.findUnique({where:{provider_modelId:{provider,modelId:model}}});
  if(rows.length && (!registered||!registered.available||!registered.compatible)) throw new Error('ACTIVE_MODEL_UNAVAILABLE');
  const fallback=v.MASTRA_FALLBACK_MODEL||undefined;
  if(fallback){const row=await prisma.registeredModel.findUnique({where:{provider_modelId:{provider,modelId:fallback}}});if(!row?.available||!row.compatible)throw new Error('FALLBACK_MODEL_UNAVAILABLE');}
  return {provider,model,fallback,ollamaThink:(v.OLLAMA_THINK??String(config.ollamaThink))==='true'};
}

export function asMastraModel(snapshot:RuntimeModelSnapshot){
  const toModel=(provider:string,id:string)=>provider==='ollama'?{providerId:'ollama',modelId:id,url:`${config.ollamaUrl.replace(/\/+$/,'')}/v1`,apiKey:'local-ollama',api:'chat' as const}:provider==='google'?`google/${id.replace(/^google\//,'')}`:provider==='openrouter'?`openrouter/${id.replace(/^openrouter\//,'')}`:id;
  return {primary:toModel(snapshot.provider,snapshot.model),fallback:snapshot.fallback?toModel(snapshot.provider,snapshot.fallback):undefined};
}
