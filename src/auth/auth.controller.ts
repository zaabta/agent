import { Body, Controller, Get, HttpCode, Inject, Ip, Patch, Post, Req, Res, UseGuards, ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiForbiddenResponse, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { ApiAuthGuard } from './api-auth.guard.js';
import { CurrentPrincipal } from './current-principal.decorator.js';
import type { AuthPrincipal, TenantRole } from './auth.types.js';
import { Roles } from './roles.decorator.js';

@ApiTags('authentication')
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register') @HttpCode(201) @ApiOperation({ summary: 'Register an account pending company workspace approval' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 12, maxLength: 256 }, displayName: { type: 'string', maxLength: 120 } } } })
  @ApiResponse({ status: 201, description: 'Creates a pending identity. A company workspace admin must add it before login is allowed.', schema: { type: 'object', required: ['status', 'user'], properties: { status: { type: 'string', enum: ['pending_workspace_membership'] }, user: { type: 'object', required: ['id', 'emailDisplay'], properties: { id: { type: 'string', format: 'uuid' }, emailDisplay: { type: 'string', description: 'Privacy-safe display form of the registered email.' } } } } } })
  @ApiResponse({ status: 400, description: 'Invalid email, password, or registration payload.' })
  @ApiResponse({ status: 409, description: 'Email already registered or password policy failed.' })
  @ApiResponse({ status: 429, description: 'Registration rate limit exceeded.' })
  async register(@Body() body: { email?: string; password?: string; displayName?: string }) {
    return this.auth.register({ email: body.email ?? '', password: body.password ?? '', displayName: body.displayName });
  }

  @Post('login') @HttpCode(200) @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } } })
  @ApiResponse({ status: 200, description: 'Returns an access token and sets the rotating refresh token as an HttpOnly cookie.', headers: { 'Set-Cookie': { schema: { type: 'string' }, description: 'HttpOnly refresh token cookie scoped to /api/auth.' } }, schema: { type: 'object', required: ['accessToken', 'tokenType', 'expiresIn', 'user', 'tenant'], properties: { accessToken: { type: 'string' }, tokenType: { type: 'string', example: 'Bearer' }, expiresIn: { type: 'integer', description: 'Access token lifetime in seconds.' }, user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }, tenant: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string', enum: ['SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER', 'READ_ONLY'] } } } } } })
  @ApiUnauthorizedResponse({ description: 'Credentials are invalid.' })
  @ApiForbiddenResponse({ description: 'The account is not a member of the configured company workspace (COMPANY_WORKSPACE_ACCESS_REQUIRED).' })
  @ApiResponse({ status: 429, description: 'Login rate limit exceeded.' })
  async login(@Body() body: { email?: string; password?: string }, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    const tokens = await this.auth.login({ email: body.email ?? '', password: body.password ?? '' }, ip);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Post('refresh') @HttpCode(200) @ApiOperation({ summary: 'Rotate the HttpOnly refresh token and issue a new access JWT' })
  @ApiResponse({ status: 200, description: 'Rotates the refresh cookie and returns a new access token.', headers: { 'Set-Cookie': { schema: { type: 'string' }, description: 'Replacement HttpOnly refresh token cookie.' } }, schema: { type: 'object', required: ['accessToken', 'tokenType', 'expiresIn', 'user', 'tenant'], properties: { accessToken: { type: 'string' }, tokenType: { type: 'string', example: 'Bearer' }, expiresIn: { type: 'integer' }, user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }, tenant: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' } } } } } })
  @ApiUnauthorizedResponse({ description: 'Refresh token is missing, expired, revoked, or reused.' })
  async refresh(@Req() request: Request, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    const tokens = await this.auth.refresh(this.readCookie(request, this.auth.refreshCookieName()), ip);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Post('logout') @HttpCode(204) @ApiOperation({ summary: 'Revoke refresh-token family and clear refresh cookie' })
  @ApiResponse({ status: 204, description: 'Refresh token family is revoked when present; the refresh cookie is cleared.', headers: { 'Set-Cookie': { schema: { type: 'string' }, description: 'Clearing HttpOnly refresh cookie.' } } })
  async logout(@Req() request: Request, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.readCookie(request, this.auth.refreshCookieName()), ip);
    response.setHeader('Set-Cookie', this.auth.clearRefreshCookie());
  }

  @Post('tenant') @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @ApiOperation({ summary: 'Switch authentication scope to a workspace the user belongs to' })
  @ApiBody({ schema: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string' } } } })
  @ApiResponse({ status: 201, description: 'Issues a new access token and refresh cookie for the authorized workspace.', headers: { 'Set-Cookie': { schema: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Invalid tenant identifier.' })
  @ApiUnauthorizedResponse({ description: 'Access token is invalid or expired.' })
  @ApiForbiddenResponse({ description: 'The authenticated user is not a member of the requested tenant.' })
  async switchTenant(@CurrentPrincipal() principal: AuthPrincipal, @Body() body: { tenantId?: string }, @Res({ passthrough: true }) response: Response) {
    if (!body.tenantId || body.tenantId.length > 200) throw new ForbiddenException('TENANT_ACCESS_DENIED');
    const tokens = await this.auth.switchTenant(principal, body.tenantId);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Get('members') @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @Roles('TENANT_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List members in the authenticated tenant (tenant admins only)' })
  @ApiResponse({ status: 200, description: 'Tenant memberships and privacy-safe user details.', schema: { type: 'array', items: { type: 'object', required: ['role', 'createdAt', 'user'], properties: { role: { type: 'string', enum: ['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'] }, createdAt: { type: 'string', format: 'date-time' }, user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, emailDisplay: { type: 'string' }, displayName: { type: 'string', nullable: true }, disabledAt: { type: 'string', format: 'date-time', nullable: true } } } } } } })
  @ApiUnauthorizedResponse({ description: 'Valid access JWT required.' })
  @ApiForbiddenResponse({ description: 'TENANT_ADMIN or SUPER_ADMIN role required.' })
  listMembers(@CurrentPrincipal() principal: AuthPrincipal) { return this.auth.listMembers(principal.tenantId); }

  @Post('members') @HttpCode(201) @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @Roles('TENANT_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Add an already registered user to the authenticated tenant' })
  @ApiBody({ schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'], default: 'MEMBER' } } } })
  @ApiResponse({ status: 201, description: 'Membership created.', schema: { type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, emailDisplay: { type: 'string' }, displayName: { type: 'string', nullable: true } } }, tenantId: { type: 'string' }, role: { type: 'string', enum: ['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'] } } } })
  @ApiResponse({ status: 400, description: 'Invalid request or role.' })
  @ApiNotFoundResponse({ description: 'USER_NOT_FOUND: no registered account matches the email.' })
  @ApiResponse({ status: 409, description: 'MEMBERSHIP_EXISTS: the user already belongs to this tenant.' })
  @ApiForbiddenResponse({ description: 'Tenant admin role required, or platform-only role assignment attempted.' })
  addMember(@CurrentPrincipal() principal: AuthPrincipal, @Body() body: { email?: string; role?: TenantRole }) {
    const role = body.role ?? 'MEMBER';
    if (!['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'].includes(role)) throw new ForbiddenException('INVALID_TENANT_ROLE');
    return this.auth.addMember(principal.tenantId, body.email ?? '', role, principal.userId);
  }

  @Patch('members/:userId/role') @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @Roles('TENANT_ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Change a member role within the authenticated tenant (tenant admins only)' })
  @ApiParam({ name: 'userId', description: 'UUID of the tenant member.' })
  @ApiBody({ schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'] } } } })
  @ApiResponse({ status: 200, description: 'Updated membership role.', schema: { type: 'object', required: ['userId', 'tenantId', 'role'], properties: { userId: { type: 'string', format: 'uuid' }, tenantId: { type: 'string' }, role: { type: 'string', enum: ['TENANT_ADMIN', 'MEMBER', 'READ_ONLY'] } } } })
  @ApiNotFoundResponse({ description: 'TENANT_MEMBER_NOT_FOUND.' })
  @ApiForbiddenResponse({ description: 'Tenant admin role required, or platform-only role assignment attempted.' })
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
