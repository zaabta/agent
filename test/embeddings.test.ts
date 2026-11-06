import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EmbeddingsService } from '../src/typegraph/embeddings.service.js';

test('Ollama embedder batches requests and returns vectors in order', async () => {
  const originalFetch = globalThis.fetch;
  const requestSizes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    requestSizes.push(body.input.length);
    return new Response(JSON.stringify({
      embeddings: body.input.map((_, index) => Array.from({ length: 768 }, () => index)),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const texts = Array.from({ length: 33 }, (_, index) => `text ${index}`);
    const vectors = await new EmbeddingsService().embed({ texts, inputType: 'document' });
    assert.deepEqual(requestSizes, [32, 1]);
    assert.equal(vectors.length, 33);
    assert.equal(vectors[32]?.[0], 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama embedding progress reports only successfully completed batches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({
      embeddings: body.input.map(() => Array.from({ length: 768 }, () => 0.1)),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const progress: Array<{ done: number; total: number }> = [];
    const embeddings = new EmbeddingsService();
    await embeddings.measure(
      () => embeddings.embed({ texts: Array.from({ length: 65 }, (_, index) => `text ${index}`) }),
      undefined,
      event => progress.push(event),
    );
    assert.deepEqual(progress, [{ done: 0, total: 65 }, { done: 32, total: 65 }, { done: 64, total: 65 }, { done: 65, total: 65 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama embedder rejects dimension mismatches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(
      new EmbeddingsService().embed({ texts: ['text'] }),
      /LOCAL_EMBEDDING_INVALID_DIMENSIONS/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama embedder reports provider unavailability clearly', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('connection refused'); };
  try {
    await assert.rejects(
      new EmbeddingsService().embed({ texts: ['text'] }),
      /LOCAL_EMBEDDING_PROVIDER_UNAVAILABLE/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request-scoped embedding measurements stay isolated under concurrency', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    await new Promise(resolve => setTimeout(resolve, body.input[0] === 'slow request' ? 90 : 15));
    return new Response(JSON.stringify({ embeddings: [Array.from({ length: 768 }, () => 0.1)] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const embeddings = new EmbeddingsService();
    const [slow, fast] = await Promise.all([
      embeddings.measure(() => embeddings.embed({ texts: ['slow request'] })),
      embeddings.measure(() => embeddings.embed({ texts: ['fast request'] })),
    ]);
    assert.ok(slow.embeddingMs > fast.embeddingMs + 40, `${slow.embeddingMs} should exceed ${fast.embeddingMs}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
