import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Embedder, EmbedInput } from '@typegraph-ai/sdk';
import { config } from '../config.js';

interface OllamaEmbedResponse {
  embeddings?: unknown;
}
export interface EmbeddingBatchProgress { done: number; total: number }

@Injectable()
export class EmbeddingsService implements Embedder, OnModuleDestroy {
  readonly name = `ollama/${config.embedModel}`;
  readonly dimensions = config.embedDimensions;
  readonly maxBatchSize = 32;
  readonly supportsAsymmetric = false;
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly requestTiming = new AsyncLocalStorage<{ intervals: Array<[number, number]>; abortSignal?: AbortSignal; onEmbeddingProgress?: (progress: EmbeddingBatchProgress) => void }>();

  async measure<T>(operation: () => Promise<T>, abortSignal?: AbortSignal, onEmbeddingProgress?: (progress: EmbeddingBatchProgress) => void): Promise<{ result: T; embeddingMs: number }> {
    const timing = { intervals: [] as Array<[number, number]>, abortSignal, onEmbeddingProgress };
    const result = await this.requestTiming.run(timing, operation);
    // Embed calls may overlap inside TypeGraph. Sum would double-count that
    // time and can exceed the request duration, so measure the union of active
    // embedding intervals for an accurate wall-time contribution.
    const intervals = timing.intervals.sort((left, right) => left[0] - right[0]);
    let embeddingMs = 0;
    let intervalStart: number | undefined;
    let intervalEnd: number | undefined;
    for (const [start, end] of intervals) {
      if (intervalStart === undefined || intervalEnd === undefined) {
        intervalStart = start; intervalEnd = end;
      } else if (start <= intervalEnd) intervalEnd = Math.max(intervalEnd, end);
      else { embeddingMs += intervalEnd - intervalStart; intervalStart = start; intervalEnd = end; }
    }
    if (intervalStart !== undefined && intervalEnd !== undefined) embeddingMs += intervalEnd - intervalStart;
    return { result, embeddingMs: Math.round(embeddingMs) };
  }

  async embed({ texts, abortSignal }: EmbedInput): Promise<number[][]> {
    const startedAt = performance.now();
    // TypeGraph SDK 0.6 accepts abortSignal on document.ingest but does not
    // propagate it to custom Embedder.embed calls. Preserve cancellation across
    // the SDK's async work using this request-local context.
    const signal = abortSignal ?? this.requestTiming.getStore()?.abortSignal;
    try {
    if (!Number.isInteger(this.dimensions) || this.dimensions < 1) {
      throw new Error(`Invalid OLLAMA_EMBED_DIMENSIONS: ${this.dimensions}`);
    }
    if (texts.length === 0) return [];

    const results: number[][] = [];
    let completed = 0;
    this.requestTiming.getStore()?.onEmbeddingProgress?.({ done: 0, total: texts.length });
    for (let offset = 0; offset < texts.length; offset += this.maxBatchSize) {
      const batch = texts.slice(offset, offset + this.maxBatchSize);
      results.push(...await this.embedBatch(batch, signal));
      completed += batch.length;
      this.requestTiming.getStore()?.onEmbeddingProgress?.({ done: completed, total: texts.length });
    }
    return results;
    } finally {
      const timing = this.requestTiming.getStore();
      if (timing) timing.intervals.push([startedAt, performance.now()]);
    }
  }

  private async embedBatch(texts: string[], abortSignal?: AbortSignal): Promise<number[][]> {
    const endpoint = `${config.ollamaUrl.replace(/\/+$/, '')}/api/embed`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.embedModel, input: texts }),
        signal: abortSignal,
      });
    } catch (cause) {
      this.logger.error(`Ollama embedding request failed at ${endpoint}`);
      throw new Error(`LOCAL_EMBEDDING_PROVIDER_UNAVAILABLE: ${config.embedModel}`, { cause });
    }

    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`LOCAL_EMBEDDING_PROVIDER_ERROR (${response.status}): ${details}`);
    }

    let payload: OllamaEmbedResponse;
    try {
      payload = await response.json() as OllamaEmbedResponse;
    } catch (cause) {
      throw new Error('LOCAL_EMBEDDING_INVALID_RESPONSE: response was not JSON', { cause });
    }
    if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
      throw new Error(`LOCAL_EMBEDDING_INVALID_RESPONSE: expected ${texts.length} embeddings`);
    }

    return payload.embeddings.map((embedding, index) => {
      if (!Array.isArray(embedding) || embedding.length !== this.dimensions ||
        !embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
        const actual = Array.isArray(embedding) ? embedding.length : 'non-array';
        throw new Error(`LOCAL_EMBEDDING_INVALID_DIMENSIONS: ${this.name} expected ${this.dimensions}, received ${actual} for item ${index}`);
      }
      return embedding as number[];
    });
  }

  onModuleDestroy(): void {
    // Ollama is an external local service; there are no persistent resources to close.
  }
}
