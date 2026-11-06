export type TenantRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MEMBER' | 'READ_ONLY';
export interface AuthPrincipal { userId: string; tenantId: string; role: TenantRole; authMethod: 'jwt' | 'dev-api-key'; }
export const AUTH_PRINCIPAL = 'sitepilot.auth-principal';
