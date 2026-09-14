// Explicit post-deployment verification against the public service. Never run
// automatically in ordinary CI or send private proxy configuration to it.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must remain enabled');
const origin = 'https://mcp.ipvolt.com';
const endpoint = new URL('/mcp', origin);
const expected = ['diagnose_proxy_error', 'generate_proxy_config', 'get_proxy_doc', 'search_proxy_docs'];
const results = [];
for (const protocol of ['2025-11-25', '2026-07-28']) {
  const client = new Client({ name: 'ipvolt-public-host-verification', version: '1.0.0' }, {
    supportedProtocolVersions: [protocol],
    versionNegotiation: { mode: protocol === '2026-07-28' ? { pin: protocol } : 'legacy' },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), expected);
    for (const [name, args] of [
      ['search_proxy_docs', { query: 'curl proxy', topic: 'setup' }],
      ['get_proxy_doc', { documentId: '/guides/curl-proxy-setup' }],
      ['generate_proxy_config', { client: 'httpx', version: '0.28.1' }],
      ['diagnose_proxy_error', { client: 'httpx', version: '0.28.1', phase: 'proxy_connect', status: 407 }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
      assert.ok(result.structuredContent, name);
      results.push({ protocol, tool: name, ok: true });
    }
    await assert.rejects(client.callTool({ name: 'check_proxy_route', arguments: { profile: 'default' } }));
  } finally { await client.close(); }
}

async function request(path, status, init = {}, hostedHeaders = false) {
  const response = await fetch(new URL(path, origin), { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, status, `${init.method ?? 'GET'} ${path.split('?')[0]}`);
  // Caddy and the application both protect their own responses; a proxied
  // response may repeat the same directives. Verify their effective values.
  const directives = name => [...new Set((response.headers.get(name) ?? '').split(',').map(value => value.trim().toLowerCase()))].sort();
  assert.deepEqual(directives('x-robots-tag'), ['nofollow', 'noindex']);
  assert.deepEqual(directives('x-content-type-options'), ['nosniff']);
  if (hostedHeaders) assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
}
const nonce = randomBytes(16).toString('hex');
const baseline = await (await request(`/egress?nonce=${nonce}`, 200, {}, true)).json();
assert.deepEqual(Object.keys(baseline).sort(), ['ip', 'nonce']);
assert.ok(isIP(baseline.ip), 'Echo returns an IP address');
assert.equal(baseline.nonce, nonce);
const spoofed = await (await request(`/egress?nonce=${nonce}`, 200, { headers: {
  'X-IPVolt-Peer': '203.0.113.99', 'X-Forwarded-For': '203.0.113.99',
  'X-Real-IP': '203.0.113.99', Forwarded: 'for=203.0.113.99',
} }, true)).json();
assert.ok(baseline.ip !== '203.0.113.99' && spoofed.ip === baseline.ip, 'Forwarded headers must not control the peer');
assert.equal(spoofed.nonce, nonce);
for (const [path, status] of [['/healthz', 404], ['/unknown-verification-path', 404], ['/mcp', 405], ['/egress', 400]]) {
  await (await request(path, status, {}, path === '/mcp' || path === '/egress')).arrayBuffer();
}
const options = await request('/mcp', 204, { method: 'OPTIONS', headers: { Origin: 'https://ipvolt.com' } }, true);
assert.equal(options.headers.get('access-control-allow-origin'), 'https://ipvolt.com');
const foreign = await request('/mcp', 403, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' } }, true);
assert.equal(foreign.headers.get('access-control-allow-origin'), null);
await foreign.arrayBuffer();
const report = {
  checkedAt: new Date().toISOString(), endpoint: endpoint.href, node: process.version,
  trustedPublicTls: true, localRouteToolAbsentAndRejected: true, results,
  echoNonceVerified: true, forwardedPeerHeadersIgnored: true, privateHealthHidden: true,
  methodAndCorsBoundariesVerified: true, noindexAndNoStoreVerified: true,
};
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
