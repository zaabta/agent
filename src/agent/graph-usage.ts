export function normalizeUsage(input: any): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const usage: Record<string, unknown> = {};
  for (const [target, source] of [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['totalTokens', 'total_tokens'],
    ['reasoningTokens', 'reasoning_tokens'],
    ['cachedInputTokens', 'input_token_details'],
  ] as const) {
    const value = input[source];
    if (target === 'cachedInputTokens') {
      const cached = value?.cache_read ?? value?.cache_creation;
      if (Number.isInteger(cached)) usage[target] = cached;
    } else if (Number.isInteger(value)) usage[target] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}
