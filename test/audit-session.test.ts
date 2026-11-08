import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditSession } from './helpers/audit-session.js';

test('long audit rotates the refresh cookie, retries once, and preserves request bodies', async () => {
  const seen: Array<{ path: string; authorization: string | null; cookie: string | null; body: unknown }> = [];
  let refreshes = 0;
  const transport = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({ path: url, authorization: headers.get('authorization'), cookie: headers.get('cookie'), body: init.body });
    if (url.endsWith('/refresh')) {
      refreshes++;
      assert.equal(headers.get('cookie'), `session=${refreshes === 1 ? 'initial' : 'rotated'}`);
      return Response.json({ accessToken: `new-${refreshes}` }, { headers: { 'set-cookie': 'session=rotated; HttpOnly; Path=/api/auth' } });
    }
    return Response.json({}, { status: seen.filter(call => call.path === url).length === 1 ? 401 : 200 });
  }) as typeof fetch;
  const request = auditSession('http://audit.test', 'old', 'session=initial', transport);
  for (const path of ['/ask', '/next']) assert.equal((await request(path, { method: 'POST', body: '{"message":"fixture"}' })).status, 200);
  assert.equal(refreshes, 2);
  assert.equal(seen.filter(call => call.path.endsWith('/ask')).at(-1)?.authorization, 'Bearer new-1');
  assert.ok(seen.filter(call => !call.path.endsWith('/refresh')).every(call => call.body === '{"message":"fixture"}'));
});

test('no refresh credential leaves a 401 visible; provider failures never trigger refresh', async () => {
  for (const status of [401, 429, 503]) {
    let calls = 0;
    const request = auditSession('http://audit.test', 'old', status === 401 ? undefined : 'session=initial', (async () => { calls++; return new Response(null, { status }); }) as typeof fetch);
    assert.equal((await request('/ask')).status, status);
    assert.equal(calls, 1);
  }
});

test('repeated unauthorized response is returned after one refresh without an infinite loop', async () => {
  let calls = 0;
  const request = auditSession('http://audit.test', 'old', 'session=initial', (async (url: string) => {
    calls++;
    return url.endsWith('/refresh') ? Response.json({ accessToken: 'new' }) : new Response(null, { status: 401 });
  }) as typeof fetch);
  assert.equal((await request('/ask')).status, 401);
  assert.equal(calls, 3);
});
