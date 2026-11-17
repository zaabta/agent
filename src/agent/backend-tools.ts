import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { decryptCredential, encryptCredential } from '../llm-admin/provider-credentials.js';
import { connectionProfiles, customToolEndpoint, CustomToolError, executeHttpTool, jsonSchema, safeToolPath, validateCustomToolEndpoint } from './custom-http-tool.js';

export const backendCallSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  args: z.record(z.string(), z.unknown()),
});
export const backendCallLLMSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  args: z.object({}).catchall(z.unknown()),
});

type ReadTool = {
  id: string;
  description: string;
  inputSchema: object;
  validateArgs: (args: unknown) => boolean;
  authorize: (principal: AuthPrincipal) => boolean;
  execute: (args: unknown, principal: AuthPrincipal, signal: AbortSignal) => Promise<string>;
};
type ToolParameter = { name: string; type: 'string' | 'number' | 'integer' | 'boolean'; required?: boolean; description?: string; queryParameter?: string };
type ToolDefinition = {
  name: string; displayName?: string; description: string; endpoint?: string; connectionProfile?: string; path?: string;
  parameters?: ToolParameter[]; queryMappings?: Record<string, string>; inputSchema?: unknown; outputSchema?: unknown;
  timeoutMs?: number; maxResponseBytes?: number;
  auth?: { headerName: 'Authorization' | 'X-API-Key'; prefix?: string; secret?: string } | null;
};
const DEFAULT_OUTPUT_SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_ID = (id: string) => 'custom_' + id.replaceAll('-', '');
const SENSITIVE_ARGUMENT_KEY = /(?:password|secret|token|authorization|cookie|api[_-]?key|credential|private[_-]?key)/i;
const redactArguments = (value: unknown, credential: string, depth = 0): unknown => {
  if (typeof value === 'string') return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,})\b/g, '[redacted]')
    .replace(credential ? new RegExp(credential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '[redacted]');
  if (Array.isArray(value)) return depth < 8 ? value.map(item => redactArguments(item, credential, depth + 1)) : '[redacted]';
  if (value && typeof value === 'object') {
    if (depth >= 8) return '[redacted]';
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_ARGUMENT_KEY.test(key) ? '[redacted]' : redactArguments(item, credential, depth + 1)]));
  }
  return value;
};
const idFromCall = (id: string) => id.startsWith('custom_') && /^[0-9a-f]{32}$/i.test(id.slice(7))
  ? id.slice(7).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : undefined;

@Injectable()
export class BackendTools {
  private readonly tools = new Map<string, ReadTool>();
  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  register<T extends z.ZodType>(tool: Omit<ReadTool, 'inputSchema' | 'execute' | 'validateArgs'> & {
    input: T;
    execute: (args: z.output<T>, principal: AuthPrincipal, signal: AbortSignal) => Promise<string>;
  }) {
    backendCallSchema.shape.id.parse(tool.id);
    const description = z.string().trim().min(1).max(300).parse(tool.description);
    if (this.tools.has(tool.id) || this.tools.size >= 16) throw new Error('BACKEND_TOOL_REGISTRATION_REJECTED');
    const inputSchema = z.toJSONSchema(tool.input);
    if (JSON.stringify(inputSchema).length > 2000) throw new Error('BACKEND_TOOL_SCHEMA_TOO_LARGE');
    this.tools.set(tool.id, { id: tool.id, authorize: tool.authorize, description, inputSchema, validateArgs: args => tool.input.safeParse(args).success,
      execute: (args, principal, signal) => tool.execute(tool.input.parse(args) as z.output<T>, principal, signal) });
  }

  async catalog(principal: AuthPrincipal) {
    const built = [...this.tools.values()].filter(tool => tool.authorize(principal)).map(tool => ({ id: tool.id, description: tool.description, input: tool.inputSchema }));
    if (!this.prisma) return built;
    let profiles: ReturnType<typeof connectionProfiles> = {};
    try { profiles = connectionProfiles(); } catch { /* Direct endpoints do not use server profiles. */ }
    const rows = principal.userId && principal.authMethod === 'jwt'
      ? await (this.prisma as any).customTool.findMany({ where: { enabled: true, archivedAt: null }, orderBy: { name: 'asc' }, take: 1000 }) : [];
    const candidates = rows.filter((row: any) => row.endpointUrl || profiles[row.connectionProfile]).map((row: any) => ({
      id: TOOL_ID(row.id), name: row.name, displayName: row.displayName, description: row.description, input: row.inputSchema,
      version: row.configurationVersion,
    }));
    const bounded: any[] = [];
    let promptSize = 0;
    for (const tool of [...built, ...candidates]) {
      if (bounded.length >= 48) break;
      const size = Buffer.byteLength(JSON.stringify(tool), 'utf8');
      if (size <= 24000 && promptSize + size <= 24000) { bounded.push(tool); promptSize += size; }
    }
    return bounded;
  }

  async hasEnabledTools(principal: AuthPrincipal) {
    if (!this.prisma || !principal.userId || principal.authMethod !== 'jwt') return false;
    try {
      let profiles: ReturnType<typeof connectionProfiles> = {};
      try { profiles = connectionProfiles(); } catch { /* Direct endpoints do not use server profiles. */ }
      const rows = await (this.prisma as any).customTool.findMany({ where: { enabled: true, archivedAt: null }, select: { endpointUrl: true, connectionProfile: true }, take: 1000 });
      return rows.some((row: any) => Boolean(row.endpointUrl || profiles[row.connectionProfile]));
    } catch { return false; }
  }

  async execute(call: z.infer<typeof backendCallSchema>, principal: AuthPrincipal, parentSignal?: AbortSignal, onStart?: () => Promise<void>, context: { logicalRequestId?: string; conversationId?: string; snapshotVersion?: number; isTest?: boolean; allowDisabled?: boolean; onSchemaValidation?: (outcome: 'valid' | 'invalid') => void } = {}): Promise<unknown> {
    const tool = this.tools.get(call.id);
    if (tool) {
      if (!tool.authorize(principal)) return undefined;
      context.onSchemaValidation?.(tool.validateArgs(call.args) ? 'valid' : 'invalid');
      const timeout = AbortSignal.timeout(15_000);
      const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
      signal.throwIfAborted();
      if (JSON.stringify(call.args).length > 4000) throw new Error('BACKEND_TOOL_ARGUMENTS_TOO_LARGE');
      await onStart?.();
      signal.throwIfAborted();
      const output = await Promise.race([tool.execute(call.args, principal, signal), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      return z.string().min(1).max(8000).parse(output);
    }
    const toolId = idFromCall(call.id);
    if (!toolId || !this.prisma || !principal.userId || principal.authMethod !== 'jwt') return undefined;
    const db = this.prisma as any;
    const row = await db.customTool.findUnique({ where: { id: toolId }, include: { authSecret: true } });
    if (!row || row.archivedAt || (!row.enabled && !context.allowDisabled)) return undefined;
    if (context.snapshotVersion !== undefined && row.configurationVersion !== context.snapshotVersion) throw new CustomToolError('TOOL_CONFIGURATION_CHANGED');
    const target = row.endpointUrl
      ? customToolEndpoint(row.endpointUrl)
      : (() => {
          const profile = connectionProfiles()[row.connectionProfile];
          if (!profile) throw new CustomToolError('CONNECTION_PROFILE_UNAVAILABLE');
          return { profile, path: row.path };
        })();
    const { profile, path } = target;
    const timeout = AbortSignal.timeout(row.timeoutMs);
    const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
    signal.throwIfAborted();
    if (JSON.stringify(call.args).length > 12_000) throw new CustomToolError('INVALID_ARGUMENTS');
    await onStart?.();
    const started = performance.now();
    let success = false;
    let errorCategory: string | null = null;
    let credential = '';
    let safeArguments: unknown;
    try {
      const headers: Record<string, string> = {};
      if (row.authHeaderName) {
        if (!row.authSecret) throw new CustomToolError('AUTH_SECRET_UNAVAILABLE');
        credential = decryptCredential(row.authSecret);
        headers[row.authHeaderName] = (row.authPrefix ?? '') + credential;
      }
      const result = await executeHttpTool({
        profile, path, queryMappings: row.queryMappings as Record<string, string>,
        inputSchema: row.inputSchema, outputSchema: row.outputSchema, args: call.args, headers,
        timeoutMs: row.timeoutMs, maxResponseBytes: row.maxResponseBytes, signal,
        onInputValidation: context.onSchemaValidation,
        onValidatedArgs: args => { safeArguments = redactArguments(args, credential); },
      });
      success = true;
      return this.redactCredential(result.output, credential);
    } catch (error) {
      errorCategory = error instanceof CustomToolError ? error.category : 'EXECUTION_ERROR';
      throw error instanceof CustomToolError ? error : new CustomToolError(errorCategory);
    } finally {
      await db.customToolExecution.create({ data: {
        toolId: row.id, toolVersion: row.configurationVersion, logicalRequestId: context.logicalRequestId ?? randomUUID(),
        conversationId: context.conversationId ?? null, userId: principal.userId,
        latencyMs: Math.max(0, Math.round(performance.now() - started)), success, errorCategory,
        arguments: safeArguments,
        isTest: context.isTest ?? false,
      } }).catch((error: unknown) => console.warn(JSON.stringify({ event: 'custom_tool_execution_log_failed', errorType: error instanceof Error ? error.name : 'unknown' })));
    }
  }

  listConnectionProfiles() {
    try { return Object.entries(connectionProfiles()).map(([id, profile]) => ({ id, host: profile.baseUrl.hostname, trustedInternal: profile.trustedInternal })); }
    catch (error) { throw new BadRequestException(error instanceof CustomToolError ? error.category : 'CONNECTION_PROFILES_INVALID'); }
  }

  async listCustomTools() {
    const rows = await this.db().customTool.findMany({ where: { archivedAt: null }, orderBy: { createdAt: 'desc' } });
    return rows.map((row: any) => this.publicTool(row));
  }

  async getCustomTool(id: string) {
    const row = await this.findTool(id);
    return this.publicTool(row);
  }

  async createCustomTool(input: ToolDefinition, userId: string) {
    const definition = await this.validateDefinition(input);
    if (definition.auth && !definition.auth.secret) throw new BadRequestException('AUTH_SECRET_REQUIRED');
    const db = this.db();
    const secretId = definition.auth?.secret ? randomUUID() : undefined;
    const encrypted = definition.auth?.secret ? encryptCredential(definition.auth.secret) : undefined;
    try {
      const row = await db.$transaction(async (tx: any) => {
        if (encrypted) await tx.customToolSecret.create({ data: { id: secretId, ...encrypted, createdBy: userId } });
        const created = await tx.customTool.create({ data: {
          name: definition.name, displayName: definition.displayName ?? definition.name, description: definition.description,
          type: 'HTTP_GET', endpointUrl: definition.endpoint ?? null,
          connectionProfile: definition.connectionProfile ?? 'direct', path: definition.path!,
          queryMappings: definition.queryMappings!, inputSchema: definition.inputSchema!, outputSchema: definition.outputSchema!,
          authHeaderName: definition.auth?.headerName ?? null, authPrefix: definition.auth?.prefix ?? null, authSecretId: secretId ?? null,
          timeoutMs: definition.timeoutMs ?? 10000, maxResponseBytes: definition.maxResponseBytes ?? 65536,
          enabled: false, effectClassification: 'READ_ONLY', createdBy: userId, updatedBy: userId,
        } });
        await tx.auditLog.create({ data: { userId, action: 'CUSTOM_TOOL_CREATED', details: { toolId: created.id, version: created.configurationVersion } } });
        return created;
      });
      return this.publicTool(row);
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw new ConflictException('TOOL_NAME_EXISTS');
      throw error;
    }
  }

  async updateCustomTool(id: string, input: ToolDefinition, userId: string) {
    const current = await this.findTool(id);
    const definition = await this.validateDefinition(input);
    if (definition.auth && !definition.auth.secret && !current.authSecretId) throw new BadRequestException('AUTH_SECRET_REQUIRED');
    const db = this.db();
    const secretId = definition.auth?.secret ? randomUUID() : definition.auth ? current.authSecretId : undefined;
    const encrypted = definition.auth?.secret ? encryptCredential(definition.auth.secret) : undefined;
    let row: any;
    try { row = await db.$transaction(async (tx: any) => {
      if (encrypted) await tx.customToolSecret.create({ data: { id: secretId, ...encrypted, createdBy: userId } });
      const updated = await tx.customTool.update({ where: { id }, data: {
        name: definition.name, displayName: definition.displayName ?? definition.name, description: definition.description,
        type: 'HTTP_GET', endpointUrl: definition.endpoint ?? null,
        connectionProfile: definition.connectionProfile ?? 'direct', path: definition.path!,
        queryMappings: definition.queryMappings!, inputSchema: definition.inputSchema!, outputSchema: definition.outputSchema!,
        authHeaderName: definition.auth?.headerName ?? null, authPrefix: definition.auth?.prefix ?? null,
        authSecretId: definition.auth ? secretId ?? null : null,
        timeoutMs: definition.timeoutMs ?? 10000, maxResponseBytes: definition.maxResponseBytes ?? 65536,
        configurationVersion: { increment: 1 }, updatedBy: userId,
      } });
      if (current.authSecretId && current.authSecretId !== updated.authSecretId) await tx.customToolSecret.delete({ where: { id: current.authSecretId } });
      await tx.auditLog.create({ data: { userId, action: 'CUSTOM_TOOL_UPDATED', details: { toolId: id, version: updated.configurationVersion } } });
      return updated;
    }); } catch (error) {
      if ((error as any)?.code === 'P2002') throw new ConflictException('TOOL_NAME_EXISTS');
      throw error;
    }
    return this.publicTool(row);
  }

  async setCustomToolEnabled(id: string, enabled: boolean, userId: string) {
    const current = await this.findTool(id);
    if (typeof enabled !== 'boolean') throw new BadRequestException('INVALID_ENABLED_VALUE');
    if (enabled) {
      try {
        if (current.endpointUrl) await validateCustomToolEndpoint(current.endpointUrl);
        else if (!connectionProfiles()[current.connectionProfile]) throw new BadRequestException('CONNECTION_PROFILE_UNAVAILABLE');
      }
      catch (error) { if (error instanceof BadRequestException) throw error; throw new BadRequestException(error instanceof CustomToolError ? error.category : 'CONNECTION_PROFILES_INVALID'); }
    }
    const row = await this.db().customTool.update({ where: { id }, data: { enabled, configurationVersion: { increment: 1 }, updatedBy: userId } });
    await this.audit('CUSTOM_TOOL_TOGGLED', userId, id, row.configurationVersion);
    return this.publicTool(row);
  }

  async archiveCustomTool(id: string, userId: string) {
    const current = await this.findTool(id);
    const row = await this.db().$transaction(async (tx: any) => {
      const archived = await tx.customTool.update({ where: { id }, data: { enabled: false, archivedAt: new Date(), authSecretId: null, configurationVersion: { increment: 1 }, updatedBy: userId } });
      if (current.authSecretId) await tx.customToolSecret.delete({ where: { id: current.authSecretId } });
      await tx.auditLog.create({ data: { userId, action: 'CUSTOM_TOOL_ARCHIVED', details: { toolId: id, version: archived.configurationVersion } } });
      return archived;
    });
    return { id: row.id, archived: true };
  }

  async testCustomTool(id: string, sampleInput: unknown, userId: string) {
    const row = await this.findTool(id);
    const started = performance.now();
    try {
      const output = await this.execute({ id: TOOL_ID(row.id), args: sampleInput as Record<string, unknown> }, { userId, tenantId: '', authMethod: 'jwt' }, undefined, undefined, { snapshotVersion: row.configurationVersion, isTest: true, allowDisabled: true });
      return { success: true, durationMs: Math.round(performance.now() - started), errorCategory: null, sampleOutput: this.sanitizeSample(output) };
    } catch (error) {
      return { success: false, durationMs: Math.round(performance.now() - started), errorCategory: error instanceof CustomToolError ? error.category : 'EXECUTION_ERROR' };
    }
  }

  async customToolExecutions(id: string, limit = 50, offset = 0) {
    await this.findTool(id);
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const rows = await this.db().customToolExecution.findMany({ where: { toolId: id }, orderBy: { createdAt: 'desc' }, take: safeLimit, skip: safeOffset });
    return rows;
  }

  private async validateDefinition(input: ToolDefinition): Promise<ToolDefinition> {
    const fail = (code: string): never => { throw new BadRequestException(code); };
    if (!input || typeof input !== 'object') return fail('INVALID_TOOL_DEFINITION');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.name)) return fail('INVALID_TOOL_NAME');
    const displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : input.name;
    if (displayName.length > 100) return fail('INVALID_DISPLAY_NAME');
    if (typeof input.description !== 'string' || input.description.trim().length < 3 || input.description.length > 500) return fail('INVALID_TOOL_DESCRIPTION');
    let endpoint: string | undefined;
    let connectionProfile: string | undefined;
    let path: string;
    if (input.endpoint !== undefined) {
      if (input.connectionProfile !== undefined || input.path !== undefined) return fail('INVALID_ENDPOINT_CONFIGURATION');
      try {
        const target = await validateCustomToolEndpoint(input.endpoint);
        endpoint = target.endpoint;
        path = target.path;
      } catch (error) { return fail(error instanceof CustomToolError ? error.category : 'INVALID_ENDPOINT'); }
    } else {
      connectionProfile = input.connectionProfile;
      if (!connectionProfile || typeof input.path !== 'string') return fail('INVALID_ENDPOINT');
      let profile: ReturnType<typeof connectionProfiles>[string] | undefined;
      try { profile = connectionProfiles()[connectionProfile]; } catch { return fail('CONNECTION_PROFILES_INVALID'); }
      if (!profile) return fail('CONNECTION_PROFILE_UNAVAILABLE');
      try { safeToolPath(profile.baseUrl, input.path); } catch { return fail('INVALID_PATH'); }
      path = input.path;
    }
    let queryMappings: Record<string, string>;
    let inputSchema: unknown;
    if (input.parameters !== undefined) {
      if (input.inputSchema !== undefined || input.queryMappings !== undefined) return fail('INVALID_PARAMETER_CONFIGURATION');
      const parameters = input.parameters;
      if (!Array.isArray(parameters) || parameters.length > 20) return fail('INVALID_PARAMETERS');
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      queryMappings = {};
      for (const parameter of parameters) {
        if (!parameter || typeof parameter.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameter.name) || Object.hasOwn(properties, parameter.name)
          || !['string', 'number', 'integer', 'boolean'].includes(parameter.type)
          || parameter.description !== undefined && (typeof parameter.description !== 'string' || parameter.description.length > 300)
          || parameter.required !== undefined && typeof parameter.required !== 'boolean') return fail('INVALID_PARAMETER');
        const queryParameter = parameter.queryParameter ?? parameter.name;
        if (typeof queryParameter !== 'string' || !/^[A-Za-z0-9_.~-]{1,80}$/.test(queryParameter) || Object.hasOwn(queryMappings, queryParameter)) return fail('INVALID_QUERY_PARAMETER');
        properties[parameter.name] = { type: parameter.type, ...(parameter.description ? { description: parameter.description } : {}) };
        if (parameter.required) required.push(parameter.name);
        queryMappings[queryParameter] = parameter.name;
      }
      inputSchema = { type: 'object', properties, required, additionalProperties: false };
    } else {
      inputSchema = input.inputSchema;
      queryMappings = input.queryMappings ?? {};
    }
    const outputSchema = input.outputSchema ?? DEFAULT_OUTPUT_SCHEMA;
    try { jsonSchema(inputSchema); jsonSchema(outputSchema); } catch { return fail('INVALID_SCHEMA'); }
    const properties = (inputSchema as any).properties as Record<string, unknown>;
    if (!queryMappings || typeof queryMappings !== 'object' || Array.isArray(queryMappings) || Object.keys(queryMappings).length > 20
      || Object.entries(queryMappings).some(([param, key]) => !/^[A-Za-z0-9_.~-]{1,80}$/.test(param) || typeof key !== 'string' || !Object.hasOwn(properties, key))) return fail('INVALID_QUERY_MAPPINGS');
    if (input.auth !== undefined && input.auth !== null) {
      if (!['Authorization','X-API-Key'].includes(input.auth.headerName)
        || input.auth.secret !== undefined && (typeof input.auth.secret !== 'string' || input.auth.secret.length < 8 || input.auth.secret.length > 2000)
        || /[\u0000-\u001f\u007f]/.test(input.auth.secret ?? '')
        || (input.auth.prefix ?? '').length > 30 || /[\r\n]/.test(input.auth.prefix ?? '')) return fail('INVALID_AUTH_CONFIGURATION');
    }
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 30000)) return fail('INVALID_TIMEOUT');
    if (input.maxResponseBytes !== undefined && (!Number.isInteger(input.maxResponseBytes) || input.maxResponseBytes < 256 || input.maxResponseBytes > 1_000_000)) return fail('INVALID_RESPONSE_LIMIT');
    return { ...input, endpoint, connectionProfile, path, queryMappings, inputSchema, outputSchema,
      displayName, description: input.description.trim(), auth: input.auth ?? null };
  }

  private db() {
    if (!this.prisma) throw new Error('CUSTOM_TOOL_DATABASE_UNAVAILABLE');
    return this.prisma as any;
  }
  private async findTool(id: string) {
    if (!UUID.test(id)) throw new NotFoundException('CUSTOM_TOOL_NOT_FOUND');
    const row = await this.db().customTool.findFirst({ where: { id, archivedAt: null } });
    if (!row) throw new NotFoundException('CUSTOM_TOOL_NOT_FOUND');
    return row;
  }
  private publicTool(row: any) {
    let endpoint = row.endpointUrl ?? null;
    if (!endpoint) {
      try {
        const profile = connectionProfiles()[row.connectionProfile];
        if (profile) endpoint = safeToolPath(profile.baseUrl, row.path).href;
      } catch { /* Legacy profile may have been removed. */ }
    }
    const properties = row.inputSchema?.properties;
    const parameters = properties && typeof properties === 'object' && !Array.isArray(properties)
      ? Object.entries(properties).flatMap(([name, schema]: [string, any]) => ['string', 'number', 'integer', 'boolean'].includes(schema?.type) ? [{
          name, type: schema.type, required: row.inputSchema.required?.includes(name) ?? false,
          ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
          queryParameter: Object.entries(row.queryMappings ?? {}).find(([, key]) => key === name)?.[0] ?? name,
        }] : [])
      : [];
    return {
      id: row.id, name: row.name, displayName: row.displayName, description: row.description, type: row.type,
      endpoint, parameters, connectionProfile: row.connectionProfile, path: row.path, queryMappings: row.queryMappings,
      inputSchema: row.inputSchema, outputSchema: row.outputSchema, authSecretRef: row.authSecretId ?? null,
      authSecretConfigured: Boolean(row.authSecretId), enabled: row.enabled, effectClassification: row.effectClassification,
      timeoutMs: row.timeoutMs, maxResponseBytes: row.maxResponseBytes, configurationVersion: row.configurationVersion,
      createdAt: row.createdAt, updatedAt: row.updatedAt, createdBy: row.createdBy, updatedBy: row.updatedBy,
    };
  }
  private async audit(action: string, userId: string, toolId: string, version: number) {
    await this.db().auditLog.create({ data: { userId, action, details: { toolId, version } } });
  }
  private sanitizeSample(value: any, depth = 0): any {
    if (depth > 6) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 20).map(item => this.sanitizeSample(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) =>
      [key, /(secret|token|password|authorization|cookie|api[_-]?key)/i.test(key) ? '[redacted]' : this.sanitizeSample(child, depth + 1)]));
    if (typeof value === 'string' && value.length > 1000) return value.slice(0, 1000) + '…';
    return value;
  }
  private redactCredential(value: any, credential: string): any {
    if (!credential) return value;
    if (typeof value === 'string') return value.split(credential).join('[redacted]');
    if (Array.isArray(value)) return value.map(item => this.redactCredential(item, credential));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.redactCredential(child, credential)]));
    return value;
  }
}
