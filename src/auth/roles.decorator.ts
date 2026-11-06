import { SetMetadata } from '@nestjs/common';
import type { TenantRole } from './auth.types.js';
export const REQUIRED_ROLES = 'sitepilot.required-roles';
export const Roles = (...roles: TenantRole[]) => SetMetadata(REQUIRED_ROLES, roles);
