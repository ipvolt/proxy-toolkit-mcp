import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createHttpService } from '../../src/transports/http.ts';
import { checkRemote, ENDPOINT, verifyEnvironment } from './check-remote.mjs';

async function fixture(tamper) {
  const service = createHttpService();
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const port = service.server.address().port;
  const calls = [];
  return {
    calls, close: () => service.close(),
    fetchImplementation: async (url, init) => {
      assert.equal(String(url), ENDPOINT);
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.ok(init.signal instanceof AbortSignal);
      calls.push(init);
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, init);
      if (!tamper) return response;
      const body = await response.text();
      return new Response([204, 205, 304].includes(response.status) ? null : tamper(body), {
        status: response.status, headers: response.headers,
      });
    },
  };
}

test('official SDK verifies all four real hosted tools on both protocol versions', async () => {
  const local = await fixture();
  try {
    const report = await checkRemote({ fetchImplementation: local.fetchImplementation });
    assert.equal(report.ok, true);
    assert.equal(report.toolCalls, 8);
    assert.deepEqual(report.protocols, ['2025-11-25', '2026-07-28']);
    assert.ok(local.calls.length >= 12 && local.calls.length <= 30);
    assert.ok(!report.tools.includes('check_proxy_route'));
  } finally { await local.close(); }
});

test('a changed public tool catalog blocks publication', async () => {
  const local = await fixture(body => body.replaceAll('diagnose_proxy_error', 'check_proxy_route'));
  try {
    await assert.rejects(checkRemote({ fetchImplementation: local.fetchImplementation }), /^Error: Public remote verification failed$/);
  } finally { await local.close(); }
});

test('successful RPC carrying an unreviewed template revision is rejected', async () => {
  const local = await fixture(body => body.replaceAll('2026-09-14.2', 'unreviewed-revision'));
  try {
    await assert.rejects(checkRemote({ fetchImplementation: local.fetchImplementation }), /Public remote verification failed/);
  } finally { await local.close(); }
});

test('oversized public response fails without reflecting its body', async () => {
  let calls = 0;
  await assert.rejects(checkRemote({ fetchImplementation: async () => {
    calls++;
    return new Response('PRIVATE_RESPONSE_SENTINEL'.repeat(20_000));
  } }), error => error.message === 'Public remote verification failed');
  assert.ok(calls <= 2);
});

test('the overall deadline also bounds a stalled transport', async () => {
  const started = Date.now();
  await assert.rejects(checkRemote({ timeoutMs: 25, fetchImplementation: async () => new Promise(() => {}) }),
                       /Public remote verification failed/);
  assert.ok(Date.now() - started < 3000);
});

test('unsafe debug, proxy and TLS environment fails before any request', async () => {
  for (const environment of [{ DEBUG: 'pw:*' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { NODE_OPTIONS: '--trace-tls' }, { NODE_EXTRA_CA_CERTS: '/unreviewed-ca.pem' }, { NODE_USE_ENV_PROXY: '1' }]) {
    let calls = 0;
    await assert.rejects(checkRemote({ environment, fetchImplementation: async () => { calls++; throw new Error(); } }),
                         /Public remote verification failed/);
    assert.equal(calls, 0);
  }
  assert.throws(() => verifyEnvironment({}, ['--tls-keylog=/tmp/not-created']), /Public remote verification failed/);
});

test('CLI emits only a fixed failure even when rejected environment contains a secret sentinel', async () => {
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ['registry/hosted/check-remote.mjs'], {
    cwd: new URL('../../', import.meta.url), env: { ...process.env, DEBUG: 'PRIVATE_DEBUG_SENTINEL' },
  }), error => {
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'Public remote verification failed.\n');
    return true;
  });
});
