import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CustomToolError,
  customToolEndpoint,
  executeHttpTool,
  jsonSchema,
  normalizeCustomToolOutput,
  safeToolPath,
  validateCustomToolEndpoint,
} from '../src/agent/custom-http-tool.js';

const inputSchema = {
  type: 'object',
  properties: { email: { type: 'string', maxLength: 100 } },
  required: ['email'],
  additionalProperties: false,
};
const outputSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, name: { type: 'string' } },
  required: ['id', 'name'],
  additionalProperties: false,
};

test('custom HTTP schemas and paths reject unsupported or escape values', () => {
  assert.throws(() =>
    jsonSchema({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: { $ref: 'http://example.invalid/schema' },
    }),
  );
  assert.throws(() => safeToolPath(new URL('https://api.example.com/v1'), '/../admin'));
  assert.throws(() => safeToolPath(new URL('https://api.example.com/v1'), '//evil.example.com/path'));
  assert.deepEqual(jsonSchema(inputSchema).parse({ email: 'a@example.com' }), { email: 'a@example.com' });
  assert.throws(() => jsonSchema(inputSchema).parse({ email: 'a@example.com', extra: 'blocked' }));
});

test('public connection profiles reject loopback DNS results before making a request', async () => {
  await assert.rejects(
    executeHttpTool({
      profile: {
        baseUrl: new URL('http://localhost/v1'),
        allowedHosts: ['localhost'],
        trustedInternal: false,
      },
      path: '/contacts',
      queryMappings: {},
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema,
      args: {},
      timeoutMs: 1000,
      maxResponseBytes: 1000,
    }),
    (error: unknown) => error instanceof CustomToolError && error.category === 'ADDRESS_NOT_ALLOWED',
  );
});

test('full endpoints require HTTPS, reject credentials, query strings, and escaped paths', () => {
  const target = customToolEndpoint('https://api.example.com/v1/weather');
  assert.equal(target.endpoint, 'https://api.example.com/v1/weather');
  assert.equal(target.path, '/v1/weather');
  assert.throws(() => customToolEndpoint('http://api.example.com/weather'), /INVALID_ENDPOINT/);
  assert.throws(() => customToolEndpoint('https://user:pass@api.example.com/weather'), /INVALID_ENDPOINT/);
  assert.throws(() => customToolEndpoint('https://api.example.com/weather?token=x'), /INVALID_ENDPOINT/);
  assert.throws(() => customToolEndpoint('https://api.example.com/v1/../admin'), /INVALID_ENDPOINT/);
  assert.throws(() => customToolEndpoint('https://metadata.google.internal/latest'), /INVALID_ENDPOINT/);
});

test('endpoint DNS validation rejects any private answer, mapped metadata IP, and NAT64', async () => {
  await assert.rejects(
    validateCustomToolEndpoint('https://api.example.com/weather', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.4', family: 4 },
    ]),
    /ADDRESS_NOT_ALLOWED/,
  );
  await assert.rejects(
    validateCustomToolEndpoint('https://169.254.169.254/latest', async () => []),
    /ADDRESS_NOT_ALLOWED/,
  );
  await assert.rejects(
    validateCustomToolEndpoint('https://[::ffff:169.254.169.254]/latest', async () => []),
    /ADDRESS_NOT_ALLOWED/,
  );
  await assert.rejects(
    validateCustomToolEndpoint('https://[64:ff9b::a9fe:a9fe]/latest', async () => []),
    /ADDRESS_NOT_ALLOWED/,
  );
  const allowed = await validateCustomToolEndpoint('https://api.example.com/weather', async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  assert.equal(allowed.endpoint, 'https://api.example.com/weather');
});

test('generated parameter schema is strict and the default response schema accepts bounded JSON objects', () => {
  const input = jsonSchema({
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
    additionalProperties: false,
  });
  assert.deepEqual(input.parse({ city: 'Istanbul' }), { city: 'Istanbul' });
  assert.throws(() => input.parse({ city: 'Istanbul', privateData: 'blocked' }));
  assert.deepEqual(
    jsonSchema({ type: 'object', properties: {}, required: [], additionalProperties: true }).parse({
      temperature: 22,
    }),
    { temperature: 22 },
  );
});

test('an omitted optional parameter is not added to the query and does not invalidate the call', async () => {
  await assert.rejects(
    executeHttpTool({
      profile: { baseUrl: new URL('http://localhost'), allowedHosts: ['localhost'], trustedInternal: false },
      path: '/weather',
      queryMappings: { units: 'units' },
      inputSchema: {
        type: 'object',
        properties: { units: { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
      outputSchema,
      args: {},
      timeoutMs: 1000,
      maxResponseBytes: 1000,
    }),
    (error: unknown) => error instanceof CustomToolError && error.category === 'ADDRESS_NOT_ALLOWED',
  );
});

test('custom output schemas project disallowed API fields before returning data to the Agent', () => {
  const schema = {
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            price: { type: 'number' },
            category: { type: 'string' },
          },
          required: ['id', 'title', 'price', 'category'],
          additionalProperties: false,
        },
      },
    },
    required: ['products'],
    additionalProperties: false,
  };
  const result = normalizeCustomToolOutput(
    {
      products: [{ id: 1, title: 'Laptop', price: 500, category: 'computers', description: 'large field' }],
      unrelated: 'large field',
    },
    schema,
  );
  assert.deepEqual(result, { products: [{ id: 1, title: 'Laptop', price: 500, category: 'computers' }] });
  assert.throws(
    () =>
      normalizeCustomToolOutput(
        { products: [{ id: 'invalid', title: 'Laptop', price: 500, category: 'computers' }] },
        schema,
      ),
    /OUTPUT_SCHEMA_MISMATCH/,
  );
});
