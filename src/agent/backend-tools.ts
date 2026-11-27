import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { decryptCredential, encryptCredential } from '../llm-admin/provider-credentials.js';
import {
  customToolEndpoint,
  CustomToolError,
  executeHttpTool,
  jsonSchema,
  safeToolPath,
  validateCustomToolEndpoint,
  type ConnectionProfile,
} from './custom-http-tool.js';
import {
  AtomicCookieCredentialAdapter,
  OAuth2RefreshCredentialAdapter,
  type CustomToolCredentialAdapter,
} from './custom-tool-credential-adapters.js';

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
  authScope?: 'NONE' | 'SHARED' | 'PER_USER';
  connectionCredentialId?: string | null;
  allowedUserIds?: string[];
};
const DEFAULT_OUTPUT_SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_ID = (id: string) => 'custom_' + id.replaceAll('-', '');
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
  private readonly atomicCredentials = new AtomicCookieCredentialAdapter();
  private readonly oauthCredentials = new OAuth2RefreshCredentialAdapter();
  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  private async authProfile(profileId: string, tenantId: string) {
    const profile = await this.resolveConnectionProfile(profileId, tenantId);
    if (!profile || profile.baseUrl.pathname !== '/')
      throw new BadRequestException('AUTH_ENDPOINT_NOT_ALLOWED');
    return profile;
  }

  private async atomicUserAuthProfile(profileId: string, tenantId: string) {
    const profile = await this.authProfile(profileId, tenantId);
    const record = await this.db().customToolConnectionProfile.findUnique({
      where: { tenantId_id: { tenantId, id: profileId } },
    });
    if (!this.atomicPerUserLoginAvailable(record))
      throw new BadRequestException('ATOMIC_ORIGIN_NOT_APPROVED');
    return profile;
  }

  private atomicPerUserLoginAvailable(profile: any) {
    if (!profile?.enabled || profile.authStrategy !== 'ATOMIC_COOKIE_REFRESH') return false;
    try {
      const target = customToolEndpoint(profile.baseUrl, { allowLocalHttp: profile.allowLocalHttp });
      return target.profile.baseUrl.pathname === '/';
    } catch {
      return false;
    }
  }

  private oauthPerUserConnectionAvailable(profile: any) {
    if (!profile?.enabled || profile.authStrategy !== 'OAUTH2_REFRESH' || !profile.tokenUrl || !profile.clientId)
      return false;
    try {
      customToolEndpoint(profile.baseUrl, { allowLocalHttp: profile.allowLocalHttp });
      customToolEndpoint(profile.tokenUrl, { allowLocalHttp: profile.allowLocalHttp });
      return true;
    } catch {
      return false;
    }
  }

  private async connectionProfilesFor(tenantId: string) {
    const profiles: Record<string, ConnectionProfile> = {};
    const rows = await this.db().customToolConnectionProfile.findMany({ where: { tenantId, enabled: true } });
    for (const row of rows) {
      try {
        const target = customToolEndpoint(row.baseUrl, { allowLocalHttp: row.allowLocalHttp });
        profiles[row.id] = target.profile;
      } catch {
        // Invalid database values fail closed.
      }
    }
    return profiles;
  }

  private async resolveConnectionProfile(profileId: string, tenantId: string) {
    const row = await this.db().customToolConnectionProfile.findUnique({
      where: { tenantId_id: { tenantId, id: profileId } },
    });
    if (row) {
      if (!row.enabled) return undefined;
      try {
        return customToolEndpoint(row.baseUrl, { allowLocalHttp: row.allowLocalHttp }).profile;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async listConnectionCredentials(profileId: string, tenantId: string) {
    await this.authProfile(profileId, tenantId);
    return this.db().customToolConnectionCredential.findMany({
      where: { profileId, tenantId: '*', userId: '*' },
      select: { id: true, name: true, authStrategy: true, tokenExpiresAt: true, lastRefreshedAt: true, credentialVersion: true, authStatus: true },
      orderBy: { name: 'asc' },
    });
  }

  async connectUserCredential(profileId: string, input: { accessToken: string; refreshToken: string; expiresIn: number }, principal: AuthPrincipal) {
    const profile = await this.db().customToolConnectionProfile.findUnique({
      where: { tenantId_id: { tenantId: principal.tenantId, id: profileId } },
    });
    if (!profile?.enabled || profile.authStrategy !== 'OAUTH2_REFRESH')
      throw new BadRequestException('PER_USER_AUTH_UNAVAILABLE');
    const validToken = (value: unknown) => typeof value === 'string' && value.length >= 8 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
    if (!validToken(input?.accessToken) || !validToken(input?.refreshToken) ||
      !Number.isInteger(input?.expiresIn) || input.expiresIn < 1 || input.expiresIn > 86_400)
      throw new BadRequestException('INVALID_CONNECTION_CREDENTIAL');
    await this.storePerUserCredential(profileId, principal, 'OAUTH2_REFRESH', input.accessToken, input.refreshToken, input.expiresIn);
    return this.userCredentialStatus(profileId, principal);
  }

  async connectAtomicUserCredential(profileId: string, email: string, password: string, principal: AuthPrincipal) {
    const profile = await this.atomicUserAuthProfile(profileId, principal.tenantId);
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120 ||
      typeof password !== 'string' || password.length < 8 || password.length > 1024)
      throw new BadRequestException('INVALID_ATOMIC_CREDENTIALS');
    try {
      const tokens = await this.atomicCredentials.login(profile, email, password);
      if (!tokens.refreshToken) throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
      await this.storePerUserCredential(profileId, principal, 'ATOMIC_COOKIE_REFRESH', tokens.accessToken, tokens.refreshToken, tokens.expiresIn);
      return this.userCredentialStatus(profileId, principal);
    } catch (error) {
      if (error instanceof CustomToolError) {
        if (error.statusCode === 401) throw new UnauthorizedException('ATOMIC_CREDENTIALS_INVALID');
        throw new BadGatewayException('ATOMIC_CONNECTION_FAILED');
      }
      throw error;
    }
  }

  private async storePerUserCredential(
    profileId: string,
    principal: AuthPrincipal,
    authStrategy: 'OAUTH2_REFRESH' | 'ATOMIC_COOKIE_REFRESH',
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
  ) {
    const access = encryptToolCredential(accessToken);
    const refresh = encryptToolCredential(refreshToken);
    const refreshFields = authStrategy === 'ATOMIC_COOKIE_REFRESH'
      ? { refreshCookieCiphertext: refresh.ciphertext, refreshCookieIv: refresh.iv, refreshCookieAuthTag: refresh.authTag,
          refreshTokenCiphertext: null, refreshTokenIv: null, refreshTokenAuthTag: null }
      : { refreshCookieCiphertext: null, refreshCookieIv: null, refreshCookieAuthTag: null,
          refreshTokenCiphertext: refresh.ciphertext, refreshTokenIv: refresh.iv, refreshTokenAuthTag: refresh.authTag };
    const where = {
      profileId_name_tenantId_userId: {
        profileId,
        name: 'per-user',
        tenantId: principal.tenantId,
        userId: principal.userId,
      },
    };
    const db = this.db().customToolConnectionCredential;
    await db.upsert({
      where,
      create: {
        ...where.profileId_name_tenantId_userId,
        authStrategy,
        accessTokenCiphertext: access.ciphertext,
        accessTokenIv: access.iv,
        accessTokenAuthTag: access.authTag,
        ...refreshFields,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        lastRefreshedAt: new Date(),
        authStatus: 'ACTIVE',
        credentialVersion: 1,
        createdBy: principal.userId,
      },
      update: {
        authStrategy,
        accessTokenCiphertext: access.ciphertext,
        accessTokenIv: access.iv,
        accessTokenAuthTag: access.authTag,
        ...refreshFields,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        lastRefreshedAt: new Date(),
        credentialVersion: { increment: 1 },
        refreshLeaseId: null,
        refreshLeaseUntil: null,
        authStatus: 'ACTIVE',
      },
    });
  }

  async disconnectUserCredential(profileId: string, principal: AuthPrincipal) {
    await this.db().customToolConnectionCredential.deleteMany({
      where: { profileId, name: 'per-user', tenantId: principal.tenantId, userId: principal.userId },
    });
    return this.userCredentialStatus(profileId, principal);
  }

  async userCredentialStatus(profileId: string, principal: AuthPrincipal) {
    const row = await this.db().customToolConnectionCredential.findUnique({
      where: {
        profileId_name_tenantId_userId: {
          profileId,
          name: 'per-user',
          tenantId: principal.tenantId,
          userId: principal.userId,
        },
      },
      select: { authStatus: true, tokenExpiresAt: true, lastRefreshedAt: true },
    });
    return {
      connected: row?.authStatus === 'ACTIVE',
      authStatus: row?.authStatus ?? 'DISCONNECTED',
      tokenExpiresAt: row?.tokenExpiresAt ?? null,
      lastRefreshedAt: row?.lastRefreshedAt ?? null,
    };
  }

  async loginConnectionCredential(profileId: string, name: string, email: string, password: string, userId: string, tenantId: string) {
    const profile = await this.authProfile(profileId, tenantId);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !email || email.length > 254 || !password || password.length > 1024)
      throw new BadRequestException('INVALID_CONNECTION_CREDENTIAL');
    let result;
    try {
      result = await this.atomicCredentials.login(profile, email, password);
    } catch (error) {
      if (error instanceof CustomToolError) throw new BadRequestException(error.category);
      throw error;
    }
    const access = encryptToolCredential(result.accessToken);
    const refresh = encryptToolCredential(result.refreshToken!);
    const db = this.db();
    const row = await db.customToolConnectionCredential.upsert({
      where: { profileId_name_tenantId_userId: { profileId, name, tenantId: '*', userId: '*' } },
      create: {
        profileId, name, tenantId: '*', userId: '*', authStrategy: 'ATOMIC_COOKIE_REFRESH',
        accessTokenCiphertext: access.ciphertext, accessTokenIv: access.iv, accessTokenAuthTag: access.authTag,
        refreshCookieCiphertext: refresh.ciphertext, refreshCookieIv: refresh.iv, refreshCookieAuthTag: refresh.authTag,
        tokenExpiresAt: new Date(Date.now() + result.expiresIn * 1000), lastRefreshedAt: new Date(),
        authStatus: 'ACTIVE', createdBy: userId,
      },
      update: {
        authStrategy: 'ATOMIC_COOKIE_REFRESH',
        accessTokenCiphertext: access.ciphertext, accessTokenIv: access.iv, accessTokenAuthTag: access.authTag,
        refreshCookieCiphertext: refresh.ciphertext, refreshCookieIv: refresh.iv, refreshCookieAuthTag: refresh.authTag,
        tenantId: '*', userId: '*',
        tokenExpiresAt: new Date(Date.now() + result.expiresIn * 1000), lastRefreshedAt: new Date(),
        credentialVersion: { increment: 1 }, refreshLeaseId: null, refreshLeaseUntil: null, authStatus: 'ACTIVE',
      },
      select: { id: true, profileId: true, name: true, authStrategy: true, tokenExpiresAt: true, lastRefreshedAt: true, credentialVersion: true, authStatus: true },
    });
    return row;
  }

  private async refreshConnectionCredential(initial: any, force: boolean, tenantId: string) {
    const db = this.db().customToolConnectionCredential;
    const originalVersion = initial.credentialVersion;
    const lockId = randomUUID();
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const latest = await db.findUnique({ where: { id: initial.id } });
      if (!latest || latest.tenantId !== initial.tenantId || latest.userId !== initial.userId || latest.authStatus !== 'ACTIVE')
        throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
      if (latest.credentialVersion > originalVersion) {
        initial.credentialVersion = latest.credentialVersion;
        return decryptCredential({
          ciphertext: latest.accessTokenCiphertext,
          iv: latest.accessTokenIv,
          authTag: latest.accessTokenAuthTag,
        });
      }
      if (!force && latest.tokenExpiresAt.getTime() > Date.now() + 30_000)
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
        const atomic = latest.authStrategy === 'ATOMIC_COOKIE_REFRESH';
        const encryptedRefresh = atomic
          ? { ciphertext: latest.refreshCookieCiphertext, iv: latest.refreshCookieIv, authTag: latest.refreshCookieAuthTag }
          : latest.refreshTokenCiphertext && latest.refreshTokenIv && latest.refreshTokenAuthTag
            ? { ciphertext: latest.refreshTokenCiphertext, iv: latest.refreshTokenIv, authTag: latest.refreshTokenAuthTag }
            : null;
        if (!encryptedRefresh) throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
        const refreshToken = decryptCredential(encryptedRefresh);
        let adapter: CustomToolCredentialAdapter;
        let profile: ConnectionProfile;
        let adapterConfig: { tokenPath?: string; clientId?: string } | undefined;
        if (atomic) {
          adapter = this.atomicCredentials;
          profile = initial.tenantId === '*' ? await this.authProfile(initial.profileId, tenantId) : await this.atomicUserAuthProfile(initial.profileId, tenantId);
        } else if (latest.authStrategy === 'OAUTH2_REFRESH') {
          adapter = this.oauthCredentials;
          const record = await this.db().customToolConnectionProfile.findUnique({
            where: { tenantId_id: { tenantId, id: initial.profileId } },
          });
          if (!record?.enabled || record.authStrategy !== 'OAUTH2_REFRESH' || !record.tokenUrl || !record.clientId)
            throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
          const endpoint = customToolEndpoint(record.tokenUrl, { allowLocalHttp: record.allowLocalHttp });
          profile = endpoint.profile;
          adapterConfig = { tokenPath: endpoint.path, clientId: record.clientId };
        } else throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
        const result = await adapter.refresh(profile, refreshToken, adapterConfig);
        const access = encryptToolCredential(result.accessToken);
        const nextRefresh = result.refreshToken ? encryptToolCredential(result.refreshToken) : encryptedRefresh;
        const refreshFields = atomic
          ? { refreshCookieCiphertext: nextRefresh.ciphertext, refreshCookieIv: nextRefresh.iv, refreshCookieAuthTag: nextRefresh.authTag }
          : { refreshTokenCiphertext: nextRefresh.ciphertext, refreshTokenIv: nextRefresh.iv, refreshTokenAuthTag: nextRefresh.authTag };
        const saved = await db.updateMany({
          where: {
            id: latest.id,
            tenantId: latest.tenantId,
            userId: latest.userId,
            credentialVersion: latest.credentialVersion,
            refreshLeaseId: lockId,
          },
          data: {
            accessTokenCiphertext: access.ciphertext, accessTokenIv: access.iv, accessTokenAuthTag: access.authTag,
            ...refreshFields,
            tokenExpiresAt: new Date(Date.now() + result.expiresIn * 1000), lastRefreshedAt: new Date(),
            credentialVersion: { increment: 1 }, refreshLeaseId: null, refreshLeaseUntil: null, authStatus: 'ACTIVE',
          },
        });
        if (saved.count === 1) {
          initial.credentialVersion = latest.credentialVersion + 1;
          return result.accessToken;
        }
      } catch {
        await db.updateMany({
          where: {
            id: latest.id,
            tenantId: latest.tenantId,
            userId: latest.userId,
            credentialVersion: latest.credentialVersion,
            refreshLeaseId: lockId,
          },
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
    let profiles: Record<string, ConnectionProfile> = {};
    try { profiles = await this.connectionProfilesFor(principal.tenantId); } catch { /* Direct endpoints do not use profiles. */ }
    const rows =
      principal.userId && principal.authMethod === 'jwt'
        ? await (this.prisma as any).customTool.findMany({
            where: { enabled: true, archivedAt: null },
            orderBy: { name: 'asc' },
            take: 1000,
          })
        : [];
    const userProfileIds = rows.filter((row: any) => (row.authScope ?? this.toolAuthScope(row)) === 'PER_USER').map((row: any) => row.connectionProfile);
    const userCredentials = userProfileIds.length
      ? await (this.prisma as any).customToolConnectionCredential.findMany({
          where: { tenantId: principal.tenantId, userId: principal.userId, profileId: { in: userProfileIds }, name: 'per-user', authStatus: 'ACTIVE' },
          select: { profileId: true },
        }).catch(() => [])
      : [];
    const connectedProfiles = new Set(userCredentials.map((credential: any) => credential.profileId));
    const candidates = rows
      .filter((row: any) =>
        (row.endpointUrl || profiles[row.connectionProfile]) &&
        (!row.connectionCredentialId || row.allowedUserIds?.includes(principal.userId)) &&
        ((row.authScope ?? this.toolAuthScope(row)) !== 'PER_USER' || connectedProfiles.has(row.connectionProfile)),
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
      let profiles: Record<string, ConnectionProfile> = {};
      try { profiles = await this.connectionProfilesFor(principal.tenantId); } catch { /* Direct endpoints do not use profiles. */ }
      const rows = await (this.prisma as any).customTool.findMany({
        where: { enabled: true, archivedAt: null },
        select: { endpointUrl: true, connectionProfile: true, connectionCredentialId: true, allowedUserIds: true, authScope: true, authSecretId: true },
        take: 1000,
      });
      const userProfileIds = rows.filter((row: any) => this.toolAuthScope(row) === 'PER_USER').map((row: any) => row.connectionProfile);
      const userCredentials = userProfileIds.length
        ? await (this.prisma as any).customToolConnectionCredential.findMany({
            where: { tenantId: principal.tenantId, userId: principal.userId, profileId: { in: userProfileIds }, name: 'per-user', authStatus: 'ACTIVE' },
            select: { profileId: true },
          })
        : [];
      const connectedProfiles = new Set(userCredentials.map((credential: any) => credential.profileId));
      return rows.some((row: any) => Boolean(
        (row.endpointUrl || profiles[row.connectionProfile]) &&
        (!row.connectionCredentialId || row.allowedUserIds?.includes(principal.userId)) &&
        (this.toolAuthScope(row) !== 'PER_USER' || connectedProfiles.has(row.connectionProfile)),
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
    const authScope = this.toolAuthScope(row);
    if (row.connectionCredentialId && !row.allowedUserIds?.includes(principal.userId))
      throw new CustomToolError('TOOL_ACCESS_DENIED');
    if (context.snapshotVersion !== undefined && row.configurationVersion !== context.snapshotVersion)
      throw new CustomToolError('TOOL_CONFIGURATION_CHANGED');
    const target = row.endpointUrl
      ? customToolEndpoint(row.endpointUrl)
      : { profile: await this.resolveConnectionProfile(row.connectionProfile, principal.tenantId), path: row.path };
    if (!target.profile) throw new CustomToolError('CONNECTION_PROFILE_UNAVAILABLE');
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
    let credentialSession: any = null;
    let safeArguments: unknown;
    try {
      const headers: Record<string, string> = {};
      if (authScope === 'PER_USER') {
        if (row.connectionCredentialId || row.authSecretId || row.authHeaderName)
          throw new CustomToolError('AUTH_SCOPE_CONFIGURATION_MISMATCH');
        const profileRecord = await db.customToolConnectionProfile.findUnique({
          where: { tenantId_id: { tenantId: principal.tenantId, id: row.connectionProfile } },
          select: { enabled: true, authStrategy: true },
        });
        if (!profileRecord?.enabled || !['OAUTH2_REFRESH', 'ATOMIC_COOKIE_REFRESH'].includes(profileRecord.authStrategy))
          throw new CustomToolError('PER_USER_AUTH_UNAVAILABLE');
        credentialSession = await db.customToolConnectionCredential.findUnique({
          where: {
            profileId_name_tenantId_userId: {
              profileId: row.connectionProfile,
              name: 'per-user',
              tenantId: principal.tenantId,
              userId: principal.userId,
            },
          },
        });
        if (!credentialSession || credentialSession.authStrategy !== profileRecord.authStrategy || credentialSession.authStatus !== 'ACTIVE')
          throw new CustomToolError('PER_USER_CREDENTIAL_REQUIRED');
        credential = await this.refreshConnectionCredential(credentialSession, false, principal.tenantId);
        headers.authorization = `Bearer ${credential}`;
      } else if (authScope === 'SHARED' && row.connectionCredentialId) {
        const session = row.connectionCredential;
        if (!session || session.authStrategy !== 'ATOMIC_COOKIE_REFRESH' || session.authStatus !== 'ACTIVE')
          throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
        credentialSession = session;
        credential = await this.refreshConnectionCredential(session, false, principal.tenantId);
        headers.authorization = `Bearer ${credential}`;
      } else if (authScope === 'SHARED' && row.authHeaderName) {
        if (!row.authSecret) throw new CustomToolError('AUTH_SECRET_UNAVAILABLE');
        credential = decryptCredential(row.authSecret);
        headers[row.authHeaderName] = (row.authPrefix ?? '') + credential;
      } else if (authScope === 'NONE' && (row.authSecretId || row.connectionCredentialId || row.authHeaderName)) {
        throw new CustomToolError('AUTH_SCOPE_CONFIGURATION_MISMATCH');
      }
      const request = () => executeHttpTool({
          profile,
          path,
          queryMappings: row.queryMappings as Record<string, string>,
          inputSchema: row.inputSchema,
          outputSchema: row.outputSchema,
          args: call.args,
          headers,
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
        if (!credentialSession || !(error instanceof CustomToolError) || error.statusCode !== 401)
          throw error;
        credential = await this.refreshConnectionCredential(credentialSession, true, principal.tenantId);
        headers.authorization = `Bearer ${credential}`;
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

  async listConnectionProfiles(tenantId: string) {
    try {
      const stored = await this.db().customToolConnectionProfile.findMany({ where: { tenantId } });
      return stored.map((row: any) => this.publicConnectionProfile(row));
    } catch (error) {
      throw new BadRequestException(
        error instanceof CustomToolError ? error.category : 'CONNECTION_PROFILES_UNAVAILABLE',
      );
    }
  }

  async listAvailableUserConnections(tenantId: string) {
    const profiles = await this.db().customToolConnectionProfile.findMany({
      where: { tenantId, enabled: true },
      orderBy: { displayName: 'asc' },
    });
    return profiles.flatMap((profile: any) => {
      const authenticationCapabilities = {
        atomicPerUserLogin: this.atomicPerUserLoginAvailable(profile),
        oauth2Refresh: this.oauthPerUserConnectionAvailable(profile),
      };
      return Object.values(authenticationCapabilities).some(Boolean)
        ? [{ id: profile.id, displayName: profile.displayName, authenticationCapabilities }]
        : [];
    });
  }

  async getConnectionProfile(id: string, tenantId: string) {
    const row = await this.db().customToolConnectionProfile.findUnique({ where: { tenantId_id: { tenantId, id } } });
    if (!row) throw new NotFoundException('CONNECTION_PROFILE_NOT_FOUND');
    return this.publicConnectionProfile(row);
  }

  async createConnectionProfile(input: { id: string; displayName: string; baseUrl: string; allowLocalHttp?: boolean; authStrategy?: string; tokenUrl?: string; clientId?: string }, tenantId: string) {
    const data = this.connectionProfileInput(input);
    try {
      await validateCustomToolEndpoint(data.baseUrl, undefined, { allowLocalHttp: data.allowLocalHttp });
      if (data.tokenUrl) await validateCustomToolEndpoint(data.tokenUrl, undefined, { allowLocalHttp: data.allowLocalHttp });
    } catch (error) {
      throw new BadRequestException(error instanceof CustomToolError ? error.category : 'INVALID_ENDPOINT');
    }
    try {
      const row = await this.db().customToolConnectionProfile.create({ data: { ...data, tenantId } });
      return this.publicConnectionProfile(row);
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw new ConflictException('CONNECTION_PROFILE_EXISTS');
      throw error;
    }
  }

  async updateConnectionProfile(id: string, input: { displayName?: string; baseUrl?: string; allowLocalHttp?: boolean; authStrategy?: string; tokenUrl?: string; clientId?: string; enabled?: boolean }, tenantId: string) {
    const current = await this.db().customToolConnectionProfile.findUnique({ where: { tenantId_id: { tenantId, id } } });
    if (!current) throw new NotFoundException('CONNECTION_PROFILE_NOT_FOUND');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new BadRequestException('INVALID_ENABLED_VALUE');
    const data = this.connectionProfileInput({
      id,
      displayName: input.displayName ?? current.displayName,
      baseUrl: input.baseUrl ?? current.baseUrl,
      allowLocalHttp: input.allowLocalHttp ?? current.allowLocalHttp,
      authStrategy: input.authStrategy ?? current.authStrategy,
      tokenUrl: input.tokenUrl ?? current.tokenUrl ?? undefined,
      clientId: input.clientId ?? current.clientId ?? undefined,
    });
    if (input.enabled !== false || input.baseUrl !== undefined) {
      try { await validateCustomToolEndpoint(data.baseUrl, undefined, { allowLocalHttp: data.allowLocalHttp }); }
      catch (error) { throw new BadRequestException(error instanceof CustomToolError ? error.category : 'INVALID_ENDPOINT'); }
    }
    if (data.tokenUrl && (input.tokenUrl !== undefined || input.authStrategy === 'OAUTH2_REFRESH')) {
      try { await validateCustomToolEndpoint(data.tokenUrl, undefined, { allowLocalHttp: data.allowLocalHttp }); }
      catch (error) { throw new BadRequestException(error instanceof CustomToolError ? error.category : 'INVALID_TOKEN_ENDPOINT'); }
    }
    const row = await this.db().customToolConnectionProfile.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        displayName: data.displayName,
        baseUrl: data.baseUrl,
        allowLocalHttp: data.allowLocalHttp,
        authStrategy: data.authStrategy,
        tokenUrl: data.tokenUrl,
        clientId: data.clientId,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
    return this.publicConnectionProfile(row);
  }

  async deleteConnectionProfile(id: string, tenantId: string) {
    const model = this.db().customToolConnectionProfile;
    const row = await model.findUnique({ where: { tenantId_id: { tenantId, id } } });
    if (!row) throw new NotFoundException('CONNECTION_PROFILE_NOT_FOUND');
    const inUse = await this.db().customTool.count({ where: { connectionProfile: id, endpointUrl: null, archivedAt: null } });
    const credentials = await this.db().customToolConnectionCredential.count({ where: { profileId: id } });
    if (inUse || credentials) throw new ConflictException('CONNECTION_PROFILE_IN_USE');
    await model.delete({ where: { tenantId_id: { tenantId, id } } });
    return { id, deleted: true };
  }

  private connectionProfileInput(input: { id: string; displayName: string; baseUrl: string; allowLocalHttp?: boolean; authStrategy?: string; tokenUrl?: string; clientId?: string }) {
    if (!input || typeof input !== 'object') throw new BadRequestException('INVALID_CONNECTION_PROFILE');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.id)) throw new BadRequestException('INVALID_CONNECTION_PROFILE_ID');
    if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 120)
      throw new BadRequestException('INVALID_CONNECTION_PROFILE_NAME');
    if (input.allowLocalHttp !== undefined && typeof input.allowLocalHttp !== 'boolean')
      throw new BadRequestException('INVALID_LOCAL_HTTP_POLICY');
    const allowLocalHttp = input.allowLocalHttp ?? false;
    const authStrategy = input.authStrategy ?? 'NONE';
    if (!['NONE', 'SHARED', 'ATOMIC_COOKIE_REFRESH', 'OAUTH2_REFRESH'].includes(authStrategy))
      throw new BadRequestException('INVALID_CONNECTION_PROFILE_AUTH');
    let endpoint: string;
    try { endpoint = customToolEndpoint(input.baseUrl, { allowLocalHttp }).endpoint; }
    catch (error) { throw new BadRequestException(error instanceof CustomToolError ? error.category : 'INVALID_ENDPOINT'); }
    let tokenUrl: string | null = null;
    let clientId: string | null = null;
    if (authStrategy === 'OAUTH2_REFRESH') {
      if (typeof input.tokenUrl !== 'string' || !input.tokenUrl || typeof input.clientId !== 'string' || !input.clientId.trim() || input.clientId.length > 512)
        throw new BadRequestException('INVALID_OAUTH_CONFIGURATION');
      try { tokenUrl = customToolEndpoint(input.tokenUrl, { allowLocalHttp }).endpoint; }
      catch (error) { throw new BadRequestException(error instanceof CustomToolError ? error.category : 'INVALID_TOKEN_ENDPOINT'); }
      clientId = input.clientId.trim();
    }
    return { id: input.id, displayName: input.displayName.trim(), baseUrl: endpoint, allowLocalHttp, authStrategy, tokenUrl, clientId };
  }

  private publicConnectionProfile(row: any) {
    return {
      id: row.id,
      displayName: row.displayName,
      baseUrl: row.baseUrl,
      allowLocalHttp: row.allowLocalHttp === true,
      tokenUrl: row.tokenUrl,
      clientId: row.clientId,
      host: new URL(row.baseUrl).hostname,
      trustedInternal: false,
      authStrategy: row.authStrategy,
      enabled: row.enabled,
      authenticationCapabilities: {
        atomicPerUserLogin: this.atomicPerUserLoginAvailable(row),
        oauth2Refresh: this.oauthPerUserConnectionAvailable(row),
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listCustomTools(tenantId: string) {
    const rows = await this.db().customTool.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((row: any) => this.publicTool(row, tenantId)));
  }

  async getCustomTool(id: string, tenantId: string) {
    const row = await this.findTool(id);
    return this.publicTool(row, tenantId);
  }

  async createCustomTool(input: ToolDefinition, userId: string, tenantId: string) {
    const definition = await this.validateDefinition(input, tenantId);
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
            authScope: definition.authScope,
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
      return this.publicTool(row, tenantId);
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw new ConflictException('TOOL_NAME_EXISTS');
      throw error;
    }
  }

  async updateCustomTool(id: string, input: ToolDefinition, userId: string, tenantId: string) {
    const current = await this.findTool(id);
    const definition = await this.validateDefinition({ ...input, authScope: input.authScope ?? this.toolAuthScope(current) }, tenantId);
    const connectionCredentialId = definition.authScope !== 'SHARED'
      ? null
      : definition.connectionCredentialId !== undefined
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
      definition.authScope !== 'SHARED'
        ? undefined
        : definition.auth === undefined && !connectionCredentialId
        ? current.authSecretId
        : definition.auth === undefined && connectionCredentialId
          ? undefined
        : definition.auth === null
          ? undefined
          : definition.auth?.secret
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
            authHeaderName: definition.authScope !== 'SHARED'
              ? null
              : connectionCredentialId
              ? null
              : definition.auth === undefined ? current.authHeaderName : (definition.auth?.headerName ?? null),
            authPrefix: definition.authScope !== 'SHARED'
              ? null
              : connectionCredentialId
              ? null
              : definition.auth === undefined ? current.authPrefix : (definition.auth?.prefix ?? null),
            authScope: definition.authScope,
            authSecretId: definition.authScope !== 'SHARED' || connectionCredentialId || definition.auth === null
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
    return this.publicTool(row, tenantId);
  }

  async setCustomToolEnabled(id: string, enabled: boolean, userId: string, tenantId: string) {
    const current = await this.findTool(id);
    if (typeof enabled !== 'boolean') throw new BadRequestException('INVALID_ENABLED_VALUE');
    if (enabled) {
      try {
        if (current.endpointUrl) await validateCustomToolEndpoint(current.endpointUrl);
        else {
          const profile = await this.resolveConnectionProfile(current.connectionProfile, tenantId);
          if (!profile) throw new BadRequestException('CONNECTION_PROFILE_UNAVAILABLE');
          if (!profile.trustedInternal)
            await validateCustomToolEndpoint(profile.baseUrl.href, undefined, { allowLocalHttp: profile.loopbackOnly });
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException(
          error instanceof CustomToolError ? error.category : 'CONNECTION_PROFILE_INVALID',
        );
      }
    }
    const row = await this.db().customTool.update({
      where: { id },
      data: { enabled, configurationVersion: { increment: 1 }, updatedBy: userId },
    });
    await this.audit('CUSTOM_TOOL_TOGGLED', userId, id, row.configurationVersion);
    return this.publicTool(row, tenantId);
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

  async testCustomTool(id: string, sampleInput: unknown, userId: string, tenantId: string) {
    const row = await this.findTool(id);
    const started = performance.now();
    try {
      const output = await this.execute(
        { id: TOOL_ID(row.id), args: sampleInput as Record<string, unknown> },
        { userId, tenantId, authMethod: 'jwt' },
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

  private async validateDefinition(input: ToolDefinition, tenantId: string): Promise<ToolDefinition> {
    const fail = (code: string): never => {
      throw new BadRequestException(code);
    };
    if (!input || typeof input !== 'object') return fail('INVALID_TOOL_DEFINITION');
    const authScope = input.authScope ?? (input.auth || input.connectionCredentialId ? 'SHARED' : 'NONE');
    if (!['NONE', 'SHARED', 'PER_USER'].includes(authScope)) return fail('INVALID_AUTH_SCOPE');
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
      const profile = await this.resolveConnectionProfile(connectionProfile, tenantId);
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
    if ((authScope === 'NONE' && (input.auth || input.connectionCredentialId)) ||
      (authScope === 'PER_USER' && (input.auth || input.connectionCredentialId || endpoint)))
      return fail('AUTH_SCOPE_CONFIGURATION_MISMATCH');
    if (authScope === 'PER_USER') {
      const profile = await this.db().customToolConnectionProfile.findUnique({
        where: { tenantId_id: { tenantId, id: connectionProfile! } },
      });
      if (!this.atomicPerUserLoginAvailable(profile) && !this.oauthPerUserConnectionAvailable(profile))
        return fail('PER_USER_AUTH_UNAVAILABLE');
    }
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
      authScope,
      connectionCredentialId: input.connectionCredentialId,
      allowedUserIds: input.allowedUserIds,
    };
  }

  private db() {
    if (!this.prisma) throw new Error('CUSTOM_TOOL_DATABASE_UNAVAILABLE');
    return this.prisma as any;
  }
  private toolAuthScope(row: any): 'NONE' | 'SHARED' | 'PER_USER' {
    if (['NONE', 'SHARED', 'PER_USER'].includes(row.authScope)) return row.authScope;
    return row.authSecretId || row.connectionCredentialId ? 'SHARED' : 'NONE';
  }
  private async validateSharedCredential(definition: ToolDefinition) {
    if (!definition.connectionCredentialId) return;
    const credential = await this.db().customToolConnectionCredential.findUnique({
      where: { id: definition.connectionCredentialId },
      select: { id: true, profileId: true, tenantId: true, userId: true, authStatus: true },
    });
    if (!credential || credential.authStatus !== 'ACTIVE' || credential.tenantId !== '*' || credential.userId !== '*')
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
  private async publicTool(row: any, tenantId?: string) {
    let endpoint = row.endpointUrl ?? null;
    if (!endpoint) {
      try {
        const profile = tenantId ? await this.resolveConnectionProfile(row.connectionProfile, tenantId) : undefined;
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
      authScope: this.toolAuthScope(row),
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
