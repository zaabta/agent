import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';

export class CustomToolError extends Error {
  constructor(readonly category: string, readonly statusCode?: number, readonly responseHeaders?: Record<string, string | string[] | undefined>) {
    super(category);
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      reject(new CustomToolError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export type ConnectionProfile = { baseUrl: URL; allowedHosts: string[]; trustedInternal: boolean; loopbackOnly?: boolean };
type EndpointOptions = { allowLocalHttp?: boolean };

function loopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && Number(host.split('.')[0]) === 127);
}

export function loopbackAddress(address: string) {
  if (address.toLowerCase().startsWith('::ffff:')) return loopbackAddress(address.slice(7));
  const version = isIP(address);
  if (version === 4) return Number(address.split('.')[0]) === 127;
  return version === 6 && address.toLowerCase().split('%')[0] === '::1';
}

export function jsonSchema(schema: unknown, allowArrayRoot = false) {
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    JSON.stringify(schema).length > 12_000
  )
    throw new CustomToolError('INVALID_SCHEMA');
  const check = (value: any, depth = 0): boolean => {
    if (depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set([
      'type',
      'title',
      'description',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'enum',
      'const',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    if (value.type === 'object') {
      const openRootResponse =
        depth === 0 &&
        value.additionalProperties === true &&
        Object.keys(value.properties ?? {}).length === 0;
      if (
        (!openRootResponse && value.additionalProperties !== false) ||
        !value.properties ||
        typeof value.properties !== 'object' ||
        Array.isArray(value.properties)
      )
        return false;
      if (
        Object.keys(value.properties).length > 40 ||
        !Object.values(value.properties).every((child) => check(child, depth + 1))
      )
        return false;
    } else if (value.type === 'array') {
      if (!check(value.items, depth + 1)) return false;
    } else if (!['string', 'number', 'integer', 'boolean', 'null'].includes(value.type)) return false;
    return true;
  };
  if (!check(schema) || ((schema as any).type !== 'object' && !(allowArrayRoot && (schema as any).type === 'array')))
    throw new CustomToolError('INVALID_SCHEMA');
  try {
    return z.fromJSONSchema(schema as any);
  } catch {
    throw new CustomToolError('INVALID_SCHEMA');
  }
}

function projectOutput(value: unknown, schema: any): unknown {
  if (schema?.type === 'array' && Array.isArray(value))
    return value.map((item) => projectOutput(item, schema.items));
  if (schema?.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const properties = schema.properties as Record<string, unknown>;
  const entries = Object.entries(value);
  return Object.fromEntries(
    entries
      .filter(([key]) => schema.additionalProperties !== false || Object.hasOwn(properties, key))
      .map(([key, item]) => [
        key,
        Object.hasOwn(properties, key) ? projectOutput(item, properties[key]) : item,
      ]),
  );
}

export function normalizeCustomToolOutput(value: unknown, schema: unknown) {
  try {
    const shape = schema as any;
    if (
      Array.isArray(value) &&
      shape?.type === 'object' &&
      shape.additionalProperties === true &&
      Object.keys(shape.properties ?? {}).length === 0
    )
      return z.array(z.unknown()).max(1000).parse(value);
    const validator = shape?.type === 'array'
      ? z.array(jsonSchema(shape.items, true)).max(1000)
      : jsonSchema(schema);
    return validator.parse(projectOutput(value, schema));
  } catch {
    throw new CustomToolError('OUTPUT_SCHEMA_MISMATCH');
  }
}

function publicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version !== 6) return false;
  const v6 = address.toLowerCase().split('%')[0]!;
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice(7);
    if (tail.includes('.')) return publicAddress(tail);
    const words = tail.split(':').map((part) => parseInt(part || '0', 16));
    return publicAddress(
      String(words[0] >> 8) +
        '.' +
        String(words[0] & 255) +
        '.' +
        String(words[1] >> 8) +
        '.' +
        String(words[1] & 255),
    );
  }
  const first = parseInt(v6.split(':')[0] || '0', 16);
  const second = parseInt(v6.split(':')[1] || '0', 16);
  return (
    (first & 0xe000) === 0x2000 &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8 || second === 0x0020))
  );
}

export function customToolEndpoint(endpoint: string, options: EndpointOptions = {}) {
  if (typeof endpoint !== 'string' || endpoint.length > 2000) throw new CustomToolError('INVALID_ENDPOINT');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CustomToolError('INVALID_ENDPOINT');
  }
  const authorityEnd = endpoint.indexOf('/', endpoint.indexOf('://') + 3);
  const rawPath = authorityEnd < 0 ? '/' : endpoint.slice(authorityEnd);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopbackOnly = process.env.NODE_ENV !== 'production' && options.allowLocalHttp === true &&
    url.protocol === 'http:' && loopbackHost(hostname);
  if (
    (url.protocol !== 'https:' && !loopbackOnly) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !hostname ||
    hostname.endsWith('.') ||
    hostname === 'metadata.google.internal' ||
    /[%\\\u0000-\u0020]/.test(rawPath) ||
    rawPath.split('/').some((segment) => segment === '.' || segment === '..') ||
    url.pathname !== (rawPath || '/')
  )
    throw new CustomToolError('INVALID_ENDPOINT');
  const profile = { baseUrl: new URL(url.origin), allowedHosts: [hostname], trustedInternal: false, ...(loopbackOnly ? { loopbackOnly } : {}) };
  const path = safeToolPath(profile.baseUrl, rawPath || '/').pathname;
  return { endpoint: `${url.origin}${path}`, profile, path };
}

type PublicLookup = (
  hostname: string,
  options: { all: true; order: 'verbatim' },
) => Promise<Array<{ address: string; family: number }>>;
export async function validateCustomToolEndpoint(
  endpoint: string,
  resolve: PublicLookup = dnsLookup as PublicLookup,
  options: EndpointOptions = {},
) {
  const target = customToolEndpoint(endpoint, options);
  const hostname = target.profile.baseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(resolve(hostname, { all: true, order: 'verbatim' }), AbortSignal.timeout(5000));
  } catch (error) {
    throw new CustomToolError(error instanceof CustomToolError ? error.category : 'DNS_FAILURE');
  }
  if (!addresses.length || addresses.some((item) => target.profile.loopbackOnly ? !loopbackAddress(item.address) : !publicAddress(item.address)))
    throw new CustomToolError('ADDRESS_NOT_ALLOWED');
  return target;
}

export function safeToolPath(baseUrl: URL, path: string) {
  if (
    typeof path !== 'string' ||
    path.length > 1000 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[?#\\%\u0000-\u0020]/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  )
    throw new CustomToolError('INVALID_PATH');
  const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : baseUrl.pathname + '/';
  const joined = new URL(basePath + path.slice(1), baseUrl.origin);
  if (!joined.pathname.startsWith(basePath) || joined.hostname !== baseUrl.hostname)
    throw new CustomToolError('INVALID_PATH');
  return joined;
}

async function requestJson(input: {
  profile: ConnectionProfile;
  url: URL;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  allowErrorStatus?: boolean;
}) {
  const hostname = input.url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!input.profile.allowedHosts.includes(hostname)) throw new CustomToolError('HOST_NOT_APPROVED');
  let addresses: Array<{ address: string; family: number }>;
  const signal = input.signal ?? AbortSignal.timeout(input.timeoutMs);
  signal.throwIfAborted();
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(dnsLookup(hostname, { all: true, order: 'verbatim' }), signal);
  } catch (error) {
    if (error instanceof CustomToolError) throw error;
    throw new CustomToolError('DNS_FAILURE');
  }
  if (!addresses.length || (input.profile.loopbackOnly
    ? addresses.some((item) => !loopbackAddress(item.address))
    : !input.profile.trustedInternal && addresses.some((item) => !publicAddress(item.address))))
    throw new CustomToolError('ADDRESS_NOT_ALLOWED');
  const pinned = addresses[0]!;
  const lookup = ((_hostname: string, options: any, callback: (...args: any[]) => void) => {
    if (options?.all) callback(null, addresses);
    else callback(null, pinned.address, pinned.family);
  }) as any;
  const request = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<{ body: unknown; statusCode: number; responseHeaders: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    const req = request(input.url, {
      method: input.method,
      headers: { accept: 'application/json', ...(input.body ? { 'content-type': 'application/json' } : {}), ...input.headers },
      agent: false,
      lookup,
      servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: true,
    }, (res) => {
      const statusCode = res.statusCode ?? 500;
      const responseHeaders = res.headers;
      if ((statusCode < 200 || statusCode >= 300) && (statusCode >= 300 && statusCode < 400 || !input.allowErrorStatus)) {
        res.destroy();
        reject(new CustomToolError(statusCode >= 300 && statusCode < 400 ? 'REDIRECT_REJECTED' : 'HTTP_STATUS', statusCode, responseHeaders));
        return;
      }
      const contentType = String(responseHeaders['content-type'] ?? '').toLowerCase();
      if (!contentType.includes('application/json')) {
        res.destroy();
        reject(new CustomToolError('CONTENT_TYPE_INVALID', statusCode, responseHeaders));
        return;
      }
      const length = Number(responseHeaders['content-length']);
      if (Number.isFinite(length) && length > input.maxResponseBytes) {
        res.destroy();
        reject(new CustomToolError('RESPONSE_TOO_LARGE', statusCode));
        return;
      }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > input.maxResponseBytes) {
          res.destroy(new CustomToolError('RESPONSE_TOO_LARGE', statusCode));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ body, statusCode, responseHeaders });
        } catch {
          reject(new CustomToolError('INVALID_JSON', statusCode));
        }
      });
      res.on('error', (error) => reject(error instanceof CustomToolError ? error : new CustomToolError('NETWORK_ERROR')));
    });
    const timer = setTimeout(() => req.destroy(new CustomToolError('TIMEOUT')), input.timeoutMs);
    const abort = () => req.destroy(new CustomToolError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    req.on('error', (error) => reject(error instanceof CustomToolError ? error : new CustomToolError('NETWORK_ERROR')));
    req.on('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
    req.end(input.body);
  }).catch((error) => {
    if (error instanceof CustomToolError) throw error;
    throw new CustomToolError('NETWORK_ERROR');
  });
}

export async function executeInternalJsonRequest(input: {
  profile: ConnectionProfile;
  path: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}) {
  const url = safeToolPath(input.profile.baseUrl, input.path);
  return requestJson({
    profile: input.profile,
    url,
    method: 'POST',
    headers: input.headers,
    body: JSON.stringify(input.body),
    timeoutMs: input.timeoutMs ?? 10_000,
    maxResponseBytes: input.maxResponseBytes ?? 65_536,
    allowErrorStatus: true,
  });
}

export async function executeInternalFormRequest(input: {
  profile: ConnectionProfile;
  path: string;
  fields: Record<string, string>;
}) {
  const url = safeToolPath(input.profile.baseUrl, input.path);
  return requestJson({
    profile: input.profile,
    url,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(input.fields).toString(),
    timeoutMs: 10_000,
    maxResponseBytes: 65_536,
    allowErrorStatus: true,
  });
}

export async function executeHttpTool(input: {
  profile: ConnectionProfile;
  path: string;
  queryMappings: Record<string, string>;
  inputSchema: unknown;
  outputSchema: unknown;
  args: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  onInputValidation?: (outcome: 'valid' | 'invalid') => void;
  onValidatedArgs?: (args: Record<string, unknown>) => void;
}) {
  const inputValidator = jsonSchema(input.inputSchema);
    jsonSchema(input.outputSchema, true);
  const inputProperties = (input.inputSchema as any).properties as Record<string, unknown>;
  let args: Record<string, unknown>;
  try {
    args = inputValidator.parse(input.args) as Record<string, unknown>;
    input.onInputValidation?.('valid');
    input.onValidatedArgs?.(args);
  } catch {
    input.onInputValidation?.('invalid');
    throw new CustomToolError('INVALID_ARGUMENTS');
  }
  const url = safeToolPath(input.profile.baseUrl, input.path);
  for (const [parameter, key] of Object.entries(input.queryMappings)) {
    if (!/^[A-Za-z0-9_.~-]{1,80}$/.test(parameter) || !Object.hasOwn(inputProperties, key))
      throw new CustomToolError('INVALID_QUERY_MAPPING');
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (value !== null && ['string', 'number', 'boolean'].includes(typeof value))
      url.searchParams.set(parameter, String(value));
  }
  if (url.href.length > 4000) throw new CustomToolError('INVALID_ARGUMENTS');
  const started = performance.now();
  const response = await requestJson({
    profile: input.profile,
    url,
    method: 'GET',
    headers: input.headers,
    timeoutMs: input.timeoutMs,
    maxResponseBytes: input.maxResponseBytes,
    signal: input.signal,
  });
  return {
    output: normalizeCustomToolOutput(response.body, input.outputSchema),
    statusCode: response.statusCode,
    responseHeaders: response.responseHeaders,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  };
}
