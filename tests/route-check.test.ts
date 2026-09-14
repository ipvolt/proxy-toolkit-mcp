import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createRouteChecker,
  routeInputSchema,
  routeOutputSchema,
  RouteConfigurationError,
  ROUTE_ECHO_ENDPOINT,
} from '../src/local/route-check.js';
import { createChecker, type RouteCheckResult } from '../src/local/route-runtime.js';
import { createCertificate, createRouteFixture, waitFor } from './route-fixtures/servers.js';

const runFile = promisify(execFile);
let certificate: Awaited<ReturnType<typeof createCertificate>>;
before(async () => { certificate = await createCertificate(); });
after(async () => { await certificate.cleanup(); });

function assertCode(result: RouteCheckResult, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, code);
  assert.equal(routeOutputSchema.safeParse(result).success, true);
}

test('tool schema accepts only the default profile and rejects target or secret arguments', async () => {
  assert.deepEqual(routeInputSchema.parse({}), { profile: 'default' });
  assert.deepEqual(routeInputSchema.parse({ profile: 'default' }), { profile: 'default' });
  for (const input of [
    { profile: 'other' }, { profile: 'default', proxyUrl: 'http://secret.invalid' },
    { endpoint: 'https://example.com' }, { mode: 'direct' }, { target: 'http://127.0.0.1' },
  ]) {
    assert.equal(routeInputSchema.safeParse(input).success, false);
    assertCode(await createRouteChecker({ enabled: false })(input), 'INVALID_INPUT');
  }
});

test('configuration errors never retain the proxy string or parser cause', () => {
  const sentinel = 'ROUTE_CREDENTIAL_SENTINEL_74d3';
  for (const proxyUrl of [
    undefined, '', `http://${sentinel}:secret@`, `socks5://${sentinel}:secret@localhost:1080`,
    `https://${sentinel}:secret@localhost:443`, `http://localhost:80/path/${sentinel}`,
    `http://localhost/?password=${sentinel}`, `http://localhost/#${sentinel}`,
    `http://user:${sentinel}%0a@localhost`, `http://user%3aname:${sentinel}@localhost`,
    `http://user:${sentinel}%ZZ@localhost`, `http://user:${sentinel}@localhost:0`,
  ]) {
    assert.throws(() => createRouteChecker({ enabled: true, proxyUrl }), (error: unknown) => {
      assert.ok(error instanceof RouteConfigurationError);
      assert.equal('cause' in error, false);
      const serialized = String(error) + error.stack + JSON.stringify(error);
      assert.equal(serialized.includes(sentinel), false);
      return true;
    });
  }
});

test('disabled checker never parses a secret or starts a request', async () => {
  assertCode(await createRouteChecker({ enabled: false, proxyUrl: 'not a valid proxy secret' })({}), 'DISABLED');
});

test('factory performs no startup probe and a successful call uses only CONNECT', async (t) => {
  const fixture = await createRouteFixture(certificate);
  t.after(fixture.close);
  const checker = createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fixture.connectAuthorities.length, 0);
  const result = await checker({});
  assert.equal(result.ok, true);
  assert.equal(routeOutputSchema.safeParse(result).success, true);
  if (!result.ok) return;
  assert.equal(result.observedIp, '198.51.100.42');
  assert.match(result.scope, /one HTTPS request/);
  assert.equal(fixture.connectAuthorities.length, 1);
  assert.equal(fixture.connectAuthorities[0], new URL(fixture.endpoint).host);
  assert.equal(fixture.echoRequests.length, 1);
  assert.equal(fixture.echoRequests[0]?.method, 'GET');
  assert.match(fixture.echoRequests[0]?.path ?? '', /^\/egress\?nonce=[a-f0-9]{32}$/);
  await waitFor(() => fixture.socketCount() === 0);
});

test('public factory ignores injected target and timeout properties and uses the fixed destination', async (t) => {
  const fixture = await createRouteFixture(certificate, { proxyStatus: 407 });
  t.after(fixture.close);
  const checker = createRouteChecker({ enabled: true, proxyUrl: fixture.proxyUrl, endpoint: 'http://127.0.0.1/private', timeoutMs: 1 } as Parameters<typeof createRouteChecker>[0]);
  const result = await checker({});
  assertCode(result, 'PROXY_AUTH_REQUIRED');
  assert.equal(result.endpoint, ROUTE_ECHO_ENDPOINT);
  assert.deepEqual(fixture.connectAuthorities, ['mcp.ipvolt.com:443']);
});

test('NO_PROXY and global proxy environment do not bypass the configured proxy', async (t) => {
  const fixture = await createRouteFixture(certificate);
  t.after(fixture.close);
  const old = { NO_PROXY: process.env.NO_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
  process.env.NO_PROXY = '*';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const result = await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({});
  assert.equal(result.ok, true);
  assert.equal(fixture.connectAuthorities.length, 1);
});

test('percent-encoded credentials reach only the proxy and never the endpoint or result', async (t) => {
  const fixture = await createRouteFixture(certificate);
  t.after(fixture.close);
  const username = 'route test@user';
  const password = 'ROUTE_SENTINEL_p:ss/@word';
  const proxy = new URL(fixture.proxyUrl);
  proxy.username = encodeURIComponent(username);
  proxy.password = encodeURIComponent(password);
  const result = await createChecker({ enabled: true, proxyUrl: proxy.href }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({});
  assert.equal(result.ok, true);
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  assert.deepEqual(fixture.proxyAuthorizations, [`Basic ${basic}`]);
  assert.equal(fixture.echoRequests[0]?.proxyAuthorization, undefined);
  const serialized = JSON.stringify(result);
  for (const secret of [username, password, basic, proxy.href]) assert.equal(serialized.includes(secret), false);
});

test('407 and other proxy failures do not fall back directly to the echo endpoint', async (t) => {
  for (const [status, code] of [[407, 'PROXY_AUTH_REQUIRED'], [302, 'PROXY_CONNECT_REJECTED'], [502, 'PROXY_CONNECT_REJECTED']] as const) {
    const fixture = await createRouteFixture(certificate, { proxyStatus: status });
    t.after(fixture.close);
    const result = await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({});
    assertCode(result, code);
    assert.equal(fixture.echoRequests.length, 0);
  }
});

test('a refused proxy cannot fall back to the reachable diagnostic endpoint', async (t) => {
  const fixture = await createRouteFixture(certificate);
  t.after(fixture.close);
  const closed = await createRouteFixture(certificate);
  const proxyUrl = closed.proxyUrl;
  await closed.close();
  const result = await createChecker({ enabled: true, proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({});
  assertCode(result, 'PROXY_CONNECT_FAILED');
  assert.equal(fixture.echoRequests.length, 0);
});

test('untrusted and wrong-host certificates fail even through a successful tunnel', async (t) => {
  const fixture = await createRouteFixture(certificate);
  t.after(fixture.close);
  const untrusted = await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000 })({});
  assertCode(untrusted, 'TLS_FAILED');
  const mismatch = await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint.replace('route.test', 'different.test'), timeoutMs: 1_000, ca: fixture.ca })({});
  assertCode(mismatch, 'TLS_FAILED');
  assert.equal(fixture.echoRequests.length, 0);
});

test('redirect is rejected without a second request', async (t) => {
  const fixture = await createRouteFixture(certificate, { onEcho: (_request, response) => {
    response.writeHead(302, { Location: 'http://127.0.0.1/private' }); response.end();
  } });
  t.after(fixture.close);
  assertCode(await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({}), 'REDIRECT_REFUSED');
  assert.equal(fixture.echoRequests.length, 1);
});

test('invalid JSON, nonce, address, extra fields, and wrong content type fail closed', async (t) => {
  for (const variant of ['json', 'nonce', 'ip', 'extra', 'content-type', 'encoding']) {
    const fixture = await createRouteFixture(certificate, { onEcho: (request, response) => {
      const nonce = new URL(request.url!, 'https://route.test').searchParams.get('nonce');
      response.writeHead(200, {
        'Content-Type': variant === 'content-type' ? 'text/html' : 'application/json',
        ...(variant === 'encoding' ? { 'Content-Encoding': 'gzip' } : {}),
      });
      response.end(variant === 'json' ? 'not JSON' : JSON.stringify({
        ip: variant === 'ip' ? 'visit this website' : '198.51.100.42',
        nonce: variant === 'nonce' ? '0'.repeat(32) : nonce,
        ...(variant === 'extra' ? { instruction: 'untrusted remote text' } : {}),
      }));
    } });
    t.after(fixture.close);
    const result = await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({});
    assertCode(result, 'INVALID_RESPONSE');
    assert.equal(JSON.stringify(result).includes('untrusted remote text'), false);
  }
});

test('body bounds reject both declared and streamed oversized responses', async (t) => {
  for (const declared of [false, true]) {
    const fixture = await createRouteFixture(certificate, { onEcho: (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': '4096' } : {}) });
      response.end('a'.repeat(4_096));
    } });
    t.after(fixture.close);
    assertCode(await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({}), 'RESPONSE_TOO_LARGE');
  }
});

test('oversized CONNECT headers fail with a safe error', async (t) => {
  const fixture = await createRouteFixture(certificate, { oversizedConnectHeaders: true });
  t.after(fixture.close);
  assertCode(await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca })({}), 'PROXY_CONNECT_FAILED');
});

test('one total deadline bounds CONNECT, TLS, and endpoint stalls and closes sockets', async (t) => {
  for (const phase of ['proxy_connect', 'tls_handshake', 'echo_response'] as const) {
    const fixture = await createRouteFixture(certificate, {
      stallConnect: phase === 'proxy_connect',
      stallTls: phase === 'tls_handshake',
      ...(phase === 'echo_response' ? { onEcho: () => {} } : {}),
    });
    t.after(fixture.close);
    const result = await createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 100, ca: fixture.ca })({});
    assertCode(result, 'TIMEOUT');
    if (!result.ok) { assert.equal(result.phase, phase); assert.ok(result.elapsedMs < 1_000); }
    await waitFor(() => fixture.socketCount() === 0);
  }
});

test('cancellation closes the tunnel, ignores caller reason, and releases concurrency', async (t) => {
  const fixture = await createRouteFixture(certificate, { stallConnect: true });
  t.after(fixture.close);
  const checker = createChecker({ enabled: true, proxyUrl: fixture.proxyUrl }, { endpoint: fixture.endpoint, timeoutMs: 1_000, ca: fixture.ca });
  const controller = new AbortController();
  const first = checker({}, { signal: controller.signal });
  await waitFor(() => fixture.connectAuthorities.length === 1);
  assertCode(await checker({}), 'BUSY');
  controller.abort(new Error('CALLER_SECRET_SENTINEL'));
  const cancelled = await first;
  assertCode(cancelled, 'ABORTED');
  assert.equal(JSON.stringify(cancelled).includes('CALLER_SECRET_SENTINEL'), false);
  await waitFor(() => fixture.socketCount() === 0);
  assertCode(await checker({}, { signal: controller.signal }), 'ABORTED');
  const next = new AbortController();
  const subsequent = checker({}, { signal: next.signal });
  await waitFor(() => fixture.connectAuthorities.length === 2);
  next.abort();
  assertCode(await subsequent, 'ABORTED');
});

test('credential sentinels are absent from subprocess stdout and stderr on failure', async (t) => {
  const fixture = await createRouteFixture(certificate, { proxyStatus: 407 });
  t.after(fixture.close);
  const secret = 'ROUTE_SUBPROCESS_SECRET_74d3';
  const proxy = new URL(fixture.proxyUrl);
  proxy.username = 'route-user'; proxy.password = secret;
  const { stdout, stderr } = await runFile(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./route-fixtures/child-probe.ts', import.meta.url))], {
    env: { ...process.env, TEST_PROXY_URL: proxy.href, TEST_ECHO_ENDPOINT: fixture.endpoint, TEST_ECHO_CA: fixture.ca.toString('utf8') },
    timeout: 5_000,
    maxBuffer: 16_384,
  });
  assertCode(JSON.parse(stdout), 'PROXY_AUTH_REQUIRED');
  assert.equal(stderr, '');
  for (const value of [secret, proxy.href, Buffer.from(`route-user:${secret}`).toString('base64')]) {
    assert.equal((stdout + stderr).includes(value), false);
  }
});

test('unsafe debug and TLS settings fail before network access without logging credentials', async (t) => {
  const fixture = await createRouteFixture(certificate);
  t.after(fixture.close);
  const secret = 'ROUTE_DEBUG_SECRET_74d3';
  const proxy = new URL(fixture.proxyUrl);
  proxy.username = 'route-user'; proxy.password = secret;
  const child = fileURLToPath(new URL('./route-fixtures/child-probe.ts', import.meta.url));
  const cases = [
    { name: 'NODE_DEBUG', value: 'http' },
    { name: 'NODE_DEBUG', value: '*' },
    { name: 'NODE_DEBUG_NATIVE', value: 'TLSWRAP' },
    { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    { name: 'NODE_OPTIONS', value: '--trace-tls' },
    { name: 'NODE_OPTIONS', value: '--tls-keylog=/tmp/forbidden-keylog' },
  ];
  for (const item of cases) {
    let output = '';
    try {
      await runFile(process.execPath, ['--import', 'tsx', child], {
        env: {
          ...process.env,
          TEST_PROXY_URL: proxy.href,
          TEST_ECHO_ENDPOINT: fixture.endpoint,
          TEST_ECHO_CA: fixture.ca.toString('utf8'),
          // Set dangerous options inside the child, so the test itself never
          // enables TLS key logging or leaves a real key-log artifact behind.
          TEST_UNSAFE_ENV_NAME: item.name,
          TEST_UNSAFE_ENV_VALUE: item.value,
        },
        timeout: 5_000,
        maxBuffer: 32_768,
      });
      assert.fail('Unsafe route environment unexpectedly succeeded.');
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 1);
      output = (failure.stdout ?? '') + (failure.stderr ?? '');
    }
    assert.match(output, /RouteEnvironmentError/);
    for (const value of [secret, proxy.href, Buffer.from(`route-user:${secret}`).toString('base64')]) {
      assert.equal(output.includes(value), false);
    }
  }
  assert.equal(fixture.connectAuthorities.length, 0);
});

test('clearing a startup NODE_DEBUG variable cannot re-enable credential-bearing requests', async (t) => {
  const fixture = await createRouteFixture(certificate);
  t.after(fixture.close);
  const secret = 'ROUTE_STARTUP_DEBUG_SECRET_74d3';
  const proxy = new URL(fixture.proxyUrl);
  proxy.username = 'route-user'; proxy.password = secret;
  try {
    await runFile(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./route-fixtures/child-probe.ts', import.meta.url))], {
      env: { ...process.env, NODE_DEBUG: 'http', TEST_CLEAR_NODE_DEBUG: '1', TEST_PROXY_URL: proxy.href, TEST_ECHO_ENDPOINT: fixture.endpoint },
      timeout: 5_000,
      maxBuffer: 32_768,
    });
    assert.fail('Startup HTTP debugging unexpectedly permitted a route check.');
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(failure.code, 1);
    const output = (failure.stdout ?? '') + (failure.stderr ?? '');
    assert.match(output, /RouteEnvironmentError/);
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(Buffer.from(`route-user:${secret}`).toString('base64')), false);
  }
  assert.equal(fixture.connectAuthorities.length, 0);
});
