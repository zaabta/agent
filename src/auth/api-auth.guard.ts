import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { AuthService } from './auth.service.js';
import { AUTH_PRINCIPAL, type AuthPrincipal, type TenantRole } from './auth.types.js';
import { REQUIRED_ROLES } from './roles.decorator.js';
import { requireEnv, config } from '../config.js';

@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    let principal: AuthPrincipal;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      principal = await this.auth.validateAccessToken(authorization.slice(7));
    } else if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEV_API_KEY_AUTH === 'true') {
      const supplied = request.headers['x-api-key'];
      if (typeof supplied !== 'string') throw new UnauthorizedException();
      const expected = requireEnv('DEV_API_KEY');
      const a = Buffer.from(supplied); const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
      principal = { userId: config.conversationOwnerId, tenantId: config.tenantId, role: 'TENANT_ADMIN', authMethod: 'dev-api-key' };
    } else throw new UnauthorizedException();
    const roles = this.reflector.getAllAndOverride<TenantRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (roles?.length && !roles.includes(principal.role)) throw new ForbiddenException('INSUFFICIENT_ROLE');
    request[AUTH_PRINCIPAL] = principal;
    return true;
  }
}
