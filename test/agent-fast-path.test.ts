import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDocumentInventoryIntent } from '../src/agent/request-fast-path.js';
import { needsWorkspaceRecovery } from '../src/agent/agent.service.js';

test('only explicit workspace inventory requests use deterministic routing', () => {
  for (const question of ['List my documents', 'Show all workspace files', 'Belgelerimi listele', '\u0627\u0639\u0631\u0636 \u0643\u0644 \u0627\u0644\u0645\u0633\u062A\u0646\u062F\u0627\u062A']) {
    assert.equal(isDocumentInventoryIntent(question), true, question);
  }
  for (const question of [
    'Who leads the sustainability initiative?',
    'How many late shipments were recorded?',
    '?? ????? ??? ?????????',
    'Proje lideri kim?',
    'What is the approved project budget?',
    'Can you help me draft an email?',
  ]) {
    assert.equal(isDocumentInventoryIntent(question), false, question);
  }
});

test('workspace recovery depends on evidence results, not question wording', () => {
  assert.equal(needsWorkspaceRecovery([]), true);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'document-search', result: { hits: [] } } }]), true);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'document-search', result: { hits: [{ sourceRef: 'source-a' }] } } }]), false);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'structured-data-analytics', result: { sources: [{ sourceRef: 'source-b' }] } } }]), false);
});
