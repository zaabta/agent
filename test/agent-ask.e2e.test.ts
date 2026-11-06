import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const baseUrl = process.env.AGENT_E2E_URL;
const apiKey = process.env.DEV_API_KEY;

test('synchronous ask remains compatible and stores a complete grounded turn', {
  skip: !baseUrl || !apiKey ? 'Set AGENT_E2E_URL and DEV_API_KEY for the real local E2E test' : false,
}, async () => {
  const response = await fetch(`${baseUrl}/api/agent/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey! },
    body: JSON.stringify({ message: 'What is the SitePilot Enterprise monthly subscription price?' }),
  });
  assert.equal(response.status, 201);
  const result = await response.json() as {
    answer: string;
    sources: Array<{ sourceRef: string }>;
    toolsCalled: string[];
    citationValidation: 'valid' | 'no-evidence' | 'fallback';
    timing: Record<string, number>;
    conversationId: string;
  };
  assert.ok(result.answer.includes('249'));
  assert.ok(result.answer.includes('[[sitepilot-e2e-pricing.md (chunk 1)]]'));
  assert.ok(result.sources.some(source => source.sourceRef === 'sitepilot-e2e-pricing.md (chunk 1)'));
  assert.ok(result.toolsCalled.includes('documentSearch'));
  assert.equal(typeof result.timing.totalMs, 'number');
  assert.ok(result.conversationId);

  const followup = await fetch(`${baseUrl}/api/agent/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey! },
    body: JSON.stringify({
      conversationId: result.conversationId,
      message: 'What annual billing discount does the document specify?',
    }),
  });
  assert.equal(followup.status, 201);
  const followupResult = await followup.json() as typeof result;
  assert.ok(
    /not specified|not been specified|do not specify|does not specify/i.test(followupResult.answer)
      || (followupResult.citationValidation === 'fallback' && /could not produce an answer with verifiable document citations/i.test(followupResult.answer)),
    `Expected a grounded unsupported-fact refusal, received: ${followupResult.answer}`,
  );
  assert.doesNotMatch(followupResult.answer, /\b\d+\s?%/);
  assert.ok(followupResult.sources.some(source => source.sourceRef === 'sitepilot-e2e-pricing.md (chunk 1)'));

  const budgetResponse = await fetch(`${baseUrl}/api/agent/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey! },
    body: JSON.stringify({ message: 'What is the approved project budget?' }),
  });
  assert.equal(budgetResponse.status, 201);
  const budgetResult = await budgetResponse.json() as typeof result;
  assert.ok(budgetResult.toolsCalled.includes('documentSearch'));
  assert.doesNotMatch(budgetResult.answer, /\b(?:USD|EUR|TRY|credits?)\b|\b\d[\d,.]*\s?(?:million|billion|k|m)?\b/i);

  const historyResponse = await fetch(`${baseUrl}/api/agent/conversations/${result.conversationId}`, {
    headers: { 'x-api-key': apiKey! },
  });
  const history = await historyResponse.json() as { messages: Array<{ role: string }> };
  assert.deepEqual(history.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
});
