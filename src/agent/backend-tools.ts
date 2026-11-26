import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { decryptCredential, encryptCredential } from '../llm-admin/provider-credentials.js';
import {
  connectionProfiles,
  customToolEndpoint,
  CustomToolError,
  executeHttpTool,
  executeInternalJsonRequest,
  jsonSchema,
  safeToolPath,
  validateCustomToolEndpoint,
} from './custom-http-tool.js';

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
type ToolParameter = {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  required?: boolean;
  description?: string;
  queryParameter?: string;
};
type ToolDefinition = {
  name: string;
  displayName?: string;
  description: string;
  endpoint?: string;
  connectionProfile?: string;
  path?: string;
  parameters?: ToolParameter[];
  queryMappings?: Record<string, string>;
  inputSchema?: unknown;
  outputSchema?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  auth?: { headerName: 'Authorization' | 'X-API-Key'; prefix?: string; secret?: string } | null;
  connectionCredentialId?: string | null;
  allowedUserIds?: string[];
};
const DEFAULT_OUTPUT_SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_ID = (id: string) => 'custom_' + id.replaceAll('-', '');
const refreshCookieName = 'sitepilot_refresh';
function tokenFromResponse(response: { body: unknown; statusCode: number; responseHeaders: Record<string, string | string[] | undefined> }) {
  const body = response.body as Record<string, unknown> | null;
  const accessToken = body && typeof body.accessToken === 'string' ? body.accessToken : '';
  const expiresIn = body && Number.isInteger(body.expiresIn) ? Number(body.expiresIn) : 0;
  const cookies = response.responseHeaders['set-cookie'];
  const cookieLines = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  const refreshCookie = cookieLines
    .map((line) => line.split(';', 1)[0] ?? '')
    .find((line) => line.startsWith(`${refreshCookieName}=`))
    ?.slice(refreshCookieName.length + 1);
  if (response.statusCode < 200 || response.statusCode >= 300 || !accessToken || accessToken.length > 8192 || !refreshCookie || refreshCookie.length > 4096 || expiresIn < 1 || expiresIn > 86_400)
    throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED', response.statusCode);
  return { accessToken, refreshCookie, expiresIn };
}
function encryptToolCredential(secret: string) {
  try {
    return encryptCredential(secret);
  } catch (error) {
    if (
      error instanceof Error &&
      ['LLM_CREDENTIALS_ENCRYPTION_KEY_REQUIRED', 'LLM_CREDENTIALS_ENCRYPTION_KEY_INVALID'].includes(
        error.message,
      )
    )
      throw new ServiceUnavailableException('CUSTOM_TOOL_ENCRYPTION_NOT_CONFIGURED');
    throw error;
  }
}
const SENSITIVE_ARGUMENT_KEY =
  /(?:password|secret|token|authorization|cookie|api[_-]?key|credential|private[_-]?key)/i;
const redactArguments = (value: unknown, credential: string, depth = 0): unknown => {
  if (typeof value === 'string')
    return value
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,})\b/g, '[redacted]')
      .replace(
        credential ? new RegExp(credential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/,
        '[redacted]',
      );
  if (Array.isArray(value))
    return depth < 8 ? value.map((item) => redactArguments(item, credential, depth + 1)) : '[redacted]';
  if (value && typeof value === 'object') {
    if (depth >= 8) return '[redacted]';
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_ARGUMENT_KEY.test(key) ? '[redacted]' : redactArguments(item, credential, depth + 1),
      ]),
    );
  }
  return value;
};
const idFromCall = (id: string) =>
  id.startsWith('custom_') && /^[0-9a-f]{32}$/i.test(id.slice(7))
    ? id.slice(7).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
    : undefined;

@Injectable()
export class BackendTools {
  private readonly tools = new Map<string, ReadTool>();
  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  private authProfile(profileId: string) {
    const allowlist = (process.env.CUSTOM_TOOL_AUTH_ENDPOINT_PROFILES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    let profile: ReturnType<typeof connectionProfiles>[string] | undefined;
    try { profile = connectionProfiles()[profileId]; } catch { /* handled below */ }
    if (!profile || !allowlist.includes(profileId) || profile.baseUrl.protocol !== 'https:' || profile.baseUrl.pathname !== '/')
      throw new BadRequestException('AUTH_ENDPOINT_NOT_ALLOWED');
    return profile;
  }

  listConnectionCredentials(profileId: string) {
    this.authProfile(profileId);
    return this.db().customToolConnectionCredential.findMany({
      where: { profileId },
      select: { id: true, name: true, authStrategy: true, tokenExpiresAt: true, lastRefreshedAt: true, credentialVersion: true, authStatus: true },
      orderBy: { name: 'asc' },
    });
  }

  async loginConnectionCredential(profileId: string, name: string, email: string, password: string, userId: string) {
    const profile = this.authProfile(profileId);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !email || email.length > 254 || !password || password.length > 1024)
      throw new BadRequestException('INVALID_CONNECTION_CREDENTIAL');
    let result: ReturnType<typeof tokenFromResponse>;
    try {
      result = tokenFromResponse(await executeInternalJsonRequest({
        profile,
        path: '/api/v1/auth/login',
        body: { email, password },
      }));
    } catch (error) {
      if (error instanceof CustomToolError) throw new BadRequestException(error.category);
      throw error;
    }
    const access = encryptToolCredential(result.accessToken);
    const refresh = encryptToolCredential(result.refreshCookie);
    const db = this.db();
    const row = await db.customToolConnectionCredential.upsert({
      where: { profileId_name: { profileId, name } },
      create: {
        profileId, name, authStrategy: 'ATOMIC_COOKIE_REFRESH',
        accessTokenCiphertext: access.ciphertext, accessTokenIv: access.iv, accessTokenAuthTag: access.authTag,
        refreshCookieCiphertext: refresh.ciphertext, refreshCookieIv: refresh.iv, refreshCookieAuthTag: refresh.authTag,
        tokenExpiresAt: new Date(Date.now() + result.expiresIn * 1000), lastRefreshedAt: new Date(),
        authStatus: 'ACTIVE', createdBy: userId,
      },
      update: {
        authStrategy: 'ATOMIC_COOKIE_REFRESH',
        accessTokenCiphertext: access.ciphertext, accessTokenIv: access.iv, accessTokenAuthTag: access.authTag,
        refreshCookieCiphertext: refresh.ciphertext, refreshCookieIv: refresh.iv, refreshCookieAuthTag: refresh.authTag,
        tokenExpiresAt: new Date(Date.now() + result.expiresIn * 1000), lastRefreshedAt: new Date(),
        credentialVersion: { increment: 1 }, refreshLeaseId: null, refreshLeaseUntil: null, authStatus: 'ACTIVE',
      },
      select: { id: true, profileId: true, name: true, authStrategy: true, tokenExpiresAt: true, lastRefreshedAt: true, credentialVersion: true, authStatus: true },
    });
    return row;
  }

  private async refreshConnectionCredential(initial: any, force: boolean) {
    const db = this.db().customToolConnectionCredential;
    const originalVersion = initial.credentialVersion;
    const profile = this.authProfile(initial.profileId);
    const lockId = randomUUID();
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const latest = await db.findUnique({ where: { id: initial.id } });
      if (!latest || latest.authStatus !== 'ACTIVE') throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
      if (latest.credentialVersion > originalVersion || (!force && latest.tokenExpiresAt.getTime() > Date.now() + 30_000))
        return decryptCredential({
          ciphertext: latest.accessTokenCiphertext,
          iv: latest.accessTokenIv,
          authTag: latest.accessTokenAuthTag,
        });
      const now = new Date();
      const claim = await db.updateMany({
        where: {
          id: latest.id,
          credentialVersion: latest.credentialVersion,
          authStatus: 'ACTIVE',
          OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
        },
        data: { refreshLeaseId: lockId, refreshLeaseUntil: new Date(now.getTime() + 20_000) },
      });
      if (claim.count !== 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      try {
        const refreshCookie = decryptCredential({
          ciphertext: latest.refreshCookieCiphertext,
          iv: latest.refreshCookieIv,
          authTag: latest.refreshCookieAuthTag,
        });
        const result = tokenFromResponse(await executeInternalJsonRequest({
          profile,
          path: '/api/v1/auth/refresh',
          body: {},
          headers: { cookie: `${refreshCookieName}=${refreshCookie}` },
        }));
        const access = encryptToolCredential(result.accessToken);
        const refresh = encryptToolCredential(result.refreshCookie);
        const saved = await db.updateMany({
          where: { id: latest.id, credentialVersion: latest.credentialVersion, refreshLeaseId: lockId },
          data: {
            accessTokenCiphertext: access.ciphertext, accessTokenIv: access.iv, accessTokenAuthTag: access.authTag,
            refreshCookieCiphertext: refresh.ciphertext, refreshCookieIv: refresh.iv, refreshCookieAuthTag: refresh.authTag,
            tokenExpiresAt: new Date(Date.now() + result.expiresIn * 1000), lastRefreshedAt: new Date(),
            credentialVersion: { increment: 1 }, refreshLeaseId: null, refreshLeaseUntil: null, authStatus: 'ACTIVE',
          },
        });
        if (saved.count === 1) return result.accessToken;
      } catch {
        await db.updateMany({
          where: { id: latest.id, credentialVersion: latest.credentialVersion, refreshLeaseId: lockId },
          data: { authStatus: 'EXPIRED', refreshLeaseId: null, refreshLeaseUntil: null },
        });
        throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
      }
    }
    throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
  }

  register<T extends z.ZodType>(
    tool: Omit<ReadTool, 'inputSchema' | 'execute' | 'validateArgs'> & {
      input: T;
      execute: (args: z.output<T>, principal: AuthPrincipal, signal: AbortSignal) => Promise<string>;
    },
  ) {
    backendCallSchema.shape.id.parse(tool.id);
    const description = z.string().trim().min(1).max(300).parse(tool.description);
    if (this.tools.has(tool.id) || this.tools.size >= 16)
      throw new Error('BACKEND_TOOL_REGISTRATION_REJECTED');
    const inputSchema = z.toJSONSchema(tool.input);
    if (JSON.stringify(inputSchema).length > 2000) throw new Error('BACKEND_TOOL_SCHEMA_TOO_LARGE');
    this.tools.set(tool.id, {
      id: tool.id,
      authorize: tool.authorize,
      description,
      inputSchema,
      validateArgs: (args) => tool.input.safeParse(args).success,
      execute: (args, principal, signal) =>
        tool.execute(tool.input.parse(args) as z.output<T>, principal, signal),
    });
  }

  async catalog(principal: AuthPrincipal) {
    const built = [...this.tools.values()]
      .filter((tool) => tool.authorize(principal))
      .map((tool) => ({ id: tool.id, description: tool.description, input: tool.inputSchema }));
    if (!this.prisma) return built;
    let profiles: ReturnType<typeof connectionProfiles> = {};
    try {
      profiles = connectionProfiles();
    } catch {
      /* Direct endpoints do not use server profiles. */
    }
    const rows =
      principal.userId && principal.authMethod === 'jwt'
        ? await (this.prisma as any).customTool.findMany({
            where: { enabled: true, archivedAt: null },
            orderBy: { name: 'asc' },
            take: 1000,
          })
        : [];
    const candidates = rows
      .filter((row: any) =>
        (row.endpointUrl || profiles[row.connectionProfile]) &&
        (!row.connectionCredentialId || row.allowedUserIds?.includes(principal.userId)),
      )
      .map((row: any) => ({
        id: TOOL_ID(row.id),
        name: row.name,
        displayName: row.displayName,
        description: row.description,
        input: row.inputSchema,
        version: row.configurationVersion,
      }));
    const bounded: any[] = [];
    let promptSize = 0;
    for (const tool of [...built, ...candidates]) {
      if (bounded.length >= 48) break;
      const size = Buffer.byteLength(JSON.stringify(tool), 'utf8');
      if (size <= 24000 && promptSize + size <= 24000) {
        bounded.push(tool);
        promptSize += size;
      }
    }
    return bounded;
  }

  async hasEnabledTools(principal: AuthPrincipal) {
    if (!this.prisma || !principal.userId || principal.authMethod !== 'jwt') return false;
    try {
      let profiles: ReturnType<typeof connectionProfiles> = {};
      try {
        profiles = connectionProfiles();
      } catch {
        /* Direct endpoints do not use server profiles. */
      }
      const rows = await (this.prisma as any).customTool.findMany({
        where: { enabled: true, archivedAt: null },
        select: { endpointUrl: true, connectionProfile: true, connectionCredentialId: true, allowedUserIds: true },
        take: 1000,
      });
      return rows.some((row: any) => Boolean(
        (row.endpointUrl || profiles[row.connectionProfile]) &&
        (!row.connectionCredentialId || row.allowedUserIds?.includes(principal.userId)),
      ));
    } catch {
      return false;
    }
  }

  async execute(
    call: z.infer<typeof backendCallSchema>,
    principal: AuthPrincipal,
    parentSignal?: AbortSignal,
    onStart?: () => Promise<void>,
    context: {
      logicalRequestId?: string;
      conversationId?: string;
      snapshotVersion?: number;
      isTest?: boolean;
      allowDisabled?: boolean;
      onSchemaValidation?: (outcome: 'valid' | 'invalid') => void;
    } = {},
  ): Promise<unknown> {
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
      const output = await Promise.race([
        tool.execute(call.args, principal, signal),
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      ]);
      return z.string().min(1).max(8000).parse(output);
    }
    const toolId = idFromCall(call.id);
    if (!toolId || !this.prisma || !principal.userId || principal.authMethod !== 'jwt') return undefined;
    const db = this.prisma as any;
    const row = await db.customTool.findUnique({ where: { id: toolId }, include: { authSecret: true, connectionCredential: true } });
    if (!row || row.archivedAt || (!row.enabled && !context.allowDisabled)) return undefined;
    if (row.connectionCredentialId && !row.allowedUserIds?.includes(principal.userId))
      throw new CustomToolError('TOOL_ACCESS_DENIED');
    if (context.snapshotVersion !== undefined && row.configurationVersion !== context.snapshotVersion)
      throw new CustomToolError('TOOL_CONFIGURATION_CHANGED');
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
      if (row.connectionCredentialId) {
        const session = row.connectionCredential;
        if (!session || session.authStrategy !== 'ATOMIC_COOKIE_REFRESH' || session.authStatus !== 'ACTIVE')
          throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
        credential = await this.refreshConnectionCredential(session, false);
      } else if (row.authHeaderName) {
        if (!row.authSecret) throw new CustomToolError('AUTH_SECRET_UNAVAILABLE');
        credential = decryptCredential(row.authSecret);
        headers[row.authHeaderName] = (row.authPrefix ?? '') + credential;
      }
      const request = () => executeHttpTool({
          profile,
          path,
          queryMappings: row.queryMappings as Record<string, string>,
          inputSchema: row.inputSchema,
          outputSchema: row.outputSchema,
          args: call.args,
          headers: row.connectionCredentialId ? { authorization: `Bearer ${credential}` } : headers,
          timeoutMs: row.timeoutMs,
          maxResponseBytes: row.maxResponseBytes,
          signal,
          onInputValidation: context.onSchemaValidation,
          onValidatedArgs: (args) => { safeArguments = redactArguments(args, credential); },
        });
      let result;
      try {
        result = await request();
      } catch (error) {
        if (!row.connectionCredential || !(error instanceof CustomToolError) || error.statusCode !== 401)
          throw error;
        credential = await this.refreshConnectionCredential(row.connectionCredential, true);
        try {
          result = await request();
        } catch (retryError) {
          if (retryError instanceof CustomToolError && retryError.statusCode === 401)
            throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED', 401);
          throw retryError;
        }
      }
      success = true;
      return this.redactCredential(result.output, credential);
    } catch (error) {
      errorCategory = error instanceof CustomToolError ? error.category : 'EXECUTION_ERROR';
      throw error instanceof CustomToolError ? error : new CustomToolError(errorCategory);
    } finally {
      await db.customToolExecution
        .create({
          data: {
            toolId: row.id,
            toolVersion: row.configurationVersion,
            logicalRequestId: context.logicalRequestId ?? randomUUID(),
            conversationId: context.conversationId ?? null,
            userId: principal.userId,
            latencyMs: Math.max(0, Math.round(performance.now() - started)),
            success,
            errorCategory,
            arguments: safeArguments,
            isTest: context.isTest ?? false,
          },
        })
        .catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              event: 'custom_tool_execution_log_failed',
              errorType: error instanceof Error ? error.name : 'unknown',
            }),
          ),
        );
    }
  }

  listConnectionProfiles() {
    try {
      return Object.entries(connectionProfiles()).map(([id, profile]) => ({
        id,
        host: profile.baseUrl.hostname,
        trustedInternal: profile.trustedInternal,
      }));
    } catch (error) {
      throw new BadRequestException(
        error instanceof CustomToolError ? error.category : 'CONNECTION_PROFILES_INVALID',
      );
    }
  }

  async listCustomTools() {
    const rows = await this.db().customTool.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row: any) => this.publicTool(row));
  }

  async getCustomTool(id: string) {
    const row = await this.findTool(id);
    return this.publicTool(row);
  }

  async createCustomTool(input: ToolDefinition, userId: string) {
    const definition = await this.validateDefinition(input);
    await this.validateSharedCredential(definition);
    if (definition.auth && !definition.auth.secret) throw new BadRequestException('AUTH_SECRET_REQUIRED');
    const db = this.db();
    const secretId = definition.auth?.secret ? randomUUID() : undefined;
    const encrypted = definition.auth?.secret ? encryptToolCredential(definition.auth.secret) : undefined;
    try {
      const row = await db.$transaction(async (tx: any) => {
        if (encrypted)
          await tx.customToolSecret.create({ data: { id: secretId, ...encrypted, createdBy: userId } });
        const created = await tx.customTool.create({
          data: {
            name: definition.name,
            displayName: definition.displayName ?? definition.name,
            description: definition.description,
            type: 'HTTP_GET',
            endpointUrl: definition.endpoint ?? null,
            connectionProfile: definition.connectionProfile ?? 'direct',
            path: definition.path!,
            queryMappings: definition.queryMappings!,
            inputSchema: definition.inputSchema!,
            outputSchema: definition.outputSchema!,
            authHeaderName: definition.auth?.headerName ?? null,
            authPrefix: definition.auth?.prefix ?? null,
            authSecretId: secretId ?? null,
            connectionCredentialId: definition.connectionCredentialId ?? null,
            allowedUserIds: definition.allowedUserIds ?? [],
            timeoutMs: definition.timeoutMs ?? 10000,
            maxResponseBytes: definition.maxResponseBytes ?? 65536,
            enabled: false,
            effectClassification: 'READ_ONLY',
            createdBy: userId,
            updatedBy: userId,
          },
        });
        await tx.auditLog.create({
          data: {
            userId,
            action: 'CUSTOM_TOOL_CREATED',
            details: { toolId: created.id, version: created.configurationVersion },
          },
        });
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
    const connectionCredentialId = definition.connectionCredentialId !== undefined
      ? definition.connectionCredentialId
      : definition.auth !== undefined
        ? null
        : current.connectionCredentialId;
    await this.validateSharedCredential({
      ...definition,
      connectionCredentialId,
      allowedUserIds: definition.allowedUserIds ?? current.allowedUserIds ?? [],
    });
    if (definition.auth && connectionCredentialId)
      throw new BadRequestException('STATIC_AND_SHARED_AUTH_CONFLICT');
    if (definition.auth && !definition.auth.secret && !current.authSecretId)
      throw new BadRequestException('AUTH_SECRET_REQUIRED');
    const db = this.db();
    const secretId =
      definition.auth === undefined && !connectionCredentialId
        ? current.authSecretId
        : definition.auth === undefined && connectionCredentialId
          ? undefined
        : definition.auth === null
          ? undefined
          : definition.auth.secret
            ? randomUUID()
            : current.authSecretId;
    const encrypted = definition.auth?.secret ? encryptToolCredential(definition.auth.secret) : undefined;
    let row: any;
    try {
      row = await db.$transaction(async (tx: any) => {
        if (encrypted)
          await tx.customToolSecret.create({ data: { id: secretId, ...encrypted, createdBy: userId } });
        const updated = await tx.customTool.update({
          where: { id },
          data: {
            name: definition.name,
            displayName: definition.displayName ?? definition.name,
            description: definition.description,
            type: 'HTTP_GET',
            endpointUrl: definition.endpoint ?? null,
            connectionProfile: definition.connectionProfile ?? 'direct',
            path: definition.path!,
            queryMappings: definition.queryMappings!,
            inputSchema: definition.inputSchema!,
            outputSchema: definition.outputSchema!,
            authHeaderName: connectionCredentialId
              ? null
              : definition.auth === undefined ? current.authHeaderName : (definition.auth?.headerName ?? null),
            authPrefix: connectionCredentialId
              ? null
              : definition.auth === undefined ? current.authPrefix : (definition.auth?.prefix ?? null),
            authSecretId: connectionCredentialId || definition.auth === null
              ? null
              : definition.auth === undefined ? current.authSecretId : (secretId ?? null),
            connectionCredentialId,
            allowedUserIds: definition.allowedUserIds ?? current.allowedUserIds ?? [],
            timeoutMs: definition.timeoutMs ?? 10000,
            maxResponseBytes: definition.maxResponseBytes ?? 65536,
            configurationVersion: { increment: 1 },
            updatedBy: userId,
          },
        });
        if (current.authSecretId && current.authSecretId !== updated.authSecretId)
          await tx.customToolSecret.delete({ where: { id: current.authSecretId } });
        await tx.auditLog.create({
          data: {
            userId,
            action: 'CUSTOM_TOOL_UPDATED',
            details: { toolId: id, version: updated.configurationVersion },
          },
        });
        return updated;
      });
    } catch (error) {
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
        else if (!connectionProfiles()[current.connectionProfile])
          throw new BadRequestException('CONNECTION_PROFILE_UNAVAILABLE');
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException(
          error instanceof CustomToolError ? error.category : 'CONNECTION_PROFILES_INVALID',
        );
      }
    }
    const row = await this.db().customTool.update({
      where: { id },
      data: { enabled, configurationVersion: { increment: 1 }, updatedBy: userId },
    });
    await this.audit('CUSTOM_TOOL_TOGGLED', userId, id, row.configurationVersion);
    return this.publicTool(row);
  }

  async archiveCustomTool(id: string, userId: string) {
    const current = await this.findTool(id);
    const row = await this.db().$transaction(async (tx: any) => {
      const archived = await tx.customTool.update({
        where: { id },
        data: {
          enabled: false,
          archivedAt: new Date(),
          authSecretId: null,
          configurationVersion: { increment: 1 },
          updatedBy: userId,
        },
      });
      if (current.authSecretId) await tx.customToolSecret.delete({ where: { id: current.authSecretId } });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'CUSTOM_TOOL_ARCHIVED',
          details: { toolId: id, version: archived.configurationVersion },
        },
      });
      return archived;
    });
    return { id: row.id, archived: true };
  }

  async testCustomTool(id: string, sampleInput: unknown, userId: string) {
    const row = await this.findTool(id);
    const started = performance.now();
    try {
      const output = await this.execute(
        { id: TOOL_ID(row.id), args: sampleInput as Record<string, unknown> },
        { userId, tenantId: '', authMethod: 'jwt' },
        undefined,
        undefined,
        { snapshotVersion: row.configurationVersion, isTest: true, allowDisabled: true },
      );
      return {
        success: true,
        durationMs: Math.round(performance.now() - started),
        errorCategory: null,
        sampleOutput: this.sanitizeSample(output),
      };
    } catch (error) {
      return {
        success: false,
        durationMs: Math.round(performance.now() - started),
        errorCategory: error instanceof CustomToolError ? error.category : 'EXECUTION_ERROR',
      };
    }
  }

  async customToolExecutions(id: string, limit = 50, offset = 0) {
    await this.findTool(id);
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const rows = await this.db().customToolExecution.findMany({
      where: { toolId: id },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      skip: safeOffset,
    });
    return rows;
  }

  private async validateDefinition(input: ToolDefinition): Promise<ToolDefinition> {
    const fail = (code: string): never => {
      throw new BadRequestException(code);
    };
    if (!input || typeof input !== 'object') return fail('INVALID_TOOL_DEFINITION');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.name)) return fail('INVALID_TOOL_NAME');
    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim()
        : input.name;
    if (displayName.length > 100) return fail('INVALID_DISPLAY_NAME');
    if (
      typeof input.description !== 'string' ||
      input.description.trim().length < 3 ||
      input.description.length > 500
    )
      return fail('INVALID_TOOL_DESCRIPTION');
    let endpoint: string | undefined;
    let connectionProfile: string | undefined;
    let path: string;
    if (input.endpoint !== undefined) {
      if (input.connectionProfile !== undefined || input.path !== undefined)
        return fail('INVALID_ENDPOINT_CONFIGURATION');
      try {
        const target = await validateCustomToolEndpoint(input.endpoint);
        endpoint = target.endpoint;
        path = target.path;
      } catch (error) {
        return fail(error instanceof CustomToolError ? error.category : 'INVALID_ENDPOINT');
      }
    } else {
      connectionProfile = input.connectionProfile;
      if (!connectionProfile || typeof input.path !== 'string') return fail('INVALID_ENDPOINT');
      let profile: ReturnType<typeof connectionProfiles>[string] | undefined;
      try {
        profile = connectionProfiles()[connectionProfile];
      } catch {
        return fail('CONNECTION_PROFILES_INVALID');
      }
      if (!profile) return fail('CONNECTION_PROFILE_UNAVAILABLE');
      try {
        safeToolPath(profile.baseUrl, input.path);
      } catch {
        return fail('INVALID_PATH');
      }
      path = input.path;
    }
    let queryMappings: Record<string, string>;
    let inputSchema: unknown;
    if (input.parameters !== undefined) {
      if (input.inputSchema !== undefined || input.queryMappings !== undefined)
        return fail('INVALID_PARAMETER_CONFIGURATION');
      const parameters = input.parameters;
      if (!Array.isArray(parameters) || parameters.length > 20) return fail('INVALID_PARAMETERS');
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      queryMappings = {};
      for (const parameter of parameters) {
        if (
          !parameter ||
          typeof parameter.name !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameter.name) ||
          Object.hasOwn(properties, parameter.name) ||
          !['string', 'number', 'integer', 'boolean'].includes(parameter.type) ||
          (parameter.description !== undefined &&
            (typeof parameter.description !== 'string' || parameter.description.length > 300)) ||
          (parameter.required !== undefined && typeof parameter.required !== 'boolean')
        )
          return fail('INVALID_PARAMETER');
        const queryParameter = parameter.queryParameter ?? parameter.name;
        if (
          typeof queryParameter !== 'string' ||
          !/^[A-Za-z0-9_.~-]{1,80}$/.test(queryParameter) ||
          Object.hasOwn(queryMappings, queryParameter)
        )
          return fail('INVALID_QUERY_PARAMETER');
        properties[parameter.name] = {
          type: parameter.type,
          ...(parameter.description ? { description: parameter.description } : {}),
        };
        if (parameter.required) required.push(parameter.name);
        queryMappings[queryParameter] = parameter.name;
      }
      inputSchema = { type: 'object', properties, required, additionalProperties: false };
    } else {
      inputSchema = input.inputSchema;
      queryMappings = input.queryMappings ?? {};
    }
    const outputSchema = input.outputSchema ?? DEFAULT_OUTPUT_SCHEMA;
    try {
      jsonSchema(inputSchema);
      jsonSchema(outputSchema, true);
    } catch {
      return fail('INVALID_SCHEMA');
    }
    const properties = (inputSchema as any).properties as Record<string, unknown>;
    if (
      !queryMappings ||
      typeof queryMappings !== 'object' ||
      Array.isArray(queryMappings) ||
      Object.keys(queryMappings).length > 20 ||
      Object.entries(queryMappings).some(
        ([param, key]) =>
          !/^[A-Za-z0-9_.~-]{1,80}$/.test(param) ||
          typeof key !== 'string' ||
          !Object.hasOwn(properties, key),
      )
    )
      return fail('INVALID_QUERY_MAPPINGS');
    if (input.auth !== undefined && input.auth !== null) {
      if (
        !['Authorization', 'X-API-Key'].includes(input.auth.headerName) ||
        (input.auth.secret !== undefined &&
          (typeof input.auth.secret !== 'string' ||
            input.auth.secret.length < 8 ||
            input.auth.secret.length > 2000)) ||
        /[\u0000-\u001f\u007f]/.test(input.auth.secret ?? '') ||
        (input.auth.prefix ?? '').length > 30 ||
        /[\r\n]/.test(input.auth.prefix ?? '')
      )
        return fail('INVALID_AUTH_CONFIGURATION');
    }
    if (input.connectionCredentialId !== undefined && input.connectionCredentialId !== null &&
      !UUID.test(input.connectionCredentialId)) return fail('INVALID_CONNECTION_CREDENTIAL');
    if (input.allowedUserIds !== undefined &&
      (!Array.isArray(input.allowedUserIds) || input.allowedUserIds.length > 100 ||
        input.allowedUserIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
        new Set(input.allowedUserIds).size !== input.allowedUserIds.length))
      return fail('INVALID_TOOL_ACCESS_POLICY');
    if (input.connectionCredentialId && input.auth && input.auth !== null)
      return fail('STATIC_AND_SHARED_AUTH_CONFLICT');
    if (
      input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 30000)
    )
      return fail('INVALID_TIMEOUT');
    if (
      input.maxResponseBytes !== undefined &&
      (!Number.isInteger(input.maxResponseBytes) ||
        input.maxResponseBytes < 256 ||
        input.maxResponseBytes > 1_000_000)
    )
      return fail('INVALID_RESPONSE_LIMIT');
    return {
      ...input,
      endpoint,
      connectionProfile,
      path,
      queryMappings,
      inputSchema,
      outputSchema,
      displayName,
      description: input.description.trim(),
      auth: input.auth,
      connectionCredentialId: input.connectionCredentialId,
      allowedUserIds: input.allowedUserIds,
    };
  }

  private db() {
    if (!this.prisma) throw new Error('CUSTOM_TOOL_DATABASE_UNAVAILABLE');
    return this.prisma as any;
  }
  private async validateSharedCredential(definition: ToolDefinition) {
    if (!definition.connectionCredentialId) return;
    const credential = await this.db().customToolConnectionCredential.findUnique({
      where: { id: definition.connectionCredentialId },
      select: { id: true, profileId: true, authStatus: true },
    });
    if (!credential || credential.authStatus !== 'ACTIVE')
      throw new BadRequestException('CONNECTION_CREDENTIAL_UNAVAILABLE');
    if (definition.endpoint || definition.connectionProfile !== credential.profileId)
      throw new BadRequestException('CONNECTION_CREDENTIAL_PROFILE_MISMATCH');
    if (!definition.allowedUserIds?.length)
      throw new BadRequestException('TOOL_ACCESS_POLICY_REQUIRED');
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
      } catch {
        /* Legacy profile may have been removed. */
      }
    }
    const properties = row.inputSchema?.properties;
    const parameters =
      properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.entries(properties).flatMap(([name, schema]: [string, any]) =>
            ['string', 'number', 'integer', 'boolean'].includes(schema?.type)
              ? [
                  {
                    name,
                    type: schema.type,
                    required: row.inputSchema.required?.includes(name) ?? false,
                    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
                    queryParameter:
                      Object.entries(row.queryMappings ?? {}).find(([, key]) => key === name)?.[0] ?? name,
                  },
                ]
              : [],
          )
        : [];
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      type: row.type,
      endpoint,
      parameters,
      connectionProfile: row.connectionProfile,
      path: row.path,
      queryMappings: row.queryMappings,
      inputSchema: row.inputSchema,
      outputSchema: row.outputSchema,
      authHeaderName: row.authHeaderName ?? null,
      authPrefix: row.authPrefix ?? null,
      connectionCredentialId: row.connectionCredentialId ?? null,
      allowedUserIds: row.allowedUserIds ?? [],
      authSecretRef: row.authSecretId ?? null,
      authSecretConfigured: Boolean(row.authSecretId),
      enabled: row.enabled,
      effectClassification: row.effectClassification,
      timeoutMs: row.timeoutMs,
      maxResponseBytes: row.maxResponseBytes,
      configurationVersion: row.configurationVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
    };
  }
  private async audit(action: string, userId: string, toolId: string, version: number) {
    await this.db().auditLog.create({ data: { userId, action, details: { toolId, version } } });
  }
  private sanitizeSample(value: any, depth = 0): any {
    if (depth > 6) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => this.sanitizeSample(item, depth + 1));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 100)
          .map(([key, child]) => [
            key,
            /(secret|token|password|authorization|cookie|api[_-]?key)/i.test(key)
              ? '[redacted]'
              : this.sanitizeSample(child, depth + 1),
          ]),
      );
    if (typeof value === 'string' && value.length > 1000) return value.slice(0, 1000) + '…';
    return value;
  }
  private redactCredential(value: any, credential: string): any {
    if (!credential) return value;
    if (typeof value === 'string') return value.split(credential).join('[redacted]');
    if (Array.isArray(value)) return value.map((item) => this.redactCredential(item, credential));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, this.redactCredential(child, credential)]),
      );
    return value;
  }
}
