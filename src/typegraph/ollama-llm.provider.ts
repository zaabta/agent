import type { LLMGenerateOptions, LLMProvider } from '@typegraph-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { currentUsageContext, persistUsage } from '../llm-admin/usage-recorder.js';
import type { PrismaService } from '../prisma/prisma.service.js';

interface OllamaChatResponse { model?:string; message?: { content?: string }; error?: string; prompt_eval_count?:number; eval_count?:number }

/** Local-only TypeGraph extraction provider. It never calls OpenRouter or a hosted service. */
export class OllamaTypegraphLlmProvider implements LLMProvider {
  private prisma?:PrismaService;
  setUsagePersistence(prisma:PrismaService){this.prisma=prisma;}
  async generateText(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<string> {
    const result = await this.chat(prompt, systemPrompt, options, false);
    if (typeof result.message?.content !== 'string') throw new Error('OLLAMA_TYPEGRAPH_LLM_EMPTY_RESPONSE');
    return result.message.content;
  }

  async generateJSON<T = unknown>(prompt: string, systemPrompt?: string, options?: LLMGenerateOptions): Promise<T> {
    const result = await this.chat(prompt, systemPrompt, options, true);
    const text = result.message?.content;
    if (typeof text !== 'string') throw new Error('OLLAMA_TYPEGRAPH_LLM_EMPTY_RESPONSE');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (cause) { throw new Error('OLLAMA_TYPEGRAPH_LLM_INVALID_JSON', { cause }); }
    const schema = options?.schema as { safeParse?: (value: unknown) => { success: boolean; data?: T } } | undefined;
    if (schema?.safeParse) {
      const validated = schema.safeParse(parsed);
      if (!validated.success) throw new Error('OLLAMA_TYPEGRAPH_LLM_SCHEMA_MISMATCH');
      return validated.data as T;
    }
    return parsed as T;
  }

  private async chat(prompt: string, systemPrompt: string | undefined, options: LLMGenerateOptions | undefined, json: boolean) {
    const started=performance.now();const invocationId=crypto.randomUUID();let status:'success'|'failed'='success';let payload:OllamaChatResponse|undefined;let failure:unknown;
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: prompt },
    ];
    const schema = options?.schema as z.ZodType | undefined;
    const format = json && schema?.safeParse ? z.toJSONSchema(schema) : json ? 'json' : undefined;
    try { const response = await fetch(`${config.ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, stream: false, think: config.ollamaThink, ...(format ? { format } : {}), options: { num_predict: Math.min(options?.maxOutputTokens ?? 512, 512), temperature: 0 } }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`OLLAMA_TYPEGRAPH_LLM_UNAVAILABLE: ${response.status}`);
    payload = await response.json() as OllamaChatResponse;
    if (payload.error) throw new Error(`OLLAMA_TYPEGRAPH_LLM_ERROR: ${payload.error.slice(0, 200)}`);
    return payload;
    } catch(error){status='failed';failure=error;throw error;} finally {
      const context=currentUsageContext();if(context&&this.prisma){const input=Number.isInteger(payload?.prompt_eval_count)?payload!.prompt_eval_count!:null;const output=Number.isInteger(payload?.eval_count)?payload!.eval_count!:null;await persistUsage(this.prisma,{...context,runtime:{provider:'ollama',model:config.model,ollamaThink:config.ollamaThink}},{invocationId,usage:input===null&&output===null?undefined:{inputTokens:input,outputTokens:output,totalTokens:input!==null&&output!==null?input+output:undefined,modelId:payload?.model},status,latencyMs:performance.now()-started,source:'ollama-api-chat',actualModel:payload?.model,error:failure});}
    }
  }
}

export const ollamaTypegraphLlm = new OllamaTypegraphLlmProvider();
