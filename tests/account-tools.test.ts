import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AccountApi, AccountConfigurationError, DEFAULT_API_BASE, USER_AGENT, readAccountConfig } from '../src/account/client.js';
import { PreviewStore } from '../src/account/tools.js';
import { createHttpService } from '../src/transports/http.js';
import { VERSION } from '../src/meta.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const PUBLIC_TOOLS = ['diagnose_proxy_error', 'generate_proxy_config', 'get_proxy_doc', 'search_proxy_docs'];
const ACCOUNT_TOOLS = ['extend_rental', 'get_balance', 'get_rental', 'list_rentals', 'list_stock', 'rent_proxy', 'rotate_ip'];
// Key-shaped and credential-shaped values are generated per run; none is a literal.
const newKey = () => 'ipvolt_' + randomBytes(32).toString('base64url');
const newSecret = (prefix: string) => prefix + randomBytes(12).toString('base64url');
const RENTAL = '6703f0a1b2c3d4e5f6a7b8c9';

/* ------------------------------------------------------------ fake API */

type Recorded = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
type Answer = { status: number; body?: unknown; raw?: string; headers?: Record<string, string>; delayMs?: number } | 'drop';
type State = {
  key: string; access: 'read' | 'read_write'; balanceMinor: number; cooldown: boolean; priceRise: boolean;
  user: string; password: string; dropNext: string[]; override?: (request: Recorded) => Answer | undefined;
};

const STOCK = {
  currency: 'USD', observedAt: '2026-11-18T14:40:00.000Z', purchasesOpen: true,
  offers: [
    { country: 'US', countryName: 'United States', carrier: 'Verizon', days: 1, priceMinor: 900, price: '9.00', available: true },
    { country: 'US', countryName: 'United States', carrier: 'Verizon', days: 30, priceMinor: 10000, price: '100.00', available: true },
    { country: 'US', countryName: 'United States', carrier: 'T-Mobile', days: 30, priceMinor: null, price: null, available: false },
    { country: 'SG', countryName: 'Singapore', carrier: 'Singtel', days: 30, priceMinor: 6900, price: '69.00', available: true, includedGb: 500 },
  ],
};

async function fakeApi(overrides: Partial<State> = {}) {
  const state: State = {
    key: newKey(), access: 'read_write', balanceMinor: 25_000, cooldown: false, priceRise: false,
    user: newSecret('user-'), password: newSecret('pass-'), dropNext: [], ...overrides,
  };
  const requests: Recorded[] = [];
  const orders = new Map<string, { body: string; answer: Record<string, unknown> }>();
  const rental = () => ({
    id: RENTAL, orderId: '4b2e00000000000000000001', status: 'active', country: 'US', countryName: 'United States', carrier: 'Verizon',
    endsAt: '2026-11-19T14:00:00.000Z', online: true, externalIp: '203.0.113.7', canRotate: true, canExtend: true,
    connection: {
      http: { host: 'proxy.example.net', port: 10000, username: state.user, password: state.password },
      socks5: { host: 'proxy.example.net', port: 10001, username: state.user, password: state.password },
    },
  });
  const spend = (request: Recorded, priceMinor: number, extra: Record<string, unknown>): Answer => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return { status: 400, body: { error: 'idempotency_key_required', message: 'Send an Idempotency-Key header.' } };
    if (request.headers['content-type'] !== 'application/json') return { status: 415, body: { error: 'json_required', message: 'Use JSON.' } };
    if (state.access === 'read') return { status: 403, body: { error: 'read_only_api_key', message: 'This API key is read-only.' } };
    const previous = orders.get(key);
    if (previous) {
      if (previous.body !== request.body) return { status: 409, body: { error: 'intent_conflict', message: 'This Idempotency-Key was used for a different request.' } };
      return { status: 200, body: { ...previous.answer, replayed: true } };
    }
    const body = JSON.parse(request.body) as { maxPriceMinor?: number; quantity?: number };
    const current = state.priceRise ? priceMinor + 2000 : priceMinor;
    if (body.maxPriceMinor === undefined) return { status: 400, body: { error: 'max_price_required', message: 'maxPriceMinor is required.' } };
    if (current > body.maxPriceMinor) return { status: 409, body: { error: 'price_above_max', message: 'The price is above your maximum.', priceMinor: current, maxPriceMinor: body.maxPriceMinor } };
    const total = current * (body.quantity ?? 1);
    if (total > state.balanceMinor) {
      const missing = total - state.balanceMinor;
      return { status: 409, body: { error: 'insufficient_balance', message: `Your balance is $${(missing / 100).toFixed(2)} short for this order. Add funds and try again.`, requiredMinor: total, availableMinor: state.balanceMinor, missingMinor: missing } };
    }
    state.balanceMinor -= total;
    const answer = { orderId: randomUUID(), status: 'paid', replayed: false, chargedMinor: total, currency: 'USD', ...extra };
    orders.set(key, { body: request.body, answer });
    return { status: 200, body: answer };
  };
  const route = (request: Recorded): Answer => {
    const custom = state.override?.(request);
    if (custom) return custom;
    const drop = state.dropNext.indexOf(`${request.method} ${request.path}`);
    if (drop !== -1) { state.dropNext.splice(drop, 1); return 'drop'; }
    if (request.method === 'GET' && request.path === '/stock') return { status: 200, body: STOCK };
    if (request.headers.authorization !== `Bearer ${state.key}`) return { status: 401, body: { error: 'invalid_api_key', message: 'Missing, wrong, expired or revoked API key.' } };
    if (request.method === 'GET' && request.path === '/key') {
      return { status: 200, body: { id: 'k1', name: 'scraper', access: state.access, dailyLimitMinor: 5000, spentTodayMinor: 900, remainingTodayMinor: 4100, dayResetsAt: '2026-11-19T00:00:00.000Z', expiresAt: '2027-02-16T14:00:00.000Z' } };
    }
    if (request.method === 'GET' && request.path === '/balance') return { status: 200, body: { currency: 'USD', mode: 'live', availableMinor: String(state.balanceMinor), heldMinor: '0' } };
    if (request.method === 'GET' && request.path === '/rentals') return { status: 200, body: { rentals: [rental()] } };
    if (request.method === 'GET' && request.path === `/rentals/${RENTAL}`) return { status: 200, body: rental() };
    if (request.method === 'GET' && request.path === `/rentals/${RENTAL}/extension-price?days=30`) return { status: 200, body: { rentalId: RENTAL, days: 30, priceMinor: 10000, currency: 'USD', endsAt: '2026-11-19T14:00:00.000Z' } };
    if (request.method === 'GET' && request.path.startsWith('/rentals/')) return { status: 404, body: { error: 'rental_not_found', message: 'No such rental.' } };
    if (request.method === 'POST' && request.path === '/rentals') {
      const days = (JSON.parse(request.body || '{}') as { days?: number }).days;
      return spend(request, days === 1 ? 900 : 10000, { rentalIds: [] });
    }
    if (request.method === 'POST' && request.path === `/rentals/${RENTAL}/extend`) return spend(request, 10000, { rentalId: RENTAL, days: 30 });
    if (request.method === 'POST' && request.path === `/rentals/${RENTAL}/rotate`) {
      if (state.access === 'read') return { status: 403, body: { error: 'read_only_api_key', message: 'This API key is read-only.' } };
      if (state.cooldown) return { status: 429, headers: { 'Retry-After': '42' }, body: { error: 'rotation_cooldown', message: 'This device was rotated too recently.', retryAfterSeconds: 42 } };
      return { status: 200, body: { rotated: true, pending: false, ip: '198.51.100.4', message: 'Rotated.' } };
    }
    return { status: 404, body: { error: 'not_found', message: 'Not found.' } };
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(request);
    const answer = route(request);
    if (answer === 'drop') { req.socket.destroy(); return; }
    if (answer.delayMs) await pause(answer.delayMs);
    if (res.destroyed) return;
    res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
    res.end(answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    state, requests, base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
type Fake = Awaited<ReturnType<typeof fakeApi>>;

/* ---------------------------------------------------------- MCP clients */

type Result = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text: string }[] };

async function stdio(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/transports/stdio.ts'], cwd: root, stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'account-tools-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

/** Connects the real stdio entry to the fake API and checks every result for the key. */
async function session(fake: Fake) {
  const connection = await stdio({ IPVOLT_API_KEY: fake.state.key, IPVOLT_API_BASE: fake.base });
  const seen: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const result = await connection.client.callTool({ name, arguments: args }) as Result;
    const encoded = JSON.stringify(result);
    seen.push(encoded);
    assert.equal(encoded.includes(fake.state.key), false, `${name} result contains the API key`);
    return result;
  };
  return {
    ...connection, call, seen,
    async finish() {
      const stderr = connection.stderr();
      await connection.close();
      // stdio writes nothing for these calls: no key, connection details or request data on stderr.
      assert.equal(stderr, '');
    },
  };
}
const text = (result: Result) => result.content.map(part => part.text).join('\n');
const errorOf = (result: Result) => { assert.equal(result.isError, true, JSON.stringify(result)); return result.structuredContent!.error as Record<string, any>; };
const okOf = (result: Result) => { assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent!; };
const posts = (fake: Fake) => fake.requests.filter(request => request.method === 'POST');

/* ---------------------------------------------------------------- tests */

test('account configuration: unset or empty key disables the tools; malformed values are refused without echo', () => {
  const key = newKey();
  assert.equal(readAccountConfig({}), undefined);
  assert.equal(readAccountConfig({ IPVOLT_API_KEY: '' }), undefined);
  assert.equal(readAccountConfig({ IPVOLT_API_KEY: '   ' }), undefined);
  assert.deepEqual(readAccountConfig({ IPVOLT_API_KEY: key }), { apiKey: key, baseUrl: DEFAULT_API_BASE });
  assert.equal(DEFAULT_API_BASE, 'https://ipvolt.com/beta/api/v1');
  assert.equal(readAccountConfig({ IPVOLT_API_KEY: ` ${key}\n` })?.apiKey, key);
  for (const base of ['https://api.example.net/v1/', 'http://127.0.0.1:8080', 'http://localhost:9/x', 'http://[::1]:7']) {
    assert.ok(readAccountConfig({ IPVOLT_API_KEY: key, IPVOLT_API_BASE: base })?.baseUrl.startsWith(base.replace(/\/$/, '')));
  }
  const sentinel = randomBytes(8).toString('hex');
  for (const environment of [
    { IPVOLT_API_KEY: `not-a-key-${sentinel}` },
    { IPVOLT_API_KEY: `${key} ${sentinel}` },
    { IPVOLT_API_KEY: key, IPVOLT_API_BASE: `http://api-${sentinel}.example.net` },
    { IPVOLT_API_KEY: key, IPVOLT_API_BASE: `https://user:${sentinel}@ipvolt.com/beta/api/v1` },
    { IPVOLT_API_KEY: key, IPVOLT_API_BASE: `https://ipvolt.com/beta/api/v1?x=${sentinel}` },
    { IPVOLT_API_KEY: key, IPVOLT_API_BASE: `ftp://${sentinel}.example.net` },
  ]) {
    assert.throws(() => readAccountConfig(environment), (error: unknown) => {
      assert.ok(error instanceof AccountConfigurationError);
      assert.equal(error.message.includes(sentinel) || error.message.includes(key), false);
      return true;
    });
  }
});

test('stdio registers the seven account tools only when IPVOLT_API_KEY is set, without any startup request', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  try {
    for (const env of [{}, { IPVOLT_API_KEY: '' }, { IPVOLT_API_BASE: fake.base }]) {
      const connection = await stdio(env);
      try {
        assert.deepEqual((await connection.client.listTools()).tools.map(tool => tool.name).sort(), PUBLIC_TOOLS);
      } finally { await connection.close(); }
    }
    const connection = await stdio({ IPVOLT_API_KEY: fake.state.key, IPVOLT_API_BASE: fake.base });
    try {
      const list = await connection.client.listTools();
      assert.deepEqual(list.tools.map(tool => tool.name).sort(), [...ACCOUNT_TOOLS, ...PUBLIC_TOOLS].sort());
      assert.equal(JSON.stringify(list).includes(fake.state.key), false);
      const tools = Object.fromEntries(list.tools.map(tool => [tool.name, tool]));
      const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
      const spend = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
      for (const name of ['list_stock', 'get_balance', 'list_rentals', 'get_rental']) {
        assert.deepEqual(tools[name]!.annotations, read, name);
        assert.match(tools[name]!.description!, /^Read-only, free\./);
      }
      for (const name of ['rent_proxy', 'extend_rental']) {
        assert.deepEqual(tools[name]!.annotations, spend, name);
        assert.match(tools[name]!.description!, /^SPENDS MONEY from the prepaid ipvolt balance\./);
        assert.match(tools[name]!.description!, /confirm: true/);
      }
      assert.deepEqual(tools.rotate_ip!.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
      assert.match(tools.rotate_ip!.description!, /^CHANGES STATE, costs nothing\./);
      for (const name of ACCOUNT_TOOLS) {
        assert.equal(tools[name]!.inputSchema.type, 'object');
        assert.equal(tools[name]!.outputSchema?.type, 'object');
      }
      for (const name of PUBLIC_TOOLS) assert.equal(tools[name]!.annotations?.openWorldHint, false);
      assert.equal(connection.stderr(), '');
    } finally { await connection.close(); }
    assert.equal(fake.requests.length, 0, 'Listing tools must not call the API');
  } finally { await fake.close(); }
});

test('the hosted HTTP service keeps exactly its public tools when IPVOLT_API_KEY is set', { timeout: 20_000 }, async () => {
  const listHttp = async () => {
    const service = createHttpService({ publicUrl: 'http://127.0.0.1/mcp' });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const { port } = service.server.address() as AddressInfo;
    const client = new Client({ name: 'account-http-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const tools = (await client.listTools()).tools;
      let rejected = 0;
      for (const name of ACCOUNT_TOOLS) {
        try { const result = await client.callTool({ name, arguments: {} }); if (result.isError) rejected++; } catch { rejected++; }
      }
      assert.equal(rejected, ACCOUNT_TOOLS.length);
      return tools;
    } finally { await client.close(); await service.close(); }
  };
  const before = await listHttp();
  const key = newKey();
  const saved = { key: process.env.IPVOLT_API_KEY, base: process.env.IPVOLT_API_BASE };
  process.env.IPVOLT_API_KEY = key;
  process.env.IPVOLT_API_BASE = 'http://127.0.0.1:9';
  try {
    const after = await listHttp();
    assert.deepEqual(after, before);
    assert.deepEqual(after.map(tool => tool.name).sort(), PUBLIC_TOOLS);
    assert.equal(JSON.stringify(after).includes(key), false);
  } finally {
    if (saved.key === undefined) delete process.env.IPVOLT_API_KEY; else process.env.IPVOLT_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.IPVOLT_API_BASE; else process.env.IPVOLT_API_BASE = saved.base;
  }

  // The HTTP entrypoint process itself, started with the variable in its environment.
  const port = await new Promise<number>((done, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address() as AddressInfo; probe.close(error => error ? reject(error) : done(free)); });
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/transports/http.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', IPVOLT_MCP_PORT: String(port), IPVOLT_MCP_PUBLIC_URL: 'http://127.0.0.1/mcp', IPVOLT_API_KEY: key, IPVOLT_API_BASE: 'http://127.0.0.1:9' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  try {
    for (let waited = 0; !stdout.includes('"ready"') && child.exitCode === null && waited < 10_000; waited += 20) await pause(20);
    assert.ok(stdout.includes('"ready"'), 'HTTP entrypoint did not start');
    const client = new Client({ name: 'account-http-process-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), PUBLIC_TOOLS);
    } finally { await client.close(); }
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
  assert.equal(stdout.includes(key) || stderr.includes(key), false);
});

test('misconfigured account settings stop the stdio server with a generic message', { timeout: 20_000 }, async () => {
  const sentinel = randomBytes(8).toString('hex');
  for (const env of [
    { IPVOLT_API_KEY: `wrong-${sentinel}` },
    { IPVOLT_API_KEY: newKey(), IPVOLT_API_BASE: `http://${sentinel}.example.net/v1` },
    { IPVOLT_API_KEY: newKey(), NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ]) {
    await assert.rejects(run(process.execPath, ['--import', 'tsx', 'src/transports/stdio.ts'], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, timeout: 10_000 }),
      (error: { code?: number; stderr?: string; stdout?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? '', /^Unable to start ipvolt Proxy Toolkit\./);
        assert.equal(`${error.stderr}${error.stdout}`.includes(sentinel), false);
        if (env.IPVOLT_API_KEY) assert.equal(`${error.stderr}${error.stdout}`.includes(env.IPVOLT_API_KEY), false);
        return true;
      });
  }
  const help = await run(process.execPath, ['--import', 'tsx', 'src/transports/stdio.ts', '--help'], { cwd: root, env: { PATH: process.env.PATH ?? '' } });
  assert.match(help.stdout, /IPVOLT_API_KEY/);
});

test('list_stock and get_balance read the API with a descriptive User-Agent; stock is read without the key', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  const mcp = await session(fake);
  try {
    const stock = okOf(await mcp.call('list_stock', { country: 'us' }));
    assert.deepEqual(stock.offers.map((offer: { carrier: string; days: number }) => `${offer.carrier}/${offer.days}`), ['Verizon/1', 'Verizon/30']);
    assert.equal(stock.purchasesOpen, true);
    const all = await mcp.call('list_stock', { country: 'US', includeSoldOut: true });
    assert.equal(okOf(all).offers.length, 3);
    assert.match(text(all), /T-Mobile, 30 days: sold out/);
    const singapore = await mcp.call('list_stock', { country: 'SG', days: 30 });
    assert.match(text(singapore), /Singtel, 30 days: \$69\.00 \(includes 500 GB of data\)/);
    assert.equal(/unlimited/i.test(text(singapore)), false);

    const balance = await mcp.call('get_balance');
    const values = okOf(balance);
    assert.deepEqual(values.balance, { currency: 'USD', availableMinor: 25_000, heldMinor: 0 });
    assert.equal(values.key.access, 'read_write');
    assert.equal(values.key.remainingTodayMinor, 4100);
    assert.match(text(balance), /Available balance: \$250\.00\./);
    assert.match(text(balance), /read and write/);
    assert.match(text(balance), /Daily limit \$50\.00, spent today \$9\.00, remaining today \$41\.00/);

    for (const request of fake.requests) {
      assert.equal(request.headers['user-agent'], USER_AGENT);
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.authorization, request.path === '/stock' ? undefined : `Bearer ${fake.state.key}`);
    }
    assert.match(USER_AGENT, /^ipvolt-proxy-toolkit-mcp\/\d+\.\d+\.\d+$/);
    assert.equal(USER_AGENT, `ipvolt-proxy-toolkit-mcp/${VERSION}`);
    assert.deepEqual([...new Set(fake.requests.map(request => request.path))].sort(), ['/balance', '/key', '/stock']);
    await mcp.finish();
  } finally { await mcp.close(); await fake.close(); }
});

test('rent_proxy previews the charge, then confirms with the requestId as Idempotency-Key and the previewed price as maximum', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  const mcp = await session(fake);
  try {
    const preview = await mcp.call('rent_proxy', { country: 'us', carrier: 'verizon', days: 30 });
    const shown = okOf(preview);
    assert.equal(shown.stage, 'preview');
    assert.match(shown.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(shown.summary, `Renting 1 × US Verizon for 30 days will charge $100.00 from your balance. Nothing has been charged yet. To proceed, call rent_proxy again with confirm: true and requestId: ${shown.requestId}`);
    assert.equal(shown.totalMinor, 10000);
    assert.equal(posts(fake).length, 0, 'A preview must not send a spending request');

    const confirmed = okOf(await mcp.call('rent_proxy', { confirm: true, requestId: shown.requestId }));
    assert.equal(posts(fake).length, 1);
    const [first] = posts(fake);
    assert.equal(first!.path, '/rentals');
    assert.equal(first!.headers['idempotency-key'], shown.requestId);
    assert.equal(first!.headers['content-type'], 'application/json');
    assert.equal(first!.headers.authorization, `Bearer ${fake.state.key}`);
    assert.deepEqual(JSON.parse(first!.body), { country: 'US', carrier: 'Verizon', days: 30, quantity: 1, maxPriceMinor: 10000 });
    assert.equal(confirmed.stage, 'confirmed');
    assert.equal(confirmed.order.replayed, false);
    assert.equal(confirmed.order.chargedMinor, 10000);
    assert.equal(fake.state.balanceMinor, 15_000);

    // Repeating the confirm reuses the same key and body: the API replays the order and charges nothing.
    const repeated = await mcp.call('rent_proxy', { confirm: true, requestId: shown.requestId, country: 'US', carrier: 'Verizon', days: 30 });
    assert.equal(posts(fake).length, 2);
    assert.equal(posts(fake)[1]!.headers['idempotency-key'], shown.requestId);
    assert.equal(posts(fake)[1]!.body, first!.body);
    assert.equal(okOf(repeated).order.replayed, true);
    assert.equal(okOf(repeated).order.orderId, confirmed.order.orderId);
    assert.match(text(repeated), /nothing was charged again/);
    assert.equal(fake.state.balanceMinor, 15_000);

    const several = okOf(await mcp.call('rent_proxy', { country: 'US', carrier: 'Verizon', days: 1, quantity: 3 }));
    assert.match(several.summary, /^Renting 3 × US Verizon for 1 day will charge \$27\.00 \(\$9\.00 each\) from your balance\./);
    const other = okOf(await mcp.call('rent_proxy', { country: 'US', carrier: 'Verizon', days: 30 }));
    assert.notEqual(other.requestId, shown.requestId);

    // Requests that never reach the API.
    assert.equal(errorOf(await mcp.call('rent_proxy', { confirm: true })).code, 'request_id_required');
    assert.equal(errorOf(await mcp.call('rent_proxy', { confirm: true, requestId: randomUUID() })).code, 'unknown_request');
    assert.equal(errorOf(await mcp.call('rent_proxy', { confirm: true, requestId: several.requestId, quantity: 2 })).code, 'preview_mismatch');
    assert.equal(errorOf(await mcp.call('rent_proxy', { confirm: true, requestId: several.requestId, carrier: 'T-Mobile' })).code, 'preview_mismatch');
    assert.equal(errorOf(await mcp.call('rent_proxy', { requestId: several.requestId })).code, 'confirm_required');
    assert.equal(errorOf(await mcp.call('rent_proxy', { country: 'US' })).code, 'invalid_request');
    assert.equal(errorOf(await mcp.call('rent_proxy', { country: 'US', carrier: 'T-Mobile', days: 30 })).code, 'stock_unavailable');
    assert.equal(errorOf(await mcp.call('rent_proxy', { country: 'FR', carrier: 'Orange', days: 30 })).code, 'offer_not_found');
    assert.equal(posts(fake).length, 2);

    // The extend preview's requestId cannot confirm a rental.
    const extendPreview = okOf(await mcp.call('extend_rental', { rentalId: RENTAL, days: 30 }));
    assert.equal(errorOf(await mcp.call('rent_proxy', { confirm: true, requestId: extendPreview.requestId })).code, 'unknown_request');

    // A price rise after the preview is refused by the API, not charged.
    fake.state.priceRise = true;
    const risen = await mcp.call('rent_proxy', { confirm: true, requestId: other.requestId });
    assert.equal(errorOf(risen).code, 'price_above_max');
    assert.equal(errorOf(risen).priceMinor, 12000);
    assert.equal(JSON.parse(posts(fake).at(-1)!.body).maxPriceMinor, 10000);
    assert.match(risen.structuredContent!.summary, /The price is now \$120\.00, above the previewed \$100\.00\. This request charged nothing\./);
    assert.equal(fake.state.balanceMinor, 15_000);
    await mcp.finish();
  } finally { await mcp.close(); await fake.close(); }
});

test('extend_rental previews the extension price and confirms idempotently', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  const mcp = await session(fake);
  try {
    const preview = okOf(await mcp.call('extend_rental', { rentalId: RENTAL, days: 30 }));
    assert.equal(fake.requests.at(-1)!.path, `/rentals/${RENTAL}/extension-price?days=30`);
    assert.equal(preview.summary, `Extending rental ${RENTAL} by 30 days will charge $100.00 from your balance. Nothing has been charged yet. To proceed, call extend_rental again with confirm: true and requestId: ${preview.requestId}`);
    assert.equal(posts(fake).length, 0);

    assert.equal(errorOf(await mcp.call('extend_rental', { rentalId: RENTAL, days: 1, confirm: true, requestId: preview.requestId })).code, 'preview_mismatch');
    assert.equal(posts(fake).length, 0);

    for (const attempt of [1, 2]) {
      const result = okOf(await mcp.call('extend_rental', { rentalId: RENTAL, days: 30, confirm: true, requestId: preview.requestId }));
      const sent = posts(fake);
      assert.equal(sent.length, attempt);
      assert.equal(sent.at(-1)!.path, `/rentals/${RENTAL}/extend`);
      assert.equal(sent.at(-1)!.headers['idempotency-key'], preview.requestId);
      assert.deepEqual(JSON.parse(sent.at(-1)!.body), { days: 30, maxPriceMinor: 10000 });
      assert.equal(result.order.replayed, attempt === 2);
      assert.equal(result.order.chargedMinor, 10000);
    }
    assert.equal(fake.state.balanceMinor, 15_000);
    await mcp.finish();
  } finally { await mcp.close(); await fake.close(); }
});

test('API refusals pass through: read-only key, insufficient balance and rotation cooldown', { timeout: 20_000 }, async () => {
  const fake = await fakeApi({ access: 'read' });
  const mcp = await session(fake);
  try {
    const rent = okOf(await mcp.call('rent_proxy', { country: 'US', carrier: 'Verizon', days: 30 }));
    const readOnly = await mcp.call('rent_proxy', { confirm: true, requestId: rent.requestId });
    assert.deepEqual(errorOf(readOnly), { code: 'read_only_api_key', message: 'This API key is read-only.', status: 403 });
    assert.match(text(readOnly), /read_only_api_key/);
    assert.match(readOnly.structuredContent!.summary, /Create a read-write key/);
    assert.equal(errorOf(await mcp.call('rotate_ip', { rentalId: RENTAL })).code, 'read_only_api_key');
    assert.equal(okOf(await mcp.call('get_balance')).key.access, 'read');

    fake.state.access = 'read_write';
    fake.state.balanceMinor = 600;
    const short = okOf(await mcp.call('rent_proxy', { country: 'US', carrier: 'Verizon', days: 1 }));
    const insufficient = await mcp.call('rent_proxy', { confirm: true, requestId: short.requestId });
    const error = errorOf(insufficient);
    assert.equal(error.code, 'insufficient_balance');
    assert.equal(error.missingMinor, 300);
    assert.equal(error.requiredMinor, 900);
    assert.equal(error.availableMinor, 600);
    assert.match(insufficient.structuredContent!.summary, /Your balance is \$3\.00 short of the \$9\.00 required\. Add funds in the dashboard, or pay your own USDC on Base through the top-up at https:\/\/ipvolt\.com\/api\/v1 \(see https:\/\/ipvolt\.com\/docs\/api\), then try again\./);
    assert.equal(fake.state.balanceMinor, 600);

    const extend = okOf(await mcp.call('extend_rental', { rentalId: RENTAL, days: 30 }));
    assert.equal(errorOf(await mcp.call('extend_rental', { rentalId: RENTAL, days: 30, confirm: true, requestId: extend.requestId })).missingMinor, 9400);

    const rotated = okOf(await mcp.call('rotate_ip', { rentalId: RENTAL }));
    assert.equal(rotated.ip, '198.51.100.4');
    assert.match(rotated.summary, /new IP is 198\.51\.100\.4\. Rotation is free\./);
    const rotation = posts(fake).at(-1)!;
    assert.equal(rotation.headers['idempotency-key'], undefined);
    assert.equal(rotation.body, '{}');
    fake.state.cooldown = true;
    const cooldown = await mcp.call('rotate_ip', { rentalId: RENTAL });
    assert.equal(errorOf(cooldown).code, 'rotation_cooldown');
    assert.equal(errorOf(cooldown).retryAfterSeconds, 42);
    assert.equal(errorOf(cooldown).status, 429);
    assert.match(cooldown.structuredContent!.summary, /Try again in 42 seconds\./);

    const missing = await mcp.call('get_rental', { rentalId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.equal(errorOf(missing).code, 'rental_not_found');
    await mcp.finish();
  } finally { await mcp.close(); await fake.close(); }

  const wrongKey = await fakeApi();
  const other = await stdio({ IPVOLT_API_KEY: newKey(), IPVOLT_API_BASE: wrongKey.base });
  try {
    const result = await other.client.callTool({ name: 'get_balance', arguments: {} }) as Result;
    assert.equal(errorOf(result).code, 'invalid_api_key');
    assert.match(result.structuredContent!.summary, /Check IPVOLT_API_KEY/);
  } finally { await other.close(); await wrongKey.close(); }
});

test('connection details appear only in rental results, never in errors or stderr; the key never appears', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  const mcp = await session(fake);
  try {
    const listed = await mcp.call('list_rentals');
    const rentals = okOf(listed).rentals;
    assert.equal(rentals.length, 1);
    assert.deepEqual(rentals[0].connection.http, { host: 'proxy.example.net', port: 10000, username: fake.state.user, password: fake.state.password });
    assert.match(text(listed), new RegExp(`HTTP proxy: host proxy\\.example\\.net, port 10000, username ${fake.state.user}, password ${fake.state.password}`));
    assert.match(text(listed), /SOCKS5 proxy: host proxy\.example\.net, port 10001/);
    const single = await mcp.call('get_rental', { rentalId: RENTAL });
    assert.equal(okOf(single).rental.connection.socks5.password, fake.state.password);
    assert.match(text(single), /Connection details are secrets/);

    // Error answers never carry connection details or arbitrary bodies into the result.
    fake.state.override = request => request.path === '/rentals'
      ? { status: 500, raw: `<html>upstream failed for ${fake.state.user}:${fake.state.password}</html>`, headers: { 'Content-Type': 'text/html' } }
      : undefined;
    const failed = await mcp.call('list_rentals');
    assert.equal(errorOf(failed).code, 'http_error');
    assert.equal(JSON.stringify(failed).includes(fake.state.password), false);
    assert.equal(JSON.stringify(failed).includes(fake.state.user), false);

    // An API answer that echoes the key is withheld entirely.
    fake.state.override = request => request.path === '/balance'
      ? { status: 400, body: { error: 'invalid_request', message: `Bad credential ${fake.state.key}` } }
      : undefined;
    assert.equal(errorOf(await mcp.call('get_balance')).code, 'unsafe_response');
    fake.state.override = request => request.path === `/rentals/${RENTAL}`
      ? { status: 200, body: { id: RENTAL, status: 'active', connection: { http: { host: 'h.example.net', port: 1, username: 'u', password: fake.state.key } } } }
      : undefined;
    assert.equal(errorOf(await mcp.call('get_rental', { rentalId: RENTAL })).code, 'unsafe_response');
    // A malformed success answer is reported without its body.
    fake.state.override = request => request.path === `/rentals/${RENTAL}`
      ? { status: 200, body: { id: RENTAL, connection: fake.state.password } }
      : undefined;
    const malformed = await mcp.call('get_rental', { rentalId: RENTAL });
    assert.equal(errorOf(malformed).code, 'unexpected_response');
    assert.equal(JSON.stringify(malformed).includes(fake.state.password), false);
    // Rejected arguments are not echoed either.
    const rejected = await mcp.call('get_rental', { rentalId: `../${fake.state.password}` });
    assert.equal(rejected.isError, true);
    assert.equal(JSON.stringify(rejected).includes(fake.state.password), false);
    assert.equal(fake.requests.some(request => request.path.includes('..')), false);
    await mcp.finish();
  } finally { await mcp.close(); await fake.close(); }
});

test('fields the API answers as null are left out, not treated as a malformed answer', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  const mcp = await session(fake);
  try {
    // A device without an order, place or end time, as the API describes it.
    const bare = { id: RENTAL, orderId: null, status: 'active', country: null, countryName: null, carrier: null, endsAt: null, online: false, externalIp: null, canRotate: false, canExtend: true, connection: {} };
    fake.state.override = request => request.method !== 'GET' ? undefined
      : request.path === '/rentals' ? { status: 200, body: { rentals: [bare] } }
      : request.path === `/rentals/${RENTAL}` ? { status: 200, body: bare }
      : request.path === `/rentals/${RENTAL}/extension-price?days=30` ? { status: 200, body: { rentalId: RENTAL, days: 30, priceMinor: 10000, price: '100.00', currency: 'USD', endsAt: null } }
      // The stock feed has not been read: no offers, no observation time, purchases closed.
      : request.path === '/stock' ? { status: 200, body: { currency: 'USD', observedAt: null, purchasesOpen: false, offers: [] } }
      : undefined;
    const listed = await mcp.call('list_rentals');
    assert.deepEqual(okOf(listed).rentals, [{ id: RENTAL, status: 'active', online: false, externalIp: null, canRotate: false, canExtend: true }]);
    assert.match(text(listed), new RegExp(`Rental ${RENTAL}, active, offline, cannot rotate, can extend\\.`));
    assert.deepEqual(okOf(await mcp.call('get_rental', { rentalId: RENTAL })).rental, okOf(listed).rentals[0]);
    const preview = okOf(await mcp.call('extend_rental', { rentalId: RENTAL, days: 30 }));
    assert.equal(preview.priceMinor, 10000);
    assert.equal(preview.endsAt, undefined);
    const stock = await mcp.call('list_stock');
    assert.deepEqual({ offers: okOf(stock).offers, purchasesOpen: okOf(stock).purchasesOpen, observedAt: okOf(stock).observedAt }, { offers: [], purchasesOpen: false, observedAt: undefined });
    assert.match(text(stock), /No in-stock offers right now\. Purchases are closed right now\./);
    assert.equal(errorOf(await mcp.call('rent_proxy', { country: 'US', carrier: 'Verizon', days: 30 })).code, 'offer_not_found');
    await mcp.finish();
  } finally { await mcp.close(); await fake.close(); }
});

test('an interrupted rent confirm reports an unknown outcome and a repeat reuses the same Idempotency-Key', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  const mcp = await session(fake);
  try {
    const preview = okOf(await mcp.call('rent_proxy', { country: 'US', carrier: 'Verizon', days: 30 }));
    fake.state.dropNext.push('POST /rentals');
    const lost = await mcp.call('rent_proxy', { confirm: true, requestId: preview.requestId });
    assert.equal(errorOf(lost).code, 'network_error');
    assert.equal(errorOf(lost).outcomeUnknown, true);
    assert.match(lost.structuredContent!.summary, /The outcome is unknown: the rental may have been placed\./);
    assert.ok(lost.structuredContent!.summary.includes(`confirm: true and requestId: ${preview.requestId}. The API returns the existing order and never charges twice.`));
    assert.equal(posts(fake).length, 1, 'POST is never retried automatically');
    const again = okOf(await mcp.call('rent_proxy', { confirm: true, requestId: preview.requestId }));
    assert.equal(posts(fake).length, 2);
    assert.equal(posts(fake)[1]!.headers['idempotency-key'], preview.requestId);
    assert.equal(posts(fake)[1]!.body, posts(fake)[0]!.body);
    assert.equal(again.order.chargedMinor, 10000);
    assert.equal(fake.state.balanceMinor, 15_000);
    await mcp.finish();
  } finally { await mcp.close(); await fake.close(); }
});

test('API client: GET retries once after a network error; timeouts, POST and redirects are never retried or followed', { timeout: 20_000 }, async () => {
  const fake = await fakeApi();
  try {
    const api = new AccountApi({ apiKey: fake.state.key, baseUrl: fake.base }, { getTimeoutMs: 300, postTimeoutMs: 300, retryDelayMs: 10 });
    fake.state.dropNext.push('GET /balance');
    const retried = await api.get('/balance');
    assert.equal(retried.ok, true);
    assert.equal(fake.requests.filter(request => request.path === '/balance').length, 2);

    fake.state.dropNext.push('GET /key', 'GET /key');
    const lost = await api.get('/key');
    assert.equal(lost.ok, false);
    assert.equal(!lost.ok && lost.error.code, 'network_error');
    assert.equal(!lost.ok && lost.error.outcomeUnknown, undefined);
    assert.equal(fake.requests.filter(request => request.path === '/key').length, 2);

    fake.state.dropNext.push('POST /rentals');
    const post = await api.post('/rentals', { idempotencyKey: randomUUID(), body: { country: 'US', carrier: 'Verizon', days: 30, maxPriceMinor: 10000 } });
    assert.equal(!post.ok && post.error.code, 'network_error');
    assert.equal(!post.ok && post.error.outcomeUnknown, true);
    assert.equal(posts(fake).length, 1);

    fake.state.override = request => request.path === '/rentals' ? { status: 200, body: { rentals: [] }, delayMs: 1000 } : undefined;
    const slow = await api.get('/rentals');
    assert.equal(!slow.ok && slow.error.code, 'timeout');
    assert.equal(fake.requests.filter(request => request.path === '/rentals' && request.method === 'GET').length, 1);

    fake.state.override = request => request.path === '/balance' ? { status: 302, headers: { Location: 'https://elsewhere.example.net/steal' } } : undefined;
    const redirected = await api.get('/balance');
    assert.equal(!redirected.ok && redirected.error.code, 'unexpected_redirect');
    assert.equal(fake.requests.at(-1)!.path, '/balance');

    fake.state.override = request => request.path === '/rentals' && request.method === 'POST' ? { status: 502, raw: 'Bad gateway', headers: { 'Content-Type': 'text/plain' } } : undefined;
    const gateway = await api.post('/rentals', { idempotencyKey: randomUUID(), body: {} });
    assert.equal(!gateway.ok && gateway.error.outcomeUnknown, true);
    fake.state.override = request => request.path === '/rentals' && request.method === 'POST' ? { status: 503, body: { error: 'supplier_unavailable', message: 'Renting is not possible right now.' } } : undefined;
    const unavailable = await api.post('/rentals', { idempotencyKey: randomUUID(), body: {} });
    assert.equal(!unavailable.ok && unavailable.error.outcomeUnknown, undefined);
  } finally { await fake.close(); }
});

test('previews expire unless confirmed; confirmed requestIds are kept and evicted last', () => {
  let now = 0;
  const store = new PreviewStore(1000, 3, () => now);
  const draft = { kind: 'extend' as const, rentalId: RENTAL, days: 30 as const, priceMinor: 10000, currency: 'USD' };
  const confirmed = store.add(draft);
  const pending = store.add(draft);
  const entry = store.get(confirmed);
  assert.ok(entry && entry !== 'expired');
  entry.sent = true;
  now = 1001;
  assert.equal(store.get(pending), 'expired');
  assert.equal(store.get(pending), undefined);
  assert.equal(store.get(confirmed), entry, 'A sent confirm keeps its requestId after the preview lifetime');
  const second = store.add(draft), third = store.add(draft);
  store.add(draft);
  assert.equal(store.get(confirmed), entry, 'Unconfirmed previews are evicted before confirmed ones');
  assert.equal([second, third].filter(id => store.get(id) === undefined).length, 1);
});
