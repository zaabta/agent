import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentService } from '../src/agent/agent.service.js';

test('citation validator rejects uncited factual output without appending every retrieved source', () => {
  const agent = Object.create(AgentService.prototype) as any;
  const result = agent.validateAnswer('The project leader is Deniz Kaya.', [{ payload: { result: { hits: [
    { citation: { documentId: 'doc-1', filename: 'brief.md', chunkIndex: 0 }, sourceRef: 'brief.md (Leadership)', content: 'Project leader: Deniz Kaya.' },
    { citation: { documentId: 'doc-2', filename: 'budget.csv', chunkIndex: 1 }, sourceRef: 'budget.csv (Sheet1)', content: 'Budget rows.' },
  ] } } }], ['documentSearch']);
  assert.equal(result.citationValidation, 'fallback');
  assert.equal(result.answer, 'I could not produce an answer with verifiable document citations. Please try again.');
  assert.deepEqual(result.sources, []);
});

test('citation validator returns only source references explicitly cited by the answer', () => {
  const agent = Object.create(AgentService.prototype) as any;
  const result = agent.validateAnswer('The project leader is Deniz Kaya [[brief.md (Leadership)]].', [{ payload: { result: { hits: [
    { citation: { documentId: 'doc-1', filename: 'brief.md', chunkIndex: 0 }, sourceRef: 'brief.md (Leadership)', content: 'Project leader: Deniz Kaya.' },
    { citation: { documentId: 'doc-2', filename: 'budget.csv', chunkIndex: 1 }, sourceRef: 'budget.csv (Sheet1)', content: 'Budget rows.' },
  ] } } }], ['documentSearch']);
  assert.equal(result.citationValidation, 'valid');
  assert.deepEqual(result.sources.map((source: { filename: string }) => source.filename), ['brief.md']);
});
