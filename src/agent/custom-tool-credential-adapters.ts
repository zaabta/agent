import {
  CustomToolError,
  executeInternalFormRequest,
  executeInternalJsonRequest,
  type ConnectionProfile,
} from './custom-http-tool.js';

export type TokenRotation = { accessToken: string; refreshToken?: string; expiresIn: number };
export interface CustomToolCredentialAdapter {
  refresh(
    profile: ConnectionProfile,
    refreshToken: string,
    config?: { tokenPath?: string; clientId?: string },
  ): Promise<TokenRotation>;
}

export function parseAtomicSession(response: {
  body: unknown;
  statusCode: number;
  responseHeaders: Record<string, string | string[] | undefined>;
}): TokenRotation {
  const body = response.body as Record<string, unknown> | null;
  const accessToken = body && typeof body.accessToken === 'string' ? body.accessToken : '';
  const expiresIn = body && Number.isInteger(body.expiresIn) ? Number(body.expiresIn) : 0;
  const cookies = response.responseHeaders['set-cookie'];
  const refreshToken = (Array.isArray(cookies) ? cookies : cookies ? [cookies] : [])
    .map((line) => line.split(';', 1)[0] ?? '')
    .find((line) => line.startsWith('refreshToken='))
    ?.slice('refreshToken='.length);
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !accessToken ||
    accessToken.length > 8192 ||
    !refreshToken ||
    refreshToken.length > 4096 ||
    expiresIn < 1 ||
    expiresIn > 86_400
  )
    throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED', response.statusCode);
  return { accessToken, refreshToken, expiresIn };
}

function oauthTokens(response: { body: unknown; statusCode: number }): TokenRotation {
  const body = response.body as Record<string, unknown> | null;
  const accessToken = body && typeof body.access_token === 'string' ? body.access_token : '';
  const refreshToken = body && typeof body.refresh_token === 'string' ? body.refresh_token : undefined;
  const expiresIn = body && Number.isInteger(body.expires_in) ? Number(body.expires_in) : 0;
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !accessToken ||
    accessToken.length > 8192 ||
    (refreshToken && refreshToken.length > 8192) ||
    expiresIn < 1 ||
    expiresIn > 86_400
  )
    throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED', response.statusCode);
  return { accessToken, refreshToken, expiresIn };
}

export class AtomicCookieCredentialAdapter implements CustomToolCredentialAdapter {
  async login(profile: ConnectionProfile, email: string, password: string): Promise<TokenRotation> {
    const response = await executeInternalJsonRequest({
      profile,
      path: '/api/v1/auth/login',
      body: { email, password },
    });
    return parseAtomicSession(response);
  }

  async refresh(profile: ConnectionProfile, refreshToken: string): Promise<TokenRotation> {
    const response = await executeInternalJsonRequest({
      profile,
      path: '/api/v1/auth/refresh',
      body: {},
      headers: { cookie: `refreshToken=${refreshToken}` },
    });
    return parseAtomicSession(response);
  }
}

export class OAuth2RefreshCredentialAdapter implements CustomToolCredentialAdapter {
  async refresh(
    profile: ConnectionProfile,
    refreshToken: string,
    config?: { tokenPath?: string; clientId?: string },
  ) {
    if (!config?.tokenPath || !config.clientId) throw new CustomToolError('CONNECTION_AUTHENTICATION_FAILED');
    const response = await executeInternalFormRequest({
      profile,
      path: config.tokenPath,
      fields: { grant_type: 'refresh_token', client_id: config.clientId, refresh_token: refreshToken },
    });
    const tokens = oauthTokens(response);
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  }
}
