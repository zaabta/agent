import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthPrincipal } from '../src/auth/auth.types.js';
import { createSemanticRouter, type RouterState } from '../src/agent/semantic-router.js';
import type { RouterModel } from '../src/agent/graph-model-types.js';
import { safeAgentFailure } from '../src/agent/provider-errors.js';

const principal: AuthPrincipal = { userId: 'user-a', tenantId: 'tenant-a', authMethod: 'jwt' };
const runtime = {
  router: { provider: 'openai', model: 'router-test', apiKey: 'private-api-key', ollamaThink: false },
};

function state(overrides: Partial<RouterState> = {}): RouterState {
  return {
    message: 'Hello',
    history: [],
    principal,
    signal: new AbortController().signal,
    requestId: 'request-a',
    runtime,
    llmCalls: 0,
    ...overrides,
  };
}

function model(invoke: () => Promise<unknown>, setup?: () => unknown): RouterModel {
  return {
    withStructuredOutput: () => {
      setup?.();
      return { invoke };
    },
  };
}

async function withCapturedErrors<T>(operation: (messages: string[]) => Promise<T>): Promise<T> {
  const messages: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    return await operation(messages);
  } finally {
    console.error = original;
  }
}

const catalog = async () => [];
const privacy = { mask: (value: string) => value };

test('semantic router succeeds for ordinary conversation and reports its configured role', async () => {
  let completed = false;
  let usageRole = '';
  const router = createSemanticRouter({
    catalog,
    privacy,
    model: model(async () => ({ parsed: { route: 'conversation', contextRelevant: false } })),
    onUsage: (record) => {
      usageRole = record.role;
    },
  });
  const result = await router(
    state({
      progress: (_event, data) => {
        if (data.status === 'completed') completed = true;
      },
    }),
  );
  assert.equal(result.route, 'conversation');
  assert.equal(usageRole, 'ROUTER');
  assert.equal(completed, true);
});

test('catalog loading failure is logged safely and classified for SSE', async () => {
  await withCapturedErrors(async (messages) => {
    const router = createSemanticRouter({
      catalog: async () => {
        throw new Error('database detail includes private information');
      },
      privacy,
    });
    await assert.rejects(router(state()), (error) => {
      assert.equal(safeAgentFailure(error)?.code, 'TOOL_CATALOG_FAILED');
      assert.equal(safeAgentFailure(error)?.retryable, true);
      return true;
    });
    const log = JSON.parse(messages[0]!);
    assert.equal(log.phase, 'catalog-loading');
    assert.equal(log.requestId, 'request-a');
    assert.equal(log.provider, 'openai');
    assert.equal(log.model, 'router-test');
    assert.equal(log.errorCode, 'TOOL_CATALOG_FAILED');
    assert.equal(typeof log.durationMs, 'number');
    assert.doesNotMatch(messages.join(''), /database detail|private information|private-api-key|Hello/);
  });
});

test('model construction failures receive a safe configuration code', async () => {
  const router = createSemanticRouter({ catalog, privacy });
  await withCapturedErrors(async (messages) => {
    await assert.rejects(
      router(state({ runtime: { router: { ...runtime.router, provider: 'unsupported-provider' } } })),
      (error) => {
        assert.equal(safeAgentFailure(error)?.code, 'MODEL_CONFIGURATION_FAILED');
        return true;
      },
    );
    assert.equal(JSON.parse(messages[0]!).phase, 'model-construction');
  });
});

test('structured-output setup failure is classified without leaking exception text', async () => {
  await withCapturedErrors(async (messages) => {
    const router = createSemanticRouter({
      catalog,
      privacy,
      model: model(
        async () => ({ parsed: { route: 'conversation', contextRelevant: false } }),
        () => {
          throw new Error('schema internals with private details');
        },
      ),
    });
    await assert.rejects(router(state()), (error) => {
      assert.equal(safeAgentFailure(error)?.code, 'MODEL_CONFIGURATION_FAILED');
      return true;
    });
    assert.equal(JSON.parse(messages[0]!).phase, 'structured-output-setup');
    assert.doesNotMatch(messages.join(''), /schema internals|private details/);
  });
});

test('provider invocation errors classify unsupported model parameters safely', async () => {
  await withCapturedErrors(async (messages) => {
    const router = createSemanticRouter({
      catalog,
      privacy,
      model: model(async () => {
        throw {
          statusCode: 400,
          code: 'unsupported_value',
          message: 'temperature value and private provider payload',
        };
      }),
    });
    await assert.rejects(router(state()), (error) => {
      assert.equal(safeAgentFailure(error)?.code, 'UNSUPPORTED_MODEL_PARAMETER');
      return true;
    });
    const log = JSON.parse(messages.find((message) => message.includes('model-invocation'))!);
    assert.equal(log.httpStatus, 400);
    assert.equal(log.errorCode, 'UNSUPPORTED_MODEL_PARAMETER');
    assert.doesNotMatch(messages.join(''), /private provider payload|temperature value/);
  });
});

test('invalid structured Router response maps to INVALID_MODEL_OUTPUT', async () => {
  await withCapturedErrors(async (messages) => {
    const router = createSemanticRouter({
      catalog,
      privacy,
      model: model(async () => ({ parsed: { route: 'maybe' } })),
    });
    await assert.rejects(router(state()), (error) => {
      assert.equal(safeAgentFailure(error)?.code, 'INVALID_MODEL_OUTPUT');
      return true;
    });
    assert.equal(JSON.parse(messages[0]!).phase, 'response-validation');
  });
});

test('usage tracking failures are logged safely and do not fail a valid route', async () => {
  await withCapturedErrors(async (messages) => {
    let completed = false;
    const router = createSemanticRouter({
      catalog,
      privacy,
      model: model(async () => ({ parsed: { route: 'conversation', contextRelevant: false } })),
      onUsage: async () => {
        throw new Error('database includes a private value');
      },
    });
    const result = await router(
      state({
        progress: (_event, data) => {
          if (data.status === 'completed') completed = true;
        },
      }),
    );
    assert.equal(result.route, 'conversation');
    assert.equal(completed, true);
    const log = JSON.parse(messages[0]!);
    assert.equal(log.phase, 'usage-tracking');
    assert.equal(log.errorCode, 'USAGE_TRACKING_FAILED');
    assert.doesNotMatch(messages.join(''), /private value|Hello|private-api-key/);
  });
});
