import { BadRequestException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';

const defaults: Record<string,string> = { MASTRA_PROVIDER:config.modelProvider, MASTRA_MODEL:config.model, MASTRA_FALLBACK_MODEL:config.modelFallback??'', OLLAMA_THINK:String(config.ollamaThink), AGENT_HISTORY_MESSAGES:String(config.conversationHistoryMessages), AGENT_HISTORY_MESSAGE_CHARS:String(config.conversationHistoryChars), AGENT_REQUEST_TIMEOUT_MS:String(config.agentTimeoutMs), TYPEGRAPH_MIN_SCORE:String(config.typegraphMinScore) };
@Injectable()
export class LlmAdminService implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  onModuleInit(){ return this.initialize(); }
  async initialize() {
    for (const [key,value] of Object.entries(defaults)) await this.prisma.runtimeSetting.upsert({where:{key},create:{key,value},update:{}});
    if(defaults.MASTRA_PROVIDER==='ollama'){
      try{const tags=await fetch(`${config.ollamaUrl.replace(/\/+$/,'')}/api/tags`,{signal:AbortSignal.timeout(5000)});const installed=tags.ok&&(((await tags.json() as any).models??[]).some((m:any)=>m.name===defaults.MASTRA_MODEL));if(installed){const show=await fetch(`${config.ollamaUrl.replace(/\/+$/,'')}/api/show`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:defaults.MASTRA_MODEL}),signal:AbortSignal.timeout(5000)});const capabilities=show.ok?(await show.json() as any).capabilities??[]:[];await this.prisma.registeredModel.upsert({where:{provider_modelId:{provider:'ollama',modelId:defaults.MASTRA_MODEL}},create:{provider:'ollama',modelId:defaults.MASTRA_MODEL,source:'environment',compatible:capabilities.includes('tools')},update:{available:true,compatible:capabilities.includes('tools')}});}}catch{}
    } else await this.register(defaults.MASTRA_PROVIDER, defaults.MASTRA_MODEL, 'environment');
    if (process.env.GEMINI_API_KEY) await this.register('google',process.env.GEMINI_MODEL_ID||'google/gemini-3.6-flash','environment');
  }
  private async register(provider:string,modelId:string,source='manual') { return this.prisma.registeredModel.upsert({where:{provider_modelId:{provider,modelId}},create:{provider,modelId,source},update:{}}); }
  async settings() { const rows=await this.prisma.runtimeSetting.findMany(); const values=Object.fromEntries(rows.map(x=>[x.key,x.value])); return {settings:Object.fromEntries(Object.keys(defaults).map(k=>[k,values[k]??defaults[k]])),secrets:{geminiConfigured:!!process.env.GEMINI_API_KEY,openrouterConfigured:!!process.env.OPENROUTER_API_KEY}}; }
  async updateSettings(input:Record<string,unknown>,userId:string) {
    const targetProvider=String(input.MASTRA_PROVIDER??(await this.settings()).settings.MASTRA_PROVIDER);
    const targetModel=String(input.MASTRA_MODEL??(await this.settings()).settings.MASTRA_MODEL);
    if(input.MASTRA_PROVIDER!==undefined||input.MASTRA_MODEL!==undefined){const model=await this.prisma.registeredModel.findUnique({where:{provider_modelId:{provider:targetProvider,modelId:targetModel}}});if(!model?.available||!model.compatible)throw new BadRequestException('MODEL_NOT_REGISTERED_OR_INCOMPATIBLE');}
    if(typeof input.MASTRA_FALLBACK_MODEL==='string'&&input.MASTRA_FALLBACK_MODEL){const fallback=await this.prisma.registeredModel.findUnique({where:{provider_modelId:{provider:targetProvider,modelId:input.MASTRA_FALLBACK_MODEL}}});if(!fallback?.available||!fallback.compatible)throw new BadRequestException('FALLBACK_MODEL_NOT_REGISTERED_OR_INCOMPATIBLE');}
    const writes:any[]=[];
    for(const [key,value] of Object.entries(input)) {
      if(!(key in defaults)||typeof value!=='string'||value.length>300) throw new BadRequestException('INVALID_RUNTIME_SETTING');
      if(key==='MASTRA_PROVIDER'&&!['google','ollama','openrouter'].includes(value)) throw new BadRequestException('INVALID_PROVIDER');
      writes.push(this.prisma.runtimeSetting.upsert({where:{key},create:{key,value,updatedBy:userId},update:{value,updatedBy:userId}}));
    }
    await this.prisma.$transaction(writes); return this.settings();
  }
  async discover() {
    const models:Array<{provider:string;modelId:string;displayName?:string;source:string;compatible?:boolean}> = [];
    try { const r=await fetch(`${config.ollamaUrl.replace(/\/+$/,'')}/api/tags`,{signal:AbortSignal.timeout(8000)}); if(r.ok) for(const m of (await r.json() as any).models??[]) {let compatible=false;try{const show=await fetch(`${config.ollamaUrl.replace(/\/+$/,'')}/api/show`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:m.name}),signal:AbortSignal.timeout(8000)});if(show.ok)compatible=((await show.json() as any).capabilities??[]).includes('tools');}catch{} models.push({provider:'ollama',modelId:m.name,displayName:m.name,source:'ollama',compatible});} } catch {}
    try { const r=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(8000)}); if(r.ok) for(const m of (await r.json() as any).data??[]) if(m.id&&(m.id.endsWith(':free')||(m.pricing?.prompt==='0'&&m.pricing?.completion==='0'))) {const p=m.supported_parameters??[];models.push({provider:'openrouter',modelId:m.id,displayName:m.name,source:'openrouter',compatible:p.includes('tools')&&(p.includes('response_format')||p.includes('structured_outputs'))});} } catch {}
    if(process.env.GEMINI_API_KEY) models.push({provider:'google',modelId:process.env.GEMINI_MODEL_ID||'google/gemini-3.6-flash',source:'environment'});
    for(const m of models) await this.prisma.registeredModel.upsert({where:{provider_modelId:{provider:m.provider,modelId:m.modelId}},create:m,update:{available:true,displayName:m.displayName,compatible:m.compatible??true}});
    return this.prisma.registeredModel.findMany({orderBy:[{provider:'asc'},{modelId:'asc'}]});
  }
  async addModel(provider:string,modelId:string) { if(provider!=='google'||!modelId||modelId.length>250||/\s/.test(modelId)) throw new BadRequestException('ONLY_GEMINI_MODELS_MAY_BE_ADDED_MANUALLY'); if(!/^(google\/)?[A-Za-z0-9._-]+$/.test(modelId)) throw new BadRequestException('INVALID_GEMINI_MODEL_ID'); return this.register(provider,modelId); }
  async analytics(tenantId:string,from:Date,to:Date,groupBy:string,provider?:string,modelId?:string) {
    if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to) throw new BadRequestException('INVALID_DATE_RANGE');
    const istanbulLocalTimestamp="(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')";
    const dimensions=groupBy==='provider'?'provider':groupBy==='model'?'provider, model_id':`date_trunc('day', ${istanbulLocalTimestamp})`;
    const bucket=groupBy==='provider'?"provider":groupBy==='model'?"provider || '/' || model_id":`to_char(date_trunc('day', ${istanbulLocalTimestamp}), 'YYYY-MM-DD')`;
    const sql=`SELECT ${bucket} AS period, ${groupBy==='date'?'NULL::text':'provider'} AS provider, ${groupBy==='model'?'model_id':'NULL::text'} AS "modelId", COUNT(*)::int AS invocations, SUM(input_tokens)::bigint AS "inputTokens", SUM(output_tokens)::bigint AS "outputTokens", SUM(total_tokens)::bigint AS "totalTokens", SUM(cached_tokens)::bigint AS "cachedTokens", SUM(reasoning_tokens)::bigint AS "reasoningTokens", COUNT(*) FILTER (WHERE total_tokens IS NULL)::int AS "missingUsageCount", ROUND(AVG(latency_ms))::int AS "averageLatencyMs" FROM llm_usage WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3 AND ($4::text IS NULL OR provider=$4) AND ($5::text IS NULL OR model_id=$5) GROUP BY ${dimensions} ORDER BY period`;
    const data=await this.prisma.$queryRawUnsafe<any[]>(sql,tenantId,from,to,provider??null,modelId??null);
    return {timezone:'Europe/Istanbul',from:from.toISOString(),to:to.toISOString(),groupBy,data:data.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?Number(v):v])))};
  }
}
