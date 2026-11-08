/** Test harness only: preserve the application's existing rotating refresh flow. */
export function auditSession(base: string, bearer: string, refreshCookie?: string, transport: typeof fetch = fetch) {
  let token = bearer;
  let cookie = refreshCookie;
  let refreshing: Promise<void> | undefined;
  async function refresh() {
    const response = await transport(`${base}/api/auth/refresh`, {
      method: 'POST', headers: { cookie: cookie! }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Audit session refresh HTTP ${response.status}`);
    const body = await response.json() as { accessToken?: string };
    if (!body.accessToken) throw new Error('Audit session refresh returned no access token');
    token = body.accessToken;
    const rotated = response.headers.get('set-cookie')?.split(';')[0];
    if (rotated) cookie = rotated;
  }
  return async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const sentToken = token;
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    let response = await transport(`${base}${path}`, { ...init, headers });
    if (response.status !== 401 || !cookie) return response;
    await response.body?.cancel();
    // Concurrent expired requests share one rotation; a late 401 reuses it.
    if (sentToken === token) {
      if (!refreshing) refreshing = refresh().finally(() => { refreshing = undefined; });
      await refreshing;
    }
    headers.set('authorization', `Bearer ${token}`);
    response = await transport(`${base}${path}`, { ...init, headers });
    return response;
  };
}
