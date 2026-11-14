import { Body, Controller, Get, HttpCode, Inject, Ip, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBody, ApiOperation, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { ApiAuthGuard } from './api-auth.guard.js';
import { CurrentPrincipal } from './current-principal.decorator.js';
import type { AuthPrincipal } from './auth.types.js';

@ApiTags('authentication')
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('me') @UseGuards(ApiAuthGuard) @ApiOperation({ summary: 'Return the authenticated account and its workspace role' })
  @ApiResponse({ status: 200, description: 'Current account details and role.' })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, expired, or revoked.' })
  me(@CurrentPrincipal() principal: AuthPrincipal) { return this.auth.currentUser(principal.userId, principal.tenantId); }

  @Post('register') @HttpCode(201) @ApiOperation({ summary: 'Create a single-installation user account with a unique username and password' })
  @ApiBody({ schema: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string', minLength: 3, maxLength: 64 }, password: { type: 'string', minLength: 12, maxLength: 256 }, displayName: { type: 'string', maxLength: 120 }, email: { type: 'string', format: 'email', description: 'Optional compatibility contact field.' } } } })
  @ApiResponse({ status: 201, description: 'Account created. Password and password hash are never returned.' })
  @ApiResponse({ status: 409, description: 'ACCOUNT_EXISTS, invalid username, or password policy failure.' })
  @ApiResponse({ status: 429, description: 'Registration rate limit exceeded.' })
  register(@Body() body: { username?: string; email?: string; password?: string; displayName?: string }, @Ip() ip: string) {
    return this.auth.register({ username: body.username, email: body.email, password: body.password ?? '', displayName: body.displayName }, ip);
  }

  @Post('login') @HttpCode(200) @ApiOperation({ summary: 'Authenticate with username and password' })
  @ApiBody({ schema: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string' } } } })
  @ApiResponse({ status: 200, description: 'Returns a short-lived JWT and sets a rotating HttpOnly refresh cookie.' })
  @ApiUnauthorizedResponse({ description: 'Credentials are invalid.' })
  @ApiResponse({ status: 429, description: 'Login rate limit exceeded.' })
  async login(@Body() body: { username?: string; email?: string; password?: string }, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    const tokens = await this.auth.login({ username: body.username, email: body.email, password: body.password ?? '' }, ip);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Post('refresh') @HttpCode(200) @ApiOperation({ summary: 'Rotate the HttpOnly refresh token and issue a new access JWT' })
  @ApiResponse({ status: 200, description: 'Returns a replacement access token and HttpOnly refresh cookie.' })
  @ApiUnauthorizedResponse({ description: 'Refresh token is missing, expired, revoked, or reused.' })
  async refresh(@Req() request: Request, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    const tokens = await this.auth.refresh(this.readCookie(request, this.auth.refreshCookieName()), ip);
    response.setHeader('Set-Cookie', this.auth.refreshCookie(tokens.refreshToken));
    return this.publicTokens(tokens);
  }

  @Post('logout') @HttpCode(204) @ApiOperation({ summary: 'Revoke refresh-token family and clear refresh cookie' })
  @ApiResponse({ status: 204, description: 'Refresh token family is revoked when present; cookie is cleared.' })
  async logout(@Req() request: Request, @Ip() ip: string, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.readCookie(request, this.auth.refreshCookieName()), ip);
    response.setHeader('Set-Cookie', this.auth.clearRefreshCookie());
  }

  private publicTokens(tokens: { accessToken: string; tokenType: string; expiresIn: number; user: { id: string; username: string; displayName: string | null } | null }) {
    return { accessToken: tokens.accessToken, tokenType: tokens.tokenType, expiresIn: tokens.expiresIn, user: tokens.user };
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
