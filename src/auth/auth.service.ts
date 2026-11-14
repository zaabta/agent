import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable, UnauthorizedException, HttpException, HttpStatus, ConflictException, BadRequestException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';
import type { AuthPrincipal } from './auth.types.js';

const scrypt = promisify(scryptCb);
const REFRESH_COOKIE = 'sitepilot_refresh';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
type Claims = { sub: string; tid?: string; sid: string; iat: number; exp: number; iss: string };

@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async onModuleDestroy() {
    if (this.redis.status === 'ready') await this.redis.quit().catch(() => this.redis.disconnect());
    else this.redis.disconnect();
  }

  async register(input: { username?: string; email?: string; password: string; displayName?: string }, ip?: string) {
    const email = input.email ? this.normalizeEmail(input.email) : null;
    const username = input.username ? this.normalizeUsername(input.username) : email ? `legacy-${createHash('sha256').update(email).digest('hex').slice(0, 16)}` : '';
    if (!username) throw new BadRequestException('USERNAME_REQUIRED');
    await this.enforceLoginLimit('register', ip || 'unknown', username);
    this.validatePassword(input.password);
    const existing = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (existing) throw new ConflictException('ACCOUNT_EXISTS');
    if (email && await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new ConflictException('ACCOUNT_EXISTS');
    const passwordHash = await this.hashPassword(input.password);
    let user;
    try { user = await this.prisma.$transaction(async tx => {
      const created = await tx.user.create({ data: { username, email, passwordHash, displayName: input.displayName?.trim().slice(0, 120) || null } });
      await tx.auditLog.create({ data: { tenantId: this.companyWorkspaceId(), userId: created.id, action: 'auth.registered' } });
      return created;
    }); } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('ACCOUNT_EXISTS');
      throw error;
    }
    return { status: 'registered', user: { id: user.id, username: user.username, displayName: user.displayName } };
  }

  async login(input: { username?: string; email?: string; password: string }, ip: string | undefined) {
    const identifier = typeof input.username === 'string' ? input.username : typeof input.email === 'string' ? input.email : '';
    await this.enforceLoginLimit('login', ip || 'unknown', identifier.toLowerCase().trim().slice(0, 254));
    if (typeof input.password !== 'string') throw new UnauthorizedException('INVALID_CREDENTIALS');
    const byEmail = identifier.includes('@');
    let username: string | undefined;
    try { username = byEmail ? undefined : this.normalizeUsername(identifier); }
    catch { throw new UnauthorizedException('INVALID_CREDENTIALS'); }
    const email = byEmail ? this.normalizeEmail(identifier) : undefined;
    const user = username
      ? await this.prisma.user.findUnique({ where: { username } })
      : await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.disabledAt || !await this.verifyPassword(input.password, user.passwordHash)) {
      await this.audit(null, user?.id ?? null, 'auth.login_failed', ip);
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
    const workspaceId = this.companyWorkspaceId();
    await this.audit(workspaceId, user.id, 'auth.login', ip);
    await this.redis.del(`sitepilot:auth:login:email:${createHash('sha256').update(username ?? email!).digest('hex')}`).catch(() => undefined);
    return this.issueTokens(user.id, workspaceId);
  }

  async refresh(token: string | undefined, ip?: string) {
    if (!token) throw new UnauthorizedException('REFRESH_TOKEN_REQUIRED');
    const tokenHash = this.hashToken(token);
    const session = await this.prisma.refreshSession.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.disabledAt) {
      if (session) {
        await this.prisma.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit(session.tenantId, session.userId, 'auth.refresh_reuse_or_expired', ip);
      }
      throw new UnauthorizedException('REFRESH_TOKEN_INVALID');
    }
    const workspaceId = this.companyWorkspaceId();
    if (session.tenantId !== workspaceId) throw new UnauthorizedException('REFRESH_TOKEN_INVALID');
    await this.prisma.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(session.userId, workspaceId, session.familyId);
  }

  async logout(token: string | undefined, ip?: string) {
    if (!token) return;
    const session = await this.prisma.refreshSession.findUnique({ where: { tokenHash: this.hashToken(token) } });
    if (!session) return;
    await this.prisma.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit(session.tenantId, session.userId, 'auth.logout', ip);
  }

  async validateAccessToken(token: string): Promise<AuthPrincipal> {
    let claims: Claims;
    try { claims = this.verifyJwt(token); } catch { throw new UnauthorizedException('ACCESS_TOKEN_INVALID'); }
    const workspaceId = this.companyWorkspaceId();
    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: claims.sub }, select: { disabledAt: true } }),
      this.prisma.refreshSession.findUnique({ where: { id: claims.sid }, select: { userId: true, tenantId: true, revokedAt: true, expiresAt: true } }),
    ]);
    if (!user || user.disabledAt || !session || (claims.tid && claims.tid !== workspaceId) || session.revokedAt || session.expiresAt <= new Date() || session.userId !== claims.sub || session.tenantId !== workspaceId) throw new UnauthorizedException('ACCESS_TOKEN_REVOKED');
    return { userId: claims.sub, tenantId: workspaceId, authMethod: 'jwt' };
  }

  async currentUser(userId: string, tenantId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, memberships: { where: { tenantId }, select: { role: true } } },
    });
    if (!user) throw new UnauthorizedException('ACCOUNT_NOT_FOUND');
    return { id: user.id, username: user.username, displayName: user.displayName, role: user.memberships[0]?.role ?? null };
  }

  refreshCookie(token: string, production = process.env.NODE_ENV === 'production') {
    return `${REFRESH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=${REFRESH_TTL_DAYS * 86400}${production ? '; Secure' : ''}`;
  }
  clearRefreshCookie(production = process.env.NODE_ENV === 'production') {
    return `${REFRESH_COOKIE}=; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=0${production ? '; Secure' : ''}`;
  }
  refreshCookieName() { return REFRESH_COOKIE; }

  private companyWorkspaceId() {
    const workspaceId = config.companyWorkspaceId;
    if (!workspaceId || workspaceId.length > 200) throw new ServiceUnavailableException('COMPANY_WORKSPACE_NOT_CONFIGURED');
    return workspaceId;
  }

  private async issueTokens(userId: string, tenantId: string, familyId: string = randomUUID()) {
    const now = Math.floor(Date.now() / 1000);
    const sessionId = randomUUID();
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshSession.create({ data: { id: sessionId, tokenHash: this.hashToken(refreshToken), familyId, tenantId, userId, expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400000) } });
    const accessToken = this.signJwt({ sub: userId, sid: sessionId, iat: now, exp: now + ACCESS_TTL_SECONDS, iss: 'sitepilot-ai' });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, displayName: true } });
    return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL_SECONDS, refreshToken, user };
  }

  private normalizeUsername(value: string) {
    const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (username.length < 3 || username.length > 64 || !/^[a-z0-9._-]+$/.test(username)) throw new BadRequestException('INVALID_USERNAME');
    return username;
  }
  private normalizeEmail(value: string) {
    if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new UnauthorizedException('INVALID_CREDENTIALS');
    return value.trim().toLowerCase();
  }
  private validatePassword(password: string) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new ConflictException('PASSWORD_POLICY: use 12 to 256 characters');
  }
  private async hashPassword(password: string) {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, 64) as Buffer;
    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }
  private async verifyPassword(password: string, stored: string) {
    const [scheme, saltText, hashText] = stored.split('$');
    if (scheme !== 'scrypt' || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  private hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
  private jwtSecret() {
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error('AUTH_JWT_SECRET must be set to at least 32 bytes');
    return secret;
  }
  private signJwt(claims: Claims) {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${head}.${body}`;
    return `${input}.${createHmac('sha256', this.jwtSecret()).update(input).digest('base64url')}`;
  }
  private verifyJwt(token: string): Claims {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => part.length > 8192)) throw new Error('invalid token');
    const input = `${parts[0]}.${parts[1]}`;
    const expected = createHmac('sha256', this.jwtSecret()).update(input).digest();
    const actual = Buffer.from(parts[2]!, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid signature');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { alg?: string };
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Claims;
    if (header.alg !== 'HS256' || payload.iss !== 'sitepilot-ai' || !payload.sub || !payload.sid || payload.exp <= Date.now() / 1000) throw new Error('invalid claims');
    return payload;
  }
  private async enforceLoginLimit(operation: 'register' | 'login', ip: string, identifier: string) {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const emailKey = `sitepilot:auth:${operation}:identity:${createHash('sha256').update(identifier).digest('hex')}`;
      const ipKey = `sitepilot:auth:${operation}:ip:${createHash('sha256').update(ip).digest('hex')}`;
      const [emailCount, ipCount] = await Promise.all([this.redis.incr(emailKey), this.redis.incr(ipKey)]);
      if (emailCount === 1) await this.redis.expire(emailKey, 900);
      if (ipCount === 1) await this.redis.expire(ipKey, 900);
      if (emailCount > 10 || ipCount > 50) throw new HttpException(`${operation.toUpperCase()}_RATE_LIMITED`, HttpStatus.TOO_MANY_REQUESTS);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error;
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('AUTH_RATE_LIMITER_UNAVAILABLE', { cause: error });
    }
  }
  private async audit(tenantId: string | null, userId: string | null, action: string, ip?: string, details?: object) {
    await this.prisma.auditLog.create({ data: { tenantId, userId, action, ipAddress: ip?.slice(0, 64), details: details ?? {} } });
  }
}
