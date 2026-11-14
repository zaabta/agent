import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { localGenerationOptions } from '../src/mastra/generation-options.js';

test('Gemini 3.6 generation uses configured thinking level without exposing thoughts', () => {
  const previous = { modelProvider: config.modelProvider, model: config.model, geminiThinkingLevel: config.geminiThinkingLevel };
  try {
    Object.assign(config, { modelProvider: 'google', model: 'google/gemini-3.6-flash', geminiThinkingLevel: 'low' });
    assert.deepEqual(localGenerationOptions(), {
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } },
    });
  } finally {
    Object.assign(config, previous);
  }
});
