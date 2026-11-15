import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';

export class CustomToolError extends Error {
  constructor(readonly category: string) { super(category); }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new CustomToolError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export type ConnectionProfile = { baseUrl: URL; allowedHosts: string[]; trustedInternal: boolean };

export function jsonSchema(schema: unknown) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || JSON.stringify(schema).length > 12_000) throw new CustomToolError('INVALID_SCHEMA');
  const check = (value: any, depth = 0): boolean => {
    if (depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(['type','title','description','properties','required','additionalProperties','items','enum','const','minimum','maximum','minLength','maxLength','minItems','maxItems']);
    if (Object.keys(value).some(key => !allowed.has(key))) return false;
    if (value.type === 'object') {
      const openRootResponse = depth === 0 && value.additionalProperties === true && Object.keys(value.properties ?? {}).length === 0;
      if ((!openRootResponse && value.additionalProperties !== false) || !value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) return false;
      if (Object.keys(value.properties).length > 40 || !Object.values(value.properties).every(child => check(child, depth + 1))) return false;
    } else if (value.type === 'array') {
      if (!check(value.items, depth + 1)) return false;
    } else if (!['string','number','integer','boolean','null'].includes(value.type)) return false;
    return true;
  };
  if (!check(schema) || (schema as any).type !== 'object') throw new CustomToolError('INVALID_SCHEMA');
  try { return z.fromJSONSchema(schema as any); } catch { throw new CustomToolError('INVALID_SCHEMA'); }
}

export function connectionProfiles(): Record<string, ConnectionProfile> {
  const raw = process.env.CUSTOM_TOOL_CONNECTION_PROFILES;
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CustomToolError('CONNECTION_PROFILES_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CustomToolError('CONNECTION_PROFILES_INVALID');
  const profiles: Record<string, ConnectionProfile> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, any>)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !value || typeof value.baseUrl !== 'string' || !Array.isArray(value.allowedHosts)) throw new CustomToolError('CONNECTION_PROFILES_INVALID');
    let baseUrl: URL;
    try { baseUrl = new URL(value.baseUrl); } catch { throw new CustomToolError('CONNECTION_PROFILES_INVALID'); }
    const trustedInternal = value.trustedInternal === true;
    const allowedHosts = value.allowedHosts.map((host: unknown) => typeof host === 'string' ? host.toLowerCase() : '');
    const validHost = (host: string) => /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !['https:', ...(trustedInternal ? ['http:'] : [])].includes(baseUrl.protocol)
      || !allowedHosts.length || allowedHosts.some((host: string) => !validHost(host)) || !allowedHosts.includes(baseUrl.hostname.toLowerCase())) throw new CustomToolError('CONNECTION_PROFILES_INVALID');
    profiles[id] = { baseUrl, allowedHosts, trustedInternal };
  }
  return profiles;
}

function publicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (version !== 6) return false;
  const v6 = address.toLowerCase().split('%')[0]!;
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice(7);
    if (tail.includes('.')) return publicAddress(tail);
    const words = tail.split(':').map(part => parseInt(part || '0', 16));
    return publicAddress(String(words[0] >> 8) + '.' + String(words[0] & 255) + '.' + String(words[1] >> 8) + '.' + String(words[1] & 255));
  }
  const first = parseInt(v6.split(':')[0] || '0', 16);
  const second = parseInt(v6.split(':')[1] || '0', 16);
  return (first & 0xe000) === 0x2000 && first !== 0x2002
    && !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8 || second === 0x0020));
}

export function customToolEndpoint(endpoint: string) {
  if (typeof endpoint !== 'string' || endpoint.length > 2000) throw new CustomToolError('INVALID_ENDPOINT');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new CustomToolError('INVALID_ENDPOINT'); }
  const authorityEnd = endpoint.indexOf('/', endpoint.indexOf('://') + 3);
  const rawPath = authorityEnd < 0 ? '/' : endpoint.slice(authorityEnd);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !hostname || hostname.endsWith('.') || hostname === 'metadata.google.internal' || /[%\\\u0000-\u0020]/.test(rawPath)
    || rawPath.split('/').some(segment => segment === '.' || segment === '..')
    || url.pathname !== (rawPath || '/')) throw new CustomToolError('INVALID_ENDPOINT');
  const profile = { baseUrl: new URL(url.origin), allowedHosts: [hostname], trustedInternal: false };
  const path = safeToolPath(profile.baseUrl, rawPath || '/').pathname;
  return { endpoint: `${url.origin}${path}`, profile, path };
}

type PublicLookup = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<Array<{ address: string; family: number }>>;
export async function validateCustomToolEndpoint(endpoint: string, resolve: PublicLookup = dnsLookup as PublicLookup) {
  const target = customToolEndpoint(endpoint);
  const hostname = target.profile.baseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(resolve(hostname, { all: true, order: 'verbatim' }), AbortSignal.timeout(5000));
  } catch (error) {
    throw new CustomToolError(error instanceof CustomToolError ? error.category : 'DNS_FAILURE');
  }
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new CustomToolError('ADDRESS_NOT_ALLOWED');
  return target;
}

export function safeToolPath(baseUrl: URL, path: string) {
  if (typeof path !== 'string' || path.length > 1000 || !path.startsWith('/') || path.startsWith('//') || /[?#\\%\u0000-\u0020]/.test(path)
    || path.split('/').some(segment => segment === '.' || segment === '..')) throw new CustomToolError('INVALID_PATH');
  const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : baseUrl.pathname + '/';
  const joined = new URL(basePath + path.slice(1), baseUrl.origin);
  if (!joined.pathname.startsWith(basePath) || joined.hostname !== baseUrl.hostname) throw new CustomToolError('INVALID_PATH');
  return joined;
}

export async function executeHttpTool(input: {
  profile: ConnectionProfile; path: string; queryMappings: Record<string, string>; inputSchema: unknown;
  outputSchema: unknown; args: unknown; headers?: Record<string, string>; timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal;
}) {
  const inputValidator = jsonSchema(input.inputSchema);
  const outputValidator = jsonSchema(input.outputSchema);
  const inputProperties = (input.inputSchema as any).properties as Record<string, unknown>;
  let args: Record<string, unknown>;
  try { args = inputValidator.parse(input.args) as Record<string, unknown>; } catch { throw new CustomToolError('INVALID_ARGUMENTS'); }
  const url = safeToolPath(input.profile.baseUrl, input.path);
  for (const [parameter, key] of Object.entries(input.queryMappings)) {
    if (!/^[A-Za-z0-9_.~-]{1,80}$/.test(parameter) || !Object.hasOwn(inputProperties, key)) throw new CustomToolError('INVALID_QUERY_MAPPING');
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (value !== null && ['string','number','boolean'].includes(typeof value)) url.searchParams.set(parameter, String(value));
  }
  if (url.href.length > 4000) throw new CustomToolError('INVALID_ARGUMENTS');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!input.profile.allowedHosts.includes(hostname)) throw new CustomToolError('HOST_NOT_APPROVED');
  let addresses: Array<{ address: string; family: number }>;
  const signal = input.signal ?? AbortSignal.timeout(input.timeoutMs);
  signal.throwIfAborted();
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(dnsLookup(hostname, { all: true, order: 'verbatim' }), signal);
  } catch (error) { if (error instanceof CustomToolError) throw error; throw new CustomToolError('DNS_FAILURE'); }
  if (!addresses.length || (!input.profile.trustedInternal && addresses.some(item => !publicAddress(item.address)))) throw new CustomToolError('ADDRESS_NOT_ALLOWED');
  const pinned = addresses[0]!;
  const lookup = ((_hostname: string, options: any, callback: (...args: any[]) => void) => {
    if (options?.all) callback(null, addresses);
    else callback(null, pinned.address, pinned.family);
  }) as any;
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const started = performance.now();
  const response = await new Promise<unknown>((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    const req = request(url, { method: 'GET', headers: { accept: 'application/json', ...input.headers }, agent: false, lookup, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true }, res => {
      if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) { res.destroy(); reject(new CustomToolError((res.statusCode ?? 500) >= 300 && (res.statusCode ?? 500) < 400 ? 'REDIRECT_REJECTED' : 'HTTP_STATUS')); return; }
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.includes('application/json')) { res.destroy(); reject(new CustomToolError('CONTENT_TYPE_INVALID')); return; }
      const length = Number(res.headers['content-length']);
      if (Number.isFinite(length) && length > input.maxResponseBytes) { res.destroy(); reject(new CustomToolError('RESPONSE_TOO_LARGE')); return; }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > input.maxResponseBytes) { res.destroy(new CustomToolError('RESPONSE_TOO_LARGE')); return; }
        chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new CustomToolError('INVALID_JSON')); return; }
        try { resolve(outputValidator.parse(parsed)); } catch { reject(new CustomToolError('OUTPUT_SCHEMA_MISMATCH')); }
      });
      res.on('error', error => reject(error instanceof CustomToolError ? error : new CustomToolError('NETWORK_ERROR')));
    });
    const timer = setTimeout(() => req.destroy(new CustomToolError('TIMEOUT')), input.timeoutMs);
    const abort = () => req.destroy(new CustomToolError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    req.on('error', error => reject(error instanceof CustomToolError ? error : new CustomToolError('NETWORK_ERROR')));
    req.on('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
    req.end();
  }).catch(error => { if (error instanceof CustomToolError) throw error; throw new CustomToolError('NETWORK_ERROR'); });
  return { output: response, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
}
