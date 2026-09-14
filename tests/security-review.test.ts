import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, ProtocolError, StreamableHTTPClientTransport, UnsupportedProtocolVersionError } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PublicCatalog, loadPublicCatalog, documentOutputSchema, searchOutputSchema } from '../src/core/catalog.js';
import { createHttpService } from '../src/transports/http.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = JSON.parse(readFileSync(new URL('../content/catalog.json', import.meta.url), 'utf8'));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('independent review: every bundled document round-trips across bounded revision cursors', () => {
  const catalog = new PublicCatalog(bundle);
  assert.equal(sha256(JSON.stringify(bundle.documents)), bundle.bundleSha256);
  for (const document of bundle.documents) {
    assert.match(document.id, /^\/(guides|blog)\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(document.url, `https://ipvolt.com${document.id}`);
    assert.equal(sha256(document.markdown), document.sha256);
    let cursor: string | undefined;
    let recovered = '';
    let chunks = 0;
    do {
      const result = catalog.get({ documentId: document.id, cursor });
      assert.ok(documentOutputSchema.safeParse(result).success);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16_384);
      assert.equal(result.chunk, chunks++);
      assert.equal(result.document.sha256, document.sha256);
      recovered += result.markdown;
      cursor = result.nextCursor ?? undefined;
      assert.ok(chunks < 100, 'Document cursors must converge.');
    } while (cursor);
    assert.equal(recovered, document.markdown);
  }
});

test('independent review: catalog rejects altered content and forbidden document paths', () => {
  const altered = structuredClone(bundle);
  altered.documents[0].markdown += '\nAltered after review.';
  assert.throws(() => new PublicCatalog(altered), /checksum mismatch/);
  altered.bundleSha256 = sha256(JSON.stringify(altered.documents));
  assert.throws(() => new PublicCatalog(altered), /Invalid public catalog provenance/);
  const catalog = loadPublicCatalog();
  for (const documentId of ['/admin', '/admin/leads', '/privacy', '/guides/../../admin', '/guides/%2e%2e', 'file:///etc/passwd', 'https://ipvolt.com/admin']) {
    assert.throws(() => catalog.get({ documentId }));
  }
  const first = bundle.documents[0];
  assert.throws(() => catalog.get({ documentId: first.id, cursor: '0'.repeat(16) + ':1' }), /Invalid or stale/);
});

test('independent review regression: setup topic includes the published integration guides', () => {
  const catalog = loadPublicCatalog();
  for (const query of ['curl', 'Requests', 'HTTPX', 'Playwright', 'Node.js']) {
    const result = catalog.search({ query, topic: 'setup' });
    assert.ok(searchOutputSchema.safeParse(result).success);
    assert.ok(result.results.length > 0, `Missing setup result for ${query}`);
    assert.ok(result.results.every((document) => document.topic === 'setup'));
  }
});

async function connected(mode: 'legacy' | 'modern', onError?: (message: string) => void) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/transports/stdio.ts'],
    cwd: root,
    stderr: 'pipe',
    env: { IPVOLT_ENABLE_ROUTE_CHECK: '0' },
  });
  const errors: string[] = [];
  transport.stderr?.on('data', (chunk) => errors.push(String(chunk)));
  const client = new Client({ name: 'independent-security-review', version: '1.0.0' }, {
    supportedProtocolVersions: [mode === 'modern' ? '2026-07-28' : '2025-11-25'],
    versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    listChanged: { tools: { onChanged: (error) => { if (error) onError?.(String(error)); } } },
  });
  client.onerror = (error) => onError?.(String(error));
  await client.connect(transport);
  return { client, errors };
}

for (const mode of ['legacy', 'modern'] as const) {
  test(`independent review regression: ${mode} wire errors do not echo rejected secret-shaped keys`, async () => {
    const { client, errors } = await connected(mode);
    try {
      const sentinel = 'REVIEW_CREDENTIAL_SENTINEL_961b';
      for (const [name, arguments_] of [
        ['generate_proxy_config', { client: 'httpx', version: '0.28.1', [sentinel]: 'ignored' }],
        ['diagnose_proxy_error', { client: 'httpx', version: '0.28.1', phase: 'unknown', [sentinel]: 'ignored' }],
        ['get_proxy_doc', { documentId: '/admin/leads', [sentinel]: 'ignored' }],
        ['search_proxy_docs', { query: 'curl', [sentinel]: 'ignored' }],
      ] as const) {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.equal(result.isError, true);
        assert.equal(JSON.stringify(result).includes(sentinel), false);
      }
      let unknown: unknown;
      try { unknown = await client.callTool({ name: sentinel, arguments: {} }); }
      catch (error) { unknown = String(error); }
      assert.equal(JSON.stringify(unknown).includes(sentinel), false);
      assert.equal(errors.join('').includes(sentinel), false);
    } finally {
      await client.close();
    }
  });
}

test('independent HTTP review regression: unsupported protocol version retains typed negotiation data', async () => {
  const service = createHttpService();
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const address = service.server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-08-01', 'Mcp-Method': 'server/discover',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-08-01',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'independent-review', version: '1.0.0' },
      } } }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: number; message: string; data: { supported: string[]; requested: string } } };
    assert.equal(body.error.code, -32022);
    assert.ok(body.error.data.supported.includes('2026-07-28'));
    assert.equal(body.error.data.requested, '2026-08-01');
    assert.ok(ProtocolError.fromError(body.error.code, body.error.message, body.error.data) instanceof UnsupportedProtocolVersionError);
  } finally {
    await service.close();
  }
});

test('independent review regression: modern static catalog does not advertise unsupported change subscriptions', async () => {
  const protocolErrors: string[] = [];
  const { client, errors } = await connected('modern', (error) => protocolErrors.push(error));
  try {
    const discovery = await client.discover();
    assert.ok(discovery.supportedVersions.includes('2026-07-28'));
    assert.notEqual(discovery.capabilities.tools?.listChanged, true);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'diagnose_proxy_error', 'generate_proxy_config', 'get_proxy_doc', 'search_proxy_docs',
    ]);
    assert.ok(tools.tools.every((tool) => tool.inputSchema.type === 'object' && tool.outputSchema?.type === 'object'));
    const result = await client.callTool({ name: 'generate_proxy_config', arguments: { client: 'httpx', version: '0.28.1' } });
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as { client?: string }).client, 'httpx');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(protocolErrors, []);
    assert.deepEqual(errors, []);
  } finally {
    await client.close();
  }
});

test('independent HTTP review regressions: MCP-Name preflight, empty Origin, and external health access', async () => {
  const service = createHttpService({ trustProxy: true });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const address = service.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const preflight = await fetch(base + '/mcp', { method: 'OPTIONS', headers: {
      Origin: 'https://ipvolt.com', 'x-ipvolt-peer': '203.0.113.10',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,mcp-protocol-version,mcp-method,mcp-name',
    } });
    assert.equal(preflight.status, 204);
    const allowed = preflight.headers.get('access-control-allow-headers')?.toLowerCase().split(/\s*,\s*/);
    for (const name of ['content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name']) assert.ok(allowed?.includes(name));
    const emptyOrigin = await fetch(base + '/mcp', { method: 'POST', headers: {
      Origin: '', 'x-ipvolt-peer': '203.0.113.10', 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(emptyOrigin.status, 403);
    await emptyOrigin.arrayBuffer();
    const externalHealth = await fetch(base + '/healthz', { headers: { 'x-ipvolt-peer': '203.0.113.10' } });
    assert.equal(externalHealth.status, 403);
    await externalHealth.arrayBuffer();
    const localHealth = await fetch(base + '/healthz');
    assert.equal(localHealth.status, 200);
    await localHealth.arrayBuffer();
  } finally {
    await service.close();
  }
});

for (const mode of ['legacy', 'modern'] as const) {
  test(`independent HTTP review: pinned ${mode} tools stay public and rejected data is sanitized`, async () => {
    const service = createHttpService();
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const address = service.server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const client = new Client({ name: 'independent-http-review', version: '1.0.0' }, {
      supportedProtocolVersions: [mode === 'modern' ? '2026-07-28' : '2025-11-25'],
      versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 4);
      assert.equal(tools.tools.some((tool) => tool.name === 'check_proxy_route'), false);
      const valid = await client.callTool({ name: 'get_proxy_doc', arguments: { documentId: '/guides/curl-proxy-setup' } });
      assert.notEqual(valid.isError, true);
      assert.ok(documentOutputSchema.safeParse(valid.structuredContent).success);
      const sentinel = 'HTTP_REVIEW_SECRET_SENTINEL_961b';
      const rejected = await client.callTool({ name: 'generate_proxy_config', arguments: { client: 'httpx', version: '0.28.1', [sentinel]: 'ignored' } });
      assert.equal(rejected.isError, true);
      assert.equal(JSON.stringify(rejected).includes(sentinel), false);
      let localTool: unknown;
      try { localTool = await client.callTool({ name: 'check_proxy_route', arguments: {} }); }
      catch (error) { localTool = String(error); }
      assert.ok(typeof localTool === 'string' || (localTool as { isError?: boolean }).isError === true);
      const echo = await fetch(base + '/egress?nonce=' + 'a'.repeat(32), { headers: {
        'x-forwarded-for': '203.0.113.42', 'x-ipvolt-peer': '203.0.113.42',
      } });
      const observed = await echo.json() as { ip: string; nonce: string };
      assert.notEqual(observed.ip, '203.0.113.42');
      assert.equal(observed.nonce, 'a'.repeat(32));
    } finally {
      await client.close();
      await service.close();
    }
  });
}
