import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { AgentController } from '../src/agent/agent.controller.js';
import { AgentRequestFailure } from '../src/agent/provider-errors.js';

test('SSE controller emits a safe error and no answer text when LangGraph fails', async () => {
  const agent = {
    stream: async (
      _message: string,
      _conversationId: undefined,
      _signal: AbortSignal,
      write: (event: string, data: Record<string, unknown>) => Promise<void>,
    ) => {
      await write('status', { status: 'started', runId: 'run-a' });
      throw new AgentRequestFailure('CONNECTION_FAILED', { requestId: 'run-a', retryable: true });
    },
  };
  const controller = new AgentController(agent as any);
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    frames: [] as string[],
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
    write(frame: string) {
      this.frames.push(frame);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  await controller.stream({ message: 'Find the report fact' }, response as any, {
    userId: 'user-a',
    tenantId: 'tenant-a',
    authMethod: 'jwt',
  });
  const frames = response.frames.join('');
  assert.match(frames, /event: error\ndata: .*"code":"CONNECTION_FAILED"/);
  assert.doesNotMatch(frames, /event: text-delta/);
  assert.doesNotMatch(frames, /event: done/);
  assert.equal(response.writableEnded, true);
});

test('SSE propagates a sanitized Router catalog failure code without internal details', async () => {
  const agent = {
    stream: async () => {
      throw new AgentRequestFailure('TOOL_CATALOG_FAILED', {
        requestId: 'request-a',
        retryable: true,
      });
    },
  };
  const controller = new AgentController(agent as any);
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    frames: [] as string[],
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
    write(frame: string) {
      this.frames.push(frame);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  await controller.stream({ message: 'Hello' }, response as any, {
    userId: 'user-a',
    tenantId: 'tenant-a',
    authMethod: 'jwt',
  });
  const frames = response.frames.join('');
  assert.match(frames, /event: error\ndata: .*"code":"TOOL_CATALOG_FAILED"/);
  assert.match(frames, /SitePilot could not load the available workspace capabilities/);
  assert.doesNotMatch(frames, /database|password|api.?key|internal/i);
  assert.doesNotMatch(frames, /event: done/);
  assert.equal(response.writableEnded, true);
});
