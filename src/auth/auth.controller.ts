import { Body, Controller, Get, HttpCode, Inject, Ip, Patch, Post, Req, Res, UseGuards, ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiForbiddenResponse, ApiOperation, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { ApiAuthGuard } from './api-auth.guard.js';
import { CurrentPrincipal } from './current-principal.decorator.js';
import type { AuthPrincipal, TenantRole } from './auth.types.js';
import { Roles } from './roles.decorator.js';

@ApiTags('authentication')
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register') @HttpCode(201) @ApiOperation({ summary: 'Create a user and first tenant workspace' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 12, maxLength: 256 }, displayName: { type: 'string', maxLength: 120 } } } })
  @ApiResponse({ status: 201, description: 'Returns an access JWT and sets an HttpOnly refresh cookie.' })
  @ApiResponse({ status: 409, description: 'Email already registered or password policy failed.' })
  async register(@Body() body: { email?: string; password?: string; displayName?: string }, @Res({ passthrough: true }) response: Response) {
    const tokens = await this.auth.register({ email: body.email ?? '', password: body.password ?? '', displayName: body.displayName });
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Post('login') @HttpCode(200) @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } } })
  @ApiUnauthorizedResponse({ description: 'Credentials are invalid.' })
  @ApiResponse({ status: 429, description: 'Login rate limit exceeded.' })
  async login(@Body() body: { email?: string; password?: string }, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    const tokens = await this.auth.login({ email: body.email ?? '', password: body.password ?? '' }, ip);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Post('refresh') @HttpCode(200) @ApiOperation({ summary: 'Rotate the HttpOnly refresh token and issue a new access JWT' })
  @ApiUnauthorizedResponse({ description: 'Refresh token is missing, expired, revoked, or reused.' })
  async refresh(@Req() request: Request, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    const tokens = await this.auth.refresh(this.readCookie(request, this.auth.refreshCookieName()), ip);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Post('logout') @HttpCode(204) @ApiOperation({ summary: 'Revoke refresh-token family and clear refresh cookie' })
  async logout(@Req() request: Request, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.readCookie(request, this.auth.refreshCookieName()), ip);
    response.setHeader('Set-Cookie', this.auth.clearRefreshCookie());
  }

  @Post('tenant') @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer')
  @ApiBody({ schema: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string' } } } })
  @ApiForbiddenResponse({ description: 'The authenticated user is not a member of the requested tenant.' })
  async switchTenant(@CurrentPrincipal() principal: AuthPrincipal, @Body() body: { tenantId?: string }, @Res({ passthrough: true }) response: Response) {
    if (!body.tenantId || body.tenantId.length > 200) throw new ForbiddenException('TENANT_ACCESS_DENIED');
    const tokens = await this.auth.switchTenant(principal, body.tenantId);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Get('members') @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @Roles('TENANT_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List members in the authenticated tenant (tenant admins only)' })
  listMembers(@CurrentPrincipal() principal: AuthPrincipal) { return this.auth.listMembers(principal.tenantId); }

  @Post('members') @HttpCode(201) @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @Roles('TENANT_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Add an already registered user to the authenticated tenant' })
  @ApiBody({ schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'], default: 'MEMBER' } } } })
  addMember(@CurrentPrincipal() principal: AuthPrincipal, @Body() body: { email?: string; role?: TenantRole }) {
    const role = body.role ?? 'MEMBER';
    if (!['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'].includes(role)) throw new ForbiddenException('INVALID_TENANT_ROLE');
    return this.auth.addMember(principal.tenantId, body.email ?? '', role, principal.userId);
  }

  @Patch('members/:userId/role') @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @Roles('TENANT_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Change a member role within the authenticated tenant (tenant admins only)' })
  @ApiBody({ schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'] } } } })
  changeRole(@CurrentPrincipal() principal: AuthPrincipal, @Req() request: Request, @Body() body: { role?: TenantRole }) {
    if (!['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'].includes(body.role ?? '')) throw new ForbiddenException('INVALID_TENANT_ROLE');
    const userId = Array.isArray(request.params.userId) ? request.params.userId[0]! : request.params.userId!;
    return this.auth.changeMemberRole(principal.tenantId, userId, body.role!, principal.userId);
  }

  private publicTokens(tokens: { accessToken: string; tokenType: string; expiresIn: number; user: { id: string }; tenant: { id: string; role: string } }) {
    return { accessToken: tokens.accessToken, tokenType: tokens.tokenType, expiresIn: tokens.expiresIn, user: tokens.user, tenant: tokens.tenant };
  }
  private readCookie(request: Request, name: string) {
    const raw = request.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const [key, ...value] = part.trim().split('=');
      if (key === name) return decodeURIComponent(value.join('='));
    }
    return undefined;
  }
}
