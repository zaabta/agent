import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ActiveAgentRunRegistry, AgentRunCapacityError } from '../src/agent/active-run-registry.js';

const owner = { userId: 'user-x', tenantId: 'company' };

test('run IDs are opaque UUIDs and registry metadata contains no prompt or token', () => {
  const registry = new ActiveAgentRunRegistry();
  const run = registry.create(owner);
  assert.match(run.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(Object.keys(run).sort(), ['cancelRequested', 'controller', 'ownerId', 'runId', 'settle', 'settled', 'startedAtMs', 'state', 'tenantId'].sort());
});

test('run cancellation is owner and workspace scoped and settles idempotently', async () => {
  const registry = new ActiveAgentRunRegistry(10, 4);
  const run = registry.create(owner);
  registry.bindConversation(run.runId, 'conversation-x');
  assert.equal(registry.getOwned(run.runId, { userId: 'user-y', tenantId: 'company' }), undefined);
  assert.equal(registry.getOwned(run.runId, { userId: 'user-x', tenantId: 'other-company' }), undefined);

  const cancellation = registry.cancel(run);
  assert.equal(run.controller.signal.aborted, true);
  registry.finish(run.runId, 'cancelled');
  const result = await cancellation;
  assert.equal(result.runId, run.runId);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellationRequested, true);
  assert.equal(result.executionSettled, true);
  assert.equal(result.providerStopConfirmed, false);
  assert.equal(typeof result.ackLatencyMs, 'number');
  assert.equal((await registry.cancel(run)).status, 'cancelled');
  assert.equal((await registry.cancel(run)).cancellationRequested, false);
});

test('cancelling one user run leaves another user execution untouched', async () => {
  const registry = new ActiveAgentRunRegistry(10, 2);
  const userX = registry.create(owner);
  const userY = registry.create({ userId: 'user-y', tenantId: 'company' });
  registry.bindConversation(userX.runId, 'conversation-x');
  registry.bindConversation(userY.runId, 'conversation-y');
  const pending = registry.cancel(userX);
  assert.equal(userX.controller.signal.aborted, true);
  assert.equal(userY.controller.signal.aborted, false);
  registry.finish(userX.runId, 'cancelled');
  await pending;
  registry.finish(userY.runId, 'completed');
});

test('completed runs are not aborted and finalizing runs reject late cancellation', async () => {
  const registry = new ActiveAgentRunRegistry();
  const completed = registry.create(owner);
  registry.finish(completed.runId, 'completed');
  assert.equal((await registry.cancel(completed)).status, 'completed');
  assert.equal(completed.controller.signal.aborted, false);

  const finishing = registry.create({ userId: 'user-y', tenantId: 'company' });
  registry.bindConversation(finishing.runId, 'conversation-y');
  registry.beginFinalization(finishing.runId, finishing.controller.signal);
  assert.equal((await registry.cancel(finishing)).status, 'finishing');
  assert.equal(finishing.controller.signal.aborted, false);
});

test('cancellation timeout reports pending without claiming the model stopped', async () => {
  const registry = new ActiveAgentRunRegistry(10, 4, 20, 120_000, 5);
  const run = registry.create(owner);
  registry.bindConversation(run.runId, 'conversation-x');
  const result = await registry.cancel(run);
  assert.equal(result.status, 'cancelling');
  assert.equal(result.cancellationRequested, true);
  assert.equal(result.executionSettled, false);
  assert.equal(result.providerStopConfirmed, false);
  registry.finish(run.runId, 'cancelled');
});

test('active run limits are bounded globally and per user', () => {
  const registry = new ActiveAgentRunRegistry(2, 1, 5);
  registry.create(owner);
  assert.throws(() => registry.create(owner), AgentRunCapacityError);
  registry.create({ userId: 'user-y', tenantId: 'company' });
  assert.throws(() => registry.create({ userId: 'user-z', tenantId: 'company' }), AgentRunCapacityError);
});

test('API shutdown aborts active run signals and waits only for the bounded grace period', async () => {
  const registry = new ActiveAgentRunRegistry();
  const run = registry.create(owner);
  registry.bindConversation(run.runId, 'conversation-x');
  const shutdown = registry.shutdown(100);
  assert.equal(run.controller.signal.aborted, true);
  registry.finish(run.runId, 'failed');
  await shutdown;
  assert.equal(run.state, 'failed');
});
