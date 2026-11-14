export interface AuthPrincipal { userId: string; tenantId: string; authMethod: 'jwt'; }
export const AUTH_PRINCIPAL = 'sitepilot.auth-principal';
