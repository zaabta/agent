import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invalidStructuredPlanAnswer } from '../src/agent/agent.workflow.js';

test('invalid structured plans return only discovered tenant schema for clarification', () => {
  const answer = invalidStructuredPlanAnswer([{ filename: 'arbitrary.csv', sheets: [{ sheetName: 'Input', columns: ['Form Identifier', 'Arbitrary Metric'] }] }]);
  assert.match(answer, /arbitrary\.csv/);
  assert.match(answer, /Form Identifier, Arbitrary Metric/);
  assert.match(answer, /could not be validated/);
});
