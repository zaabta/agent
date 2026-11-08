import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { domainToUnicode } from 'node:url';
import { Inject, Injectable, UnauthorizedException, HttpException, HttpStatus, ConflictException, ForbiddenException, OnModuleDestroy, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';
import type { AuthPrincipal, TenantRole } from './auth.types.js';

const scrypt = promisify(scryptCb);
const REFRESH_COOKIE = 'sitepilot_refresh';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
type Claims = { sub: string; tid: string; sid: string; role: TenantRole; iat: number; exp: number; iss: string };

function displayEmail(email: string) {
  const at = email.lastIndexOf('@');
  if (at < 0) return email;
  const domain = email.slice(at + 1);
  return `${email.slice(0, at)}@${domainToUnicode(domain) || domain}`;
}

@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async onModuleDestroy() {
    if (this.redis.status === 'ready') await this.redis.quit().catch(() => this.redis.disconnect());
    else this.redis.disconnect();
  }

  async register(input: { email: string; password: string; displayName?: string }) {
    const email = this.normalizeEmail(input.email);
    await this.enforceLoginLimit('register', 'unknown', email);
    this.validatePassword(input.password);
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictException('ACCOUNT_EXISTS');
    const passwordHash = await this.hashPassword(input.password);
    let user;
    try { user = await this.prisma.$transaction(async tx => {
      const created = await tx.user.create({ data: { email, passwordHash, displayName: input.displayName?.trim().slice(0, 120) || null } });
      // Registration creates an identity only. A company workspace admin must
      // explicitly grant shared document access through addMember.
      await tx.auditLog.create({ data: { tenantId: null, userId: created.id, action: 'auth.registration_pending' } });
      return created;
    }); } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('ACCOUNT_EXISTS');
      throw error;
    }
    return { status: 'pending_workspace_membership', user: { id: user.id, emailDisplay: displayEmail(user.email) } };
  }

  async login(input: { email: string; password: string }, ip: string | undefined) {
    const email = this.normalizeEmail(input.email);
    await this.enforceLoginLimit('login', ip || 'unknown', email);
    const user = await this.prisma.user.findUnique({ where: { email }, include: { memberships: { include: { tenant: true } } } });
    if (!user || user.disabledAt || !await this.verifyPassword(input.password, user.passwordHash)) {
      await this.audit(null, user?.id ?? null, 'auth.login_failed', ip);
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
    const workspaceId = this.companyWorkspaceId();
    const membership = user.memberships.find(item => item.tenantId === workspaceId);
    if (!membership) throw new ForbiddenException('COMPANY_WORKSPACE_ACCESS_REQUIRED');
    await this.audit(membership.tenantId, user.id, 'auth.login', ip);
    await this.redis.del(`sitepilot:auth:login:email:${createHash('sha256').update(email).digest('hex')}`).catch(() => undefined);
    return this.issueTokens(user.id, membership.tenantId, membership.role);
  }

  async refresh(token: string | undefined, ip?: string) {
    if (!token) throw new UnauthorizedException('REFRESH_TOKEN_REQUIRED');
    const tokenHash = this.hashToken(token);
    const session = await this.prisma.refreshSession.findUnique({ where: { tokenHash }, include: { user: true, tenant: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.disabledAt) {
      if (session) {
        await this.prisma.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit(session.tenantId, session.userId, 'auth.refresh_reuse_or_expired', ip);
      }
      throw new UnauthorizedException('REFRESH_TOKEN_INVALID');
    }
    const workspaceId = this.companyWorkspaceId();
    if (session.tenantId !== workspaceId) throw new UnauthorizedException('REFRESH_TOKEN_INVALID');
    const membership = await this.prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: workspaceId, userId: session.userId } } });
    if (!membership) throw new UnauthorizedException('REFRESH_TOKEN_INVALID');
    await this.prisma.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(session.userId, workspaceId, membership.role, session.familyId);
  }

  async logout(token: string | undefined, ip?: string) {
    if (!token) return;
    const session = await this.prisma.refreshSession.findUnique({ where: { tokenHash: this.hashToken(token) } });
    if (!session) return;
    await this.prisma.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit(session.tenantId, session.userId, 'auth.logout', ip);
  }

  async switchTenant(principal: AuthPrincipal, tenantId: string) {
    if (tenantId !== this.companyWorkspaceId()) throw new ForbiddenException('COMPANY_WORKSPACE_ONLY');
    const membership = await this.prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: principal.userId } }, include: { tenant: true } });
    if (!membership) throw new ForbiddenException('TENANT_ACCESS_DENIED');
    await this.audit(tenantId, principal.userId, 'auth.tenant_switched');
    return this.issueTokens(principal.userId, tenantId, membership.role);
  }

  async validateAccessToken(token: string): Promise<AuthPrincipal> {
    let claims: Claims;
    try { claims = this.verifyJwt(token); } catch { throw new UnauthorizedException('ACCESS_TOKEN_INVALID'); }
    const workspaceId = this.companyWorkspaceId();
    const [user, membership, session] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: claims.sub }, select: { disabledAt: true } }),
      this.prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: workspaceId, userId: claims.sub } }, select: { role: true } }),
      this.prisma.refreshSession.findUnique({ where: { id: claims.sid }, select: { userId: true, tenantId: true, revokedAt: true, expiresAt: true } }),
    ]);
    if (!user || user.disabledAt || !membership || !session || claims.tid !== workspaceId || session.revokedAt || session.expiresAt <= new Date() || session.userId !== claims.sub || session.tenantId !== workspaceId || session.tenantId !== claims.tid) throw new UnauthorizedException('ACCESS_TOKEN_REVOKED');
    return { userId: claims.sub, tenantId: workspaceId, role: membership.role, authMethod: 'jwt' };
  }

  async listMembers(tenantId: string) {
    if (tenantId !== this.companyWorkspaceId()) throw new ForbiddenException('COMPANY_WORKSPACE_ONLY');
    const members = await this.prisma.membership.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { role: true, createdAt: true, user: { select: { id: true, email: true, displayName: true, disabledAt: true } } } });
    return members.map(member => ({ ...member, user: { ...member.user, emailDisplay: displayEmail(member.user.email) } }));
  }

  async addMember(tenantId: string, emailInput: string, role: TenantRole, actorId: string) {
    if (tenantId !== this.companyWorkspaceId()) throw new ForbiddenException('COMPANY_WORKSPACE_ONLY');
    if (role === 'SUPER_ADMIN') throw new ForbiddenException('SUPER_ADMIN_ASSIGNMENT_REQUIRES_PLATFORM_ADMIN');
    const email = this.normalizeEmail(emailInput);
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, displayName: true } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    try { await this.prisma.membership.create({ data: { tenantId, userId: user.id, role } }); }
    catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('MEMBERSHIP_EXISTS');
      throw error;
    }
    await this.audit(tenantId, actorId, 'tenant.member_added', undefined, { targetUserId: user.id, role });
    return { user: { ...user, emailDisplay: displayEmail(user.email) }, tenantId, role };
  }

  async changeMemberRole(tenantId: string, userId: string, role: TenantRole, actorId: string) {
    if (tenantId !== this.companyWorkspaceId()) throw new ForbiddenException('COMPANY_WORKSPACE_ONLY');
    if (role === 'SUPER_ADMIN') throw new ForbiddenException('SUPER_ADMIN_ASSIGNMENT_REQUIRES_PLATFORM_ADMIN');
    const updated = await this.prisma.membership.updateMany({ where: { tenantId, userId }, data: { role } });
    if (!updated.count) throw new NotFoundException('TENANT_MEMBER_NOT_FOUND');
    await this.audit(tenantId, actorId, 'tenant.member_role_changed', undefined, { targetUserId: userId, role });
    return { userId, tenantId, role };
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

  private async issueTokens(userId: string, tenantId: string, role: TenantRole, familyId: string = randomUUID()) {
    const now = Math.floor(Date.now() / 1000);
    const sessionId = randomUUID();
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshSession.create({ data: { id: sessionId, tokenHash: this.hashToken(refreshToken), familyId, tenantId, userId, expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400000) } });
    const accessToken = this.signJwt({ sub: userId, tid: tenantId, sid: sessionId, role, iat: now, exp: now + ACCESS_TTL_SECONDS, iss: 'sitepilot-ai' });
    return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL_SECONDS, refreshToken, user: { id: userId }, tenant: { id: tenantId, role } };
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
    if (header.alg !== 'HS256' || payload.iss !== 'sitepilot-ai' || !payload.sub || !payload.tid || payload.exp <= Date.now() / 1000) throw new Error('invalid claims');
    return payload;
  }
  private async enforceLoginLimit(operation: 'register' | 'login', ip: string, email: string) {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const emailKey = `sitepilot:auth:${operation}:email:${createHash('sha256').update(email).digest('hex')}`;
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
