import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RuntimeModelSnapshot } from '../mastra/runtime-model.js';

export interface UsageContext { tenantId:string; userId?:string; conversationId?:string; logicalRequestId:string; runtime:RuntimeModelSnapshot; prisma?:PrismaService; }
const usageContext = new AsyncLocalStorage<UsageContext>();
export function runWithUsageContext<T>(context:UsageContext,operation:()=>Promise<T>):Promise<T>{return usageContext.run(context,operation);}
export function currentUsageContext(){return usageContext.getStore();}
export function reportedUsage(value:any){
  const usage=value?.totalUsage??value?.usage??value?.payload?.output?.usage??value?.output?.usage;
  return usage&&typeof usage==='object'?usage:undefined;
}
export async function persistUsageEvent(prisma:PrismaService,record:Record<string,unknown>){try{await prisma.llmUsage.create({data:record as any});}catch{/* Analytics persistence cannot fail generation. */}}
export async function persistUsage(prisma:PrismaService,context:UsageContext,detail:{invocationId?:string;usage?:any;status:'success'|'failed';latencyMs:number|null;source:string;actualModel?:string;error?:unknown}){
  const usage=detail.usage;
  const hasCounts=!!usage&&['inputTokens','outputTokens','totalTokens','cachedInputTokens','cachedTokens','reasoningTokens'].some(key=>Number.isInteger(usage[key]));
  await persistUsageEvent(prisma,{
    tenantId:context.tenantId,userId:context.userId??null,conversationId:context.conversationId??null,logicalRequestId:context.logicalRequestId,
    invocationId:detail.invocationId??randomUUID(),provider:String(usage?.provider??context.runtime.provider),modelId:String(detail.actualModel??usage?.modelId??context.runtime.model),
    inputTokens:Number.isInteger(usage?.inputTokens)?usage.inputTokens:null,outputTokens:Number.isInteger(usage?.outputTokens)?usage.outputTokens:null,
    totalTokens:Number.isInteger(usage?.totalTokens)?usage.totalTokens:Number.isInteger(usage?.inputTokens)&&Number.isInteger(usage?.outputTokens)?usage.inputTokens+usage.outputTokens:null,
    cachedTokens:Number.isInteger(usage?.cachedInputTokens)?usage.cachedInputTokens:Number.isInteger(usage?.cachedTokens)?usage.cachedTokens:null,
    reasoningTokens:Number.isInteger(usage?.reasoningTokens)?usage.reasoningTokens:null,
    usageSource:usage?detail.source:null,accuracy:hasCounts?'provider-reported':'unavailable',status:detail.status,latencyMs:detail.latencyMs===null?null:Math.max(0,Math.round(detail.latencyMs)),
    errorCategory:detail.status==='failed'?(detail.error instanceof Error?detail.error.name:'LLM_ERROR'):null,
  });
}

/** Adds persistence at the agent boundary for the legacy/direct orchestration path. */
export function instrumentAgent<T extends object>(agent:T,prisma:PrismaService,context:UsageContext):T {
  return new Proxy(agent,{get(target,property,receiver){
    const original=Reflect.get(target,property,receiver);
    if(property==='generate'&&typeof original==='function')return async (...args:any[])=>{
      const started=performance.now();let result:any;let error:unknown;try{result=await original.apply(target,args);return result;}catch(e){error=e;throw e;}finally{
        const steps=Array.isArray(result?.steps)?result.steps:[];
        if(steps.some((step:any)=>reportedUsage(step))){for(const step of steps){const usage=reportedUsage(step);if(usage)await persistUsage(prisma,context,{usage,status:error?'failed':'success',latencyMs:null,source:'mastra-step',actualModel:step?.response?.modelId,error});}}
        else await persistUsage(prisma,context,{usage:reportedUsage(result)??reportedUsage(error),status:error?'failed':'success',latencyMs:performance.now()-started,source:'mastra-agent',actualModel:result?.response?.modelId,error});
      }
    };
    if(property==='stream'&&typeof original==='function')return async (...args:any[])=>{
      const streamId=randomUUID();const streamStarted=performance.now();let stream:any;try{stream=await original.apply(target,args);}catch(error){await persistUsage(prisma,context,{invocationId:streamId,usage:reportedUsage(error),status:'failed',latencyMs:performance.now()-streamStarted,source:'mastra-stream',error});throw error;}
      const full=stream.fullStream;let wrapped=false;
      return new Proxy(stream,{get(s,p,r){if(p==='fullStream'&&!wrapped){wrapped=true;return (async function*(){let currentId=streamId;let currentStart=performance.now();let settled=false;try{for await(const chunk of full){if(chunk.type==='step-start'){currentId=randomUUID();currentStart=performance.now();settled=false;}if(chunk.type==='step-finish'){const output=chunk.payload?.output;await persistUsage(prisma,context,{invocationId:currentId,usage:reportedUsage(output),status:output?.error?'failed':'success',latencyMs:performance.now()-currentStart,source:'mastra-stream-step',actualModel:output?.response?.modelId,error:output?.error});settled=true;}yield chunk;}if(!settled)await persistUsage(prisma,context,{invocationId:currentId,status:'success',latencyMs:performance.now()-currentStart,source:'mastra-stream'});}catch(error){if(!settled)await persistUsage(prisma,context,{invocationId:currentId,usage:reportedUsage(error),status:'failed',latencyMs:performance.now()-currentStart,source:'mastra-stream',error});throw error;}})();}return Reflect.get(s,p,r);}});
    };
    return original;
  }});
}
