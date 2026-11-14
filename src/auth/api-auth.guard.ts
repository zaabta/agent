import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { AUTH_PRINCIPAL, type AuthPrincipal } from './auth.types.js';
import { INSTALLATION_OWNER_ONLY } from './installation-owner.decorator.js';
import { config } from '../config.js';

@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new UnauthorizedException();
    const principal: AuthPrincipal = await this.auth.validateAccessToken(authorization.slice(7));
    const ownerOnly = this.reflector.getAllAndOverride<boolean>(INSTALLATION_OWNER_ONLY, [context.getHandler(), context.getClass()]);
    if (ownerOnly && !config.installationOwnerUserId) throw new ServiceUnavailableException('INSTALLATION_OWNER_NOT_CONFIGURED');
    if (ownerOnly && principal.userId !== config.installationOwnerUserId) throw new ForbiddenException('INSTALLATION_OWNER_REQUIRED');
    request[AUTH_PRINCIPAL] = principal;
    return true;
  }
}
