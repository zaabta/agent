import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AUTH_PRINCIPAL, type AuthPrincipal } from './auth.types.js';
export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): AuthPrincipal => {
  return context.switchToHttp().getRequest()[AUTH_PRINCIPAL];
});
