import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  SANDBOX_PROXY_HOST, SANDBOX_ROTATION_COOLDOWN_SECONDS, SANDBOX_START_BALANCE_MINOR,
  SandboxApi, SandboxConfigurationError, readSandboxFlag,
} from '../src/account/sandbox.js';
import { PreviewStore, SANDBOX_NOTICE, registerAccountTools, type AccountTools } from '../src/account/tools.js';
import type { AccountBackend, ApiResult } from '../src/account/client.js';
import { createHttpService } from '../src/transports/http.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const guard = fileURLToPath(new URL('./sandbox-fixtures/no-network.mjs', import.meta.url));
const run = promisify(execFile);
const PUBLIC_TOOLS = ['diagnose_proxy_error', 'generate_proxy_config', 'get_proxy_doc', 'search_proxy_docs'];
const ACCOUNT_TOOLS = ['extend_rental', 'get_balance', 'get_rental', 'list_rentals', 'list_stock', 'rent_proxy', 'rotate_ip'];
// Key-shaped values are generated per run; none is a literal.
const newKey = () => 'ipvolt_' + randomBytes(32).toString('base64url');
const DOCUMENTATION_ADDRESS = /^(?:203\.0\.113|198\.51\.100|192\.0\.2)\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4])$/;
const DAY_MS = 86_400_000;

type Result = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text: string }[] };
const text = (result: Result) => result.content.map(part => part.text).join('\n');
const errorOf = (result: Result) => { assert.equal(result.isError, true, JSON.stringify(result)); return result.structuredContent!.error as Record<string, any>; };
const okOf = (result: Result) => { assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent!; };

/** The real stdio entry. With `guarded`, every attempt to use the network is refused and written to stderr. */
async function stdio(env: Record<string, string>, guarded = false) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', ...(guarded ? ['--import', guard] : []), 'src/transports/stdio.ts'], cwd: root, stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'sandbox-test', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => await client.callTool({ name, arguments: args }) as Result;
  return { client, call, stderr: () => stderr, close: () => client.close() };
}

/* ------------------------------------------------------------ configuration */

test('IPVOLT_SANDBOX: unset, empty and 0 are off, 1 is on, anything else or a key beside it is refused without echo', () => {
  for (const environment of [{}, { IPVOLT_SANDBOX: '' }, { IPVOLT_SANDBOX: '0' }, { IPVOLT_SANDBOX: '0', IPVOLT_API_KEY: newKey() }]) {
    assert.equal(readSandboxFlag(environment), false);
  }
  assert.equal(readSandboxFlag({ IPVOLT_SANDBOX: '1' }), true);
  assert.equal(readSandboxFlag({ IPVOLT_SANDBOX: '1', IPVOLT_API_KEY: '' }), true);
  assert.equal(readSandboxFlag({ IPVOLT_SANDBOX: '1', IPVOLT_API_KEY: '  ' }), true);
  // The API address is never read in sandbox mode, so it cannot matter.
  assert.equal(readSandboxFlag({ IPVOLT_SANDBOX: '1', IPVOLT_API_BASE: 'http://127.0.0.1:9' }), true);
  const sentinel = randomBytes(8).toString('hex');
  for (const value of ['true', 'yes', 'on', ' 1', '1 ', '2', `1${sentinel}`]) {
    assert.throws(() => readSandboxFlag({ IPVOLT_SANDBOX: value }), (error: unknown) => {
      assert.ok(error instanceof SandboxConfigurationError);
      assert.equal(error.message, 'IPVOLT_SANDBOX must be 0 or 1.');
      return true;
    });
  }
  const key = newKey();
  assert.throws(() => readSandboxFlag({ IPVOLT_SANDBOX: '1', IPVOLT_API_KEY: key }), (error: unknown) => {
    assert.ok(error instanceof SandboxConfigurationError);
    assert.match(error.message, /^IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_API_KEY\./);
    assert.equal(error.message.includes(key), false);
    return true;
  });
  // The route check is the one other tool that uses the network, so it never starts beside the sandbox.
  const proxy = `http://user:${sentinel}@127.0.0.1:1`;
  assert.throws(() => readSandboxFlag({ IPVOLT_SANDBOX: '1', IPVOLT_ENABLE_ROUTE_CHECK: '1', IPVOLT_PROXY_URL: proxy }), (error: unknown) => {
    assert.ok(error instanceof SandboxConfigurationError);
    assert.match(error.message, /^IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_ENABLE_ROUTE_CHECK=1\./);
    assert.equal(error.message.includes(sentinel), false);
    return true;
  });
  assert.equal(readSandboxFlag({ IPVOLT_SANDBOX: '1', IPVOLT_ENABLE_ROUTE_CHECK: '0', IPVOLT_PROXY_URL: proxy }), true);
  assert.equal(readSandboxFlag({ IPVOLT_SANDBOX: '0', IPVOLT_ENABLE_ROUTE_CHECK: '1', IPVOLT_PROXY_URL: proxy }), false);
});

test('stdio refuses the sandbox beside a key, beside the route check or with a wrong flag, naming the cause but no value', { timeout: 20_000 }, async () => {
  const key = newKey();
  const sentinel = randomBytes(8).toString('hex');
  for (const [env, expected] of [
    [{ IPVOLT_SANDBOX: '1', IPVOLT_API_KEY: key }, /^Unable to start ipvolt Proxy Toolkit\. IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_API_KEY\./],
    [{ IPVOLT_SANDBOX: `yes-${sentinel}` }, /^Unable to start ipvolt Proxy Toolkit\. IPVOLT_SANDBOX must be 0 or 1\.\n$/],
    // With or without a usable proxy address: the sandbox refusal comes before the route check is built.
    [{ IPVOLT_SANDBOX: '1', IPVOLT_ENABLE_ROUTE_CHECK: '1', IPVOLT_PROXY_URL: `http://user:${sentinel}@127.0.0.1:1` }, /^Unable to start ipvolt Proxy Toolkit\. IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_ENABLE_ROUTE_CHECK=1\./],
    [{ IPVOLT_SANDBOX: '1', IPVOLT_ENABLE_ROUTE_CHECK: '1' }, /^Unable to start ipvolt Proxy Toolkit\. IPVOLT_SANDBOX=1 cannot be combined with IPVOLT_ENABLE_ROUTE_CHECK=1\./],
    // Other failures keep the generic sentence, also in sandbox mode.
    [{ IPVOLT_SANDBOX: '1', IPVOLT_ENABLE_ROUTE_CHECK: sentinel }, /^Unable to start ipvolt Proxy Toolkit\. Check the documented local configuration and debug-environment restrictions\.\n$/],
  ] as const) {
    await assert.rejects(run(process.execPath, ['--import', 'tsx', 'src/transports/stdio.ts'], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, timeout: 10_000 }),
      (error: { code?: number; stderr?: string; stdout?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? '', expected);
        assert.equal(`${error.stderr}${error.stdout}`.includes(key), false);
        assert.equal(`${error.stderr}${error.stdout}`.includes(sentinel), false);
        return true;
      });
  }
  const help = await run(process.execPath, ['--import', 'tsx', 'src/transports/stdio.ts', '--help'], { cwd: root, env: { PATH: process.env.PATH ?? '' } });
  assert.match(help.stdout, /IPVOLT_SANDBOX=1/);
});

/* ---------------------------------------------------------------- discovery */

test('stdio lists the seven account tools in sandbox mode, each saying it is simulated; 0 keeps the four public tools', { timeout: 20_000 }, async () => {
  for (const env of [{ IPVOLT_SANDBOX: '0' }, { IPVOLT_SANDBOX: '' }]) {
    const connection = await stdio(env);
    try { assert.deepEqual((await connection.client.listTools()).tools.map(tool => tool.name).sort(), PUBLIC_TOOLS); } finally { await connection.close(); }
  }
  const connection = await stdio({ IPVOLT_SANDBOX: '1' }, true);
  try {
    const tools = Object.fromEntries((await connection.client.listTools()).tools.map(tool => [tool.name, tool]));
    assert.deepEqual(Object.keys(tools).sort(), [...ACCOUNT_TOOLS, ...PUBLIC_TOOLS].sort());
    for (const name of ACCOUNT_TOOLS) {
      const tool = tools[name]!;
      assert.match(tool.title!, / \(sandbox\)$/, name);
      assert.match(tool.description!, /^SANDBOX MODE \(IPVOLT_SANDBOX=1\): this tool acts on a simulated account inside this process\. It sends no request to ipvolt, charges nothing and rents no real proxy\./, name);
      // Nothing leaves the process and nothing real can be lost, and the hints say so.
      assert.equal(tool.annotations?.openWorldHint, false, name);
      assert.equal(tool.annotations?.destructiveHint, false, name);
      assert.deepEqual((tool.outputSchema?.properties as Record<string, unknown>).sandbox, { type: 'boolean', const: true }, name);
    }
    for (const name of ['list_stock', 'get_balance', 'list_rentals', 'get_rental']) assert.equal(tools[name]!.annotations?.readOnlyHint, true, name);
    for (const name of ['rent_proxy', 'extend_rental', 'rotate_ip']) assert.equal(tools[name]!.annotations?.readOnlyHint, false, name);
    // The description still carries what the tool does with a real key.
    assert.match(tools.rent_proxy!.description!, /With an API key instead of the sandbox, the tool does this: SPENDS MONEY from the prepaid ipvolt balance\./);
    // The public tools are untouched.
    for (const name of PUBLIC_TOOLS) assert.equal(/sandbox/i.test(`${tools[name]!.title} ${tools[name]!.description}`), false, name);
    assert.equal(connection.stderr(), '');
  } finally { await connection.close(); }
});

/* ---------------------------------------------------------------- the tools */

test('every account tool works in sandbox mode without a key or any network use, and every answer is marked simulated', { timeout: 30_000 }, async () => {
  const mcp = await stdio({ IPVOLT_SANDBOX: '1', IPVOLT_API_BASE: 'http://127.0.0.1:9' }, true);
  const seen: Result[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => { const result = await mcp.call(name, args); seen.push(result); return result; };
  try {
    const stock = await call('list_stock');
    assert.equal(okOf(stock).offers.length, 11);
    assert.equal(okOf(stock).observedAt, undefined, 'Sample offers were not observed anywhere');
    assert.match(text(stock), /These are sample offers and prices, not live stock\. Current prices: https:\/\/ipvolt\.com\/pricing$/);
    assert.match(text(stock), /- US United States, Verizon, 30 days: \$139\.00/);
    assert.equal(okOf(await call('list_stock', { includeSoldOut: true })).offers.length, 12);
    assert.match(text(await call('list_stock', { country: 'fr', includeSoldOut: true })), /SFR, 30 days: sold out/);

    const balance = await call('get_balance');
    assert.deepEqual(okOf(balance).balance, { currency: 'USD', availableMinor: SANDBOX_START_BALANCE_MINOR, heldMinor: 0 });
    assert.equal(okOf(balance).key.access, 'read_write');
    assert.equal(okOf(balance).key.dailyLimitMinor, null);
    assert.match(text(balance), /Available balance: \$500\.00\./);
    assert.match(text(balance), /The sandbox starts with a pretend balance of \$500\.00 and no rentals, and resets when the server restarts\.$/);
    assert.equal(okOf(await call('list_rentals')).rentals.length, 0);

    // Rent: the same two steps as with a key.
    const preview = okOf(await call('rent_proxy', { country: 'us', carrier: 'verizon', days: 30 }));
    assert.equal(preview.stage, 'preview');
    assert.equal(preview.totalMinor, 13_900);
    assert.equal(preview.summary, `Sandbox (simulated): Renting 1 × US Verizon for 30 days will charge $139.00 from your balance. Nothing has been charged yet. To proceed, call rent_proxy again with confirm: true and requestId: ${preview.requestId}`);
    assert.equal(okOf(await call('get_balance')).balance.availableMinor, SANDBOX_START_BALANCE_MINOR, 'A preview changes nothing');
    const rented = okOf(await call('rent_proxy', { confirm: true, requestId: preview.requestId }));
    assert.equal(rented.stage, 'confirmed');
    assert.deepEqual({ status: rented.order.status, replayed: rented.order.replayed, chargedMinor: rented.order.chargedMinor, currency: rented.order.currency }, { status: 'paid', replayed: false, chargedMinor: 13_900, currency: 'USD' });
    assert.deepEqual(rented.order.rentalIds, [], 'A new order names no rental yet, as with the API');
    const repeated = okOf(await call('rent_proxy', { confirm: true, requestId: preview.requestId }));
    assert.equal(repeated.order.replayed, true);
    assert.equal(repeated.order.orderId, rented.order.orderId);
    assert.equal(repeated.order.status, 'fulfilled');
    assert.equal(repeated.order.chargedMinor, 13_900);
    assert.equal(okOf(await call('get_balance')).balance.availableMinor, SANDBOX_START_BALANCE_MINOR - 13_900, 'A repeated confirm charges nothing');
    assert.equal(okOf(await call('get_balance')).key.spentTodayMinor, 13_900);

    // The rental: recognisable ids, a host that cannot resolve, documentation addresses.
    const listed = await call('list_rentals');
    const [rental] = okOf(listed).rentals;
    assert.equal(okOf(listed).rentals.length, 1);
    assert.match(rental.id, /^sandbox-[0-9a-f]{16}$/);
    assert.equal(rental.orderId, rented.order.orderId);
    assert.deepEqual(repeated.order.rentalIds, [rental.id], 'A repeated confirm names the rental the order made');
    assert.deepEqual({ status: rental.status, country: rental.country, carrier: rental.carrier, online: rental.online, canRotate: rental.canRotate, canExtend: rental.canExtend },
      { status: 'active', country: 'US', carrier: 'Verizon', online: true, canRotate: true, canExtend: true });
    assert.match(rental.externalIp, DOCUMENTATION_ADDRESS);
    assert.equal(rental.connection.http.host, SANDBOX_PROXY_HOST);
    assert.equal(rental.connection.socks5.host, SANDBOX_PROXY_HOST);
    assert.match(SANDBOX_PROXY_HOST, /\.invalid$/);
    assert.match(rental.connection.http.username, /^sandbox_[0-9a-f]{8}$/);
    assert.match(rental.connection.http.password, /^sandbox_[0-9a-f]{16}$/);
    assert.ok(Math.abs(Date.parse(rental.endsAt) - (Date.now() + 30 * DAY_MS)) < 60_000);
    assert.match(text(listed), /These connection details are simulated: the host name cannot resolve and there is no proxy behind it\.$/);
    assert.equal(/Connection details are secrets/.test(text(listed)), false);
    const single = await call('get_rental', { rentalId: rental.id });
    assert.deepEqual(okOf(single).rental, rental);
    assert.match(text(single), /These connection details are simulated/);

    // Rotate: a new address, then the cooldown the API also has.
    const rotated = okOf(await call('rotate_ip', { rentalId: rental.id }));
    assert.equal(rotated.rotated, true);
    assert.match(rotated.ip, DOCUMENTATION_ADDRESS);
    assert.notEqual(rotated.ip, rental.externalIp);
    assert.equal(okOf(await call('get_rental', { rentalId: rental.id })).rental.externalIp, rotated.ip);
    const cooldown = await call('rotate_ip', { rentalId: rental.id });
    assert.equal(errorOf(cooldown).code, 'rotation_cooldown');
    assert.equal(errorOf(cooldown).status, 429);
    assert.ok(errorOf(cooldown).retryAfterSeconds >= 1 && errorOf(cooldown).retryAfterSeconds <= SANDBOX_ROTATION_COOLDOWN_SECONDS);
    assert.match(cooldown.structuredContent!.summary, /^Sandbox \(simulated\): .*\(rotation_cooldown\)\. Try again in \d+ seconds?\.$/);

    // Extend: preview, confirm, a later end time.
    const extension = okOf(await call('extend_rental', { rentalId: rental.id, days: 30 }));
    assert.equal(extension.priceMinor, 13_900);
    assert.equal(extension.endsAt, rental.endsAt);
    const extended = okOf(await call('extend_rental', { rentalId: rental.id, days: 30, confirm: true, requestId: extension.requestId }));
    assert.equal(extended.order.chargedMinor, 13_900);
    assert.equal(extended.order.rentalId, rental.id);
    assert.equal(okOf(await call('extend_rental', { rentalId: rental.id, days: 30, confirm: true, requestId: extension.requestId })).order.replayed, true);
    assert.equal(Date.parse(okOf(await call('get_rental', { rentalId: rental.id })).rental.endsAt), Date.parse(rental.endsAt) + 30 * DAY_MS);
    assert.equal(okOf(await call('get_balance')).balance.availableMinor, SANDBOX_START_BALANCE_MINOR - 27_800);

    // Refusals: the pretend balance runs out, a sold-out offer, an unknown rental, a requestId from nowhere.
    const large = okOf(await call('rent_proxy', { country: 'US', carrier: 'Verizon', days: 30, quantity: 2 }));
    const short = await call('rent_proxy', { confirm: true, requestId: large.requestId });
    assert.deepEqual({ code: errorOf(short).code, requiredMinor: errorOf(short).requiredMinor, availableMinor: errorOf(short).availableMinor, missingMinor: errorOf(short).missingMinor },
      { code: 'insufficient_balance', requiredMinor: 27_800, availableMinor: 22_200, missingMinor: 5600 });
    assert.match(short.structuredContent!.summary, /Your balance is \$56\.00 short of the \$278\.00 required\. The sandbox balance cannot be topped up; restart the server to reset it\./);
    assert.equal(/Add funds in the dashboard/.test(JSON.stringify(short)), false);
    assert.equal(errorOf(await call('rent_proxy', { country: 'FR', carrier: 'SFR', days: 30 })).code, 'stock_unavailable');
    assert.equal(errorOf(await call('rent_proxy', { country: 'JP', carrier: 'Docomo', days: 30 })).code, 'offer_not_found');
    assert.equal(errorOf(await call('get_rental', { rentalId: 'sandbox-0000000000000000' })).code, 'rental_not_found');
    assert.equal(errorOf(await call('rotate_ip', { rentalId: '6703f0a1b2c3d4e5f6a7b8c9' })).code, 'rental_not_found');
    assert.equal(errorOf(await call('rent_proxy', { confirm: true, requestId: randomUUID() })).code, 'unknown_request');
    const several = okOf(await call('rent_proxy', { country: 'DE', carrier: 'O2', days: 1, quantity: 3 }));
    assert.equal(okOf(await call('rent_proxy', { confirm: true, requestId: several.requestId })).order.chargedMinor, 2700);
    const all = okOf(await call('list_rentals')).rentals;
    assert.equal(all.length, 4);
    assert.equal(new Set(all.map((entry: { connection: { http: { password: string } } }) => entry.connection.http.password)).size, 4, 'Each rental gets its own made-up credentials');

    // A call that fails the tool's input schema never reaches the tool: it gets the fixed protocol answer, with nothing simulated in it.
    for (const [name, args] of [['rent_proxy', { country: 'US', carrier: 'Verizon', days: 7 }], ['get_rental', { rentalId: 'a b' }], ['get_balance', { extra: 1 }]] as const) {
      const rejected = await mcp.call(name, args);
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent, undefined);
      assert.equal(text(rejected), 'Invalid tool request. Use tools/list to check the supported tool name, fields and versions.');
    }

    // Every answer an account tool produces, success or refusal, says it is simulated, in the text and in the structured result.
    assert.ok(seen.length > 25);
    assert.ok(seen.some(result => result.isError === true) && seen.some(result => result.isError !== true));
    for (const result of seen) {
      assert.equal(result.structuredContent!.sandbox, true, JSON.stringify(result));
      assert.match(result.structuredContent!.summary, /^Sandbox \(simulated\): /);
      // The transport's safety filter sends a refusal's structured result as its text, so the mark travels there too.
      if (result.isError) assert.deepEqual(JSON.parse(text(result)), result.structuredContent);
      else assert.equal(text(result).split('\n')[0], SANDBOX_NOTICE);
    }
    // The preloaded guard writes every attempt to use the network to stderr: there was none.
    assert.equal(mcp.stderr(), '');
  } finally { await mcp.close(); }

  // A new process starts from the same clean account: nothing is stored anywhere.
  const fresh = await stdio({ IPVOLT_SANDBOX: '1' }, true);
  try {
    assert.equal(okOf(await fresh.call('get_balance')).balance.availableMinor, SANDBOX_START_BALANCE_MINOR);
    assert.equal(okOf(await fresh.call('list_rentals')).rentals.length, 0);
    assert.equal(fresh.stderr(), '');
  } finally { await fresh.close(); }
});

test('the network guard does catch the live path, and answers from a real API carry no sandbox mark', { timeout: 20_000 }, async () => {
  // Control for the test above: with a key instead of the sandbox, the same guard sees the request.
  const guarded = await stdio({ IPVOLT_API_KEY: newKey(), IPVOLT_API_BASE: 'http://127.0.0.1:9' }, true);
  try {
    assert.equal((await guarded.call('list_stock')).isError, true);
    assert.match(guarded.stderr(), /NETWORK ATTEMPT/);
  } finally { await guarded.close(); }

  const api = createServer((request, response) => {
    response.writeHead(request.url === '/stock' ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/stock'
      ? { currency: 'USD', purchasesOpen: true, offers: [{ country: 'US', countryName: 'United States', carrier: 'Verizon', days: 30, priceMinor: 10_000, available: true }] }
      : { error: 'not_found', message: 'Not found.' }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const live = await stdio({ IPVOLT_API_KEY: newKey(), IPVOLT_API_BASE: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
  try {
    const tools = Object.fromEntries((await live.client.listTools()).tools.map(tool => [tool.name, tool]));
    assert.equal(/sandbox/i.test(`${tools.rent_proxy!.title} ${tools.rent_proxy!.description}`), false);
    assert.equal(tools.rent_proxy!.annotations?.destructiveHint, true);
    const stock = await live.call('list_stock');
    assert.equal(okOf(stock).sandbox, undefined);
    assert.equal(/sandbox/i.test(JSON.stringify(stock)), false);
    const missing = await live.call('get_balance');
    assert.equal(missing.isError, true);
    assert.equal(/sandbox/i.test(JSON.stringify(missing)), false);
  } finally { await live.close(); api.closeAllConnections(); await new Promise(done => api.close(done)); }
});

test('the hosted HTTP service keeps exactly its public tools when IPVOLT_SANDBOX=1 is set', { timeout: 20_000 }, async () => {
  const saved = process.env.IPVOLT_SANDBOX;
  process.env.IPVOLT_SANDBOX = '1';
  const service = createHttpService({ publicUrl: 'http://127.0.0.1/mcp' });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const client = new Client({ name: 'sandbox-http-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(service.server.address() as AddressInfo).port}/mcp`)));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), PUBLIC_TOOLS);
    for (const name of ACCOUNT_TOOLS) {
      let rejected = false;
      try { rejected = (await client.callTool({ name, arguments: {} })).isError === true; } catch { rejected = true; }
      assert.equal(rejected, true, name);
    }
  } finally {
    await client.close(); await service.close();
    if (saved === undefined) delete process.env.IPVOLT_SANDBOX; else process.env.IPVOLT_SANDBOX = saved;
  }
});

/* ------------------------------------------------------- the simulated API */

test('sandbox API: idempotency, price ceiling, cooldown and rental end follow the API contract', async () => {
  let now = Date.parse('2026-11-18T12:00:00.000Z');
  const api = new SandboxApi({ now: () => now });
  const data = async (result: Promise<ApiResult>) => { const answer = await result; assert.equal(answer.ok, true, JSON.stringify(answer)); return (answer as { data: Record<string, any> }).data; };
  const refusal = async (result: Promise<ApiResult>) => { const answer = await result; assert.equal(answer.ok, false, JSON.stringify(answer)); return (answer as { error: Record<string, any> }).error; };
  const refused = async (result: Promise<ApiResult>) => { const error = await refusal(result); return `${error.status} ${error.code}`; };
  const order = { country: 'gb', carrier: 'three', days: 1, maxPriceMinor: 1400 };
  const rent = (body: Record<string, unknown>, idempotencyKey: string = randomUUID()) => api.post('/rentals', { body, idempotencyKey });

  // Spending needs a well-formed Idempotency-Key and the documented body.
  assert.equal(await refused(api.post('/rentals', { body: order })), '400 idempotency_key_required');
  assert.equal(await refused(rent(order, 'short')), '400 invalid_idempotency_key');
  for (const wrong of [{ ...order, days: 7 }, { ...order, quantity: 21 }, { ...order, quantity: 0 }, { ...order, country: 'GBR' }, { ...order, carrier: '  ' }, { ...order, note: 'x' },
    { ...order, maxPriceMinor: 0 }, { ...order, maxPriceMinor: -5 }, { ...order, maxPriceMinor: '1400' }, { ...order, maxPriceMinor: 1_000_001 }, { ...order, maxPriceMinor: 14.5 }]) {
    assert.equal(await refused(rent(wrong)), '400 invalid_order', JSON.stringify(wrong));
  }
  // Only a missing ceiling is max_price_required.
  assert.equal(await refused(rent({ country: 'GB', carrier: 'Three', days: 1 })), '400 max_price_required');
  const ceiling = await refusal(rent({ ...order, maxPriceMinor: 1399 }));
  assert.deepEqual({ code: ceiling.code, status: ceiling.status, details: ceiling.details }, { code: 'price_above_max', status: 409, details: { priceMinor: 1400, maxPriceMinor: 1399 } });
  assert.equal(await refused(rent({ country: 'FR', carrier: 'SFR', days: 30, maxPriceMinor: 10_000 })), '409 stock_unavailable');
  assert.equal(await refused(rent({ country: 'JP', carrier: 'Docomo', days: 30, maxPriceMinor: 10_000 })), '409 stock_unavailable');
  assert.equal((await data(api.get('/balance'))).availableMinor, String(SANDBOX_START_BALANCE_MINOR), 'Refused requests charge nothing');
  assert.equal((await data(api.get('/balance'))).mode, 'sandbox');

  // One key, one order. A new order is paid and names no rental yet.
  const key = randomUUID();
  const placed = await data(rent(order, key));
  assert.deepEqual({ status: placed.status, replayed: placed.replayed, chargedMinor: placed.chargedMinor, currency: placed.currency, rentalIds: placed.rentalIds },
    { status: 'paid', replayed: false, chargedMinor: 1400, currency: 'USD', rentalIds: [] });
  const [rental] = (await data(api.get('/rentals'))).rentals;
  assert.equal((await data(api.get('/rentals'))).rentals.length, 1);
  assert.equal(rental.endsAt, '2026-11-19T12:00:00.000Z');
  // A repeat asks for the same thing when country, carrier (any case), length and quantity match: field order, an explicit
  // default quantity and another price ceiling do not make it a different request. It reads the finished order and its rental.
  for (const same of [order, { maxPriceMinor: 1400, days: 1, carrier: ' THREE ', country: 'GB' }, { ...order, quantity: 1 }, { ...order, maxPriceMinor: 5 }, { country: 'GB', carrier: 'Three', days: 1 }]) {
    assert.deepEqual(await data(rent(same, key)), { ...placed, status: 'fulfilled', replayed: true, rentalIds: [rental.id] }, JSON.stringify(same));
  }
  // Anything else under a used key is a conflict, before the body is checked.
  for (const other of [{ ...order, quantity: 2 }, { ...order, days: 30 }, { ...order, country: 'DE' }, { ...order, carrier: 'O2' }, { ...order, days: 7 }, {}]) {
    assert.equal(await refused(rent(other, key)), '409 intent_conflict', JSON.stringify(other));
  }
  assert.equal((await data(api.get('/balance'))).availableMinor, String(SANDBOX_START_BALANCE_MINOR - 1400));
  assert.equal((await data(api.get('/rentals'))).rentals.length, 1, 'Replays and conflicts rent nothing');

  // The key report counts spending per UTC day.
  const keyInfo = await data(api.get('/key'));
  assert.deepEqual({ access: keyInfo.access, dailyLimitMinor: keyInfo.dailyLimitMinor, spentTodayMinor: keyInfo.spentTodayMinor, remainingTodayMinor: keyInfo.remainingTodayMinor, dayResetsAt: keyInfo.dayResetsAt },
    { access: 'read_write', dailyLimitMinor: null, spentTodayMinor: 1400, remainingTodayMinor: null, dayResetsAt: '2026-11-19T00:00:00.000Z' });

  // Rotation: a new documentation address, then the cooldown counted in whole seconds.
  const path = `/rentals/${encodeURIComponent(rental.id)}`;
  const first = await data(api.post(`${path}/rotate`));
  assert.deepEqual({ rotated: first.rotated, pending: first.pending }, { rotated: true, pending: false });
  assert.match(first.ip, DOCUMENTATION_ADDRESS);
  assert.notEqual(first.ip, rental.externalIp);
  now += 10_500;
  const wait = await refusal(api.post(`${path}/rotate`));
  assert.deepEqual({ code: wait.code, status: wait.status, details: wait.details }, { code: 'rotation_cooldown', status: 429, details: { retryAfterSeconds: SANDBOX_ROTATION_COOLDOWN_SECONDS - 10 } });
  now += (SANDBOX_ROTATION_COOLDOWN_SECONDS - 10) * 1000 - 500;
  assert.notEqual((await data(api.post(`${path}/rotate`))).ip, first.ip, 'The cooldown ends exactly when the seconds it named have passed');

  // Extension: quoted, then charged once per key, and the end moves by the days bought.
  const extend = (body: Record<string, unknown>, idempotencyKey: string = randomUUID(), target = path) => api.post(`${target}/extend`, { body, idempotencyKey });
  assert.equal(await refused(api.get(`${path}/extension-price?days=7`)), '400 invalid_request');
  assert.equal(await refused(api.get(`${path}/extension-price`)), '400 invalid_request');
  assert.deepEqual(await data(api.get(`${path}/extension-price?days=30`)), { rentalId: rental.id, days: 30, priceMinor: 10_000, currency: 'USD', endsAt: '2026-11-19T12:00:00.000Z' });
  assert.equal(await refused(api.post(`${path}/extend`, { body: { days: 30, maxPriceMinor: 10_000 } })), '400 idempotency_key_required');
  for (const wrong of [{ days: 2, maxPriceMinor: 10_000 }, { days: 30, maxPriceMinor: 0 }, { days: 30, maxPriceMinor: '10000' }, { days: 30, maxPriceMinor: 10_000, quantity: 1 }]) {
    assert.equal(await refused(extend(wrong)), '400 invalid_renewal', JSON.stringify(wrong));
  }
  assert.equal(await refused(extend({ days: 30 })), '400 max_price_required');
  assert.equal(await refused(extend({ days: 30, maxPriceMinor: 9999 })), '409 price_above_max');
  const extendKey = randomUUID();
  const extended = await data(extend({ days: 30, maxPriceMinor: 10_000 }, extendKey));
  assert.deepEqual({ status: extended.status, chargedMinor: extended.chargedMinor, rentalId: extended.rentalId, days: extended.days, replayed: extended.replayed },
    { status: 'paid', chargedMinor: 10_000, rentalId: rental.id, days: 30, replayed: false });
  assert.deepEqual(await data(extend({ days: 30, maxPriceMinor: 20_000 }, extendKey)), { ...extended, status: 'fulfilled', replayed: true });
  assert.equal((await data(api.get(path))).endsAt, '2026-12-19T12:00:00.000Z');
  assert.equal((await data(api.get('/balance'))).availableMinor, String(SANDBOX_START_BALANCE_MINOR - 11_400));
  // A key keeps to its operation, its rental and its length.
  assert.equal(await refused(extend({ days: 30, maxPriceMinor: 10_000 }, key)), '409 intent_conflict');
  assert.equal(await refused(extend({ days: 1, maxPriceMinor: 10_000 }, extendKey)), '409 intent_conflict');
  assert.equal(await refused(extend({ days: 30, maxPriceMinor: 10_000 }, extendKey, '/rentals/sandbox-ffffffffffffffff')), '409 intent_conflict');
  assert.equal(await refused(rent(order, extendKey)), '409 intent_conflict');
  // The body is checked before the key's order is looked up.
  assert.equal(await refused(extend({ days: 2, maxPriceMinor: 10_000 }, extendKey)), '400 invalid_renewal');

  // The next UTC day starts a new spending count.
  now = Date.parse('2026-11-19T00:00:01.000Z');
  assert.equal((await data(api.get('/key'))).spentTodayMinor, 0);
  assert.equal((await data(rent({ country: 'DE', carrier: 'O2', days: 1, maxPriceMinor: 900 }))).chargedMinor, 900);
  assert.deepEqual({ spent: (await data(api.get('/key'))).spentTodayMinor, resets: (await data(api.get('/key'))).dayResetsAt }, { spent: 900, resets: '2026-11-20T00:00:00.000Z' });

  // An ended rental leaves the list and answers rental_ended; a repeat of its order is still answered from the order.
  now = Date.parse('2026-12-19T12:00:00.000Z');
  assert.equal((await data(api.get('/rentals'))).rentals.length, 0);
  for (const attempt of [api.get(path), api.post(`${path}/rotate`), api.get(`${path}/extension-price?days=1`), extend({ days: 1, maxPriceMinor: 1400 })]) {
    assert.equal(await refused(attempt), '409 rental_ended');
  }
  assert.equal((await data(extend({ days: 30, maxPriceMinor: 10_000 }, extendKey))).replayed, true);
  assert.equal((await data(rent(order, key))).replayed, true);
  assert.equal(await refused(api.get('/rentals/sandbox-ffffffffffffffff')), '404 rental_not_found');
  assert.equal(await refused(api.post('/rentals/sandbox-ffffffffffffffff/rotate')), '404 rental_not_found');
  assert.equal(await refused(extend({ days: 1, maxPriceMinor: 1400 }, randomUUID(), '/rentals/sandbox-ffffffffffffffff')), '404 rental_not_found');

  // A known address with the wrong method is 405; an unknown address is 404; a malformed one is 400.
  for (const attempt of [api.post('/stock'), api.post('/key'), api.post('/balance'), api.post(path), api.post(`${path}/extension-price`), api.get(`${path}/rotate`), api.get(`${path}/extend`)]) {
    assert.equal(await refused(attempt), '405 method_not_allowed');
  }
  for (const attempt of [api.get('/orders'), api.get('/'), api.post('/rentals/x/y/z'), api.get('/rentals/a/b'), api.get('/stock/extra'), api.post('/fund')]) assert.equal(await refused(attempt), '404 not_found');
  assert.equal(await refused(api.get('/rentals/%E0%A4%A')), '400 invalid_request');
  const cancelled = await refusal(api.post('/rentals', { body: order, idempotencyKey: randomUUID(), signal: AbortSignal.abort() }));
  assert.equal(cancelled.code, 'cancelled');
  assert.equal(cancelled.outcomeUnknown, undefined, 'Nothing ran, so the outcome is known');
});

test('sandbox API: the pretend balance is the only limit and it never goes below zero', async () => {
  const api = new SandboxApi({ balanceMinor: 2000 });
  const rent = (quantity: number) => api.post('/rentals', { body: { country: 'DE', carrier: 'O2', days: 1, quantity, maxPriceMinor: 900 }, idempotencyKey: randomUUID() });
  const refused = await rent(3);
  assert.equal(!refused.ok && refused.error.code, 'insufficient_balance');
  assert.deepEqual(!refused.ok && refused.error.details, { requiredMinor: 2700, availableMinor: 2000, missingMinor: 700 });
  assert.equal((await rent(2)).ok, true);
  const balance = await api.get('/balance');
  assert.equal(balance.ok && balance.data.availableMinor, '200');
  const again = await rent(1);
  assert.equal(!again.ok && again.error.code, 'insufficient_balance');
  const rentals = await api.get('/rentals');
  assert.equal(rentals.ok && (rentals.data.rentals as unknown[]).length, 2);
});

test('sandbox mode marks the tool wrapper\'s own fallback answers too', async () => {
  // The tools are registered on a stand-in server so each handler can be called with a backend that misbehaves.
  const handlers = (api: AccountBackend, sandbox: boolean) => {
    const registered = new Map<string, (input: Record<string, unknown>, context: unknown) => Promise<Result>>();
    const tools: AccountTools = { api, previews: new PreviewStore(), ...(sandbox ? { sandbox: true } : {}) };
    registerAccountTools({ registerTool: (name: string, _definition: unknown, handler: never) => { registered.set(name, handler); } } as never, tools);
    return (name: string, input: Record<string, unknown> = {}) => registered.get(name)!(input, { mcpReq: { signal: new AbortController().signal } });
  };
  const marker = randomBytes(12).toString('hex');
  const filler = 'x'.repeat(500);
  const rentals = (password: string): ApiResult => ({ ok: true, status: 200, data: { rentals: Array.from({ length: 100 }, (_, index) => ({
    id: `r${index}`, status: 'active', connection: { http: { host: 'proxy.sandbox.invalid', port: 10_000, username: filler, password }, socks5: { host: 'proxy.sandbox.invalid', port: 10_001, username: filler, password } },
  })) } });
  const cases: [string, AccountBackend][] = [
    ['internal_error', { get: async () => { throw new Error('broken'); }, post: async () => { throw new Error('broken'); }, exposes: () => false }],
    ['response_too_large', { get: async () => rentals(filler), post: async () => rentals(filler), exposes: () => false }],
    ['unsafe_response', { get: async () => rentals(marker), post: async () => rentals(marker), exposes: text => text.includes(marker) }],
  ];
  for (const [code, backend] of cases) {
    const simulated = await handlers(backend, true)('list_rentals');
    assert.equal(simulated.isError, true, code);
    assert.equal(simulated.structuredContent!.error.code, code);
    assert.equal(simulated.structuredContent!.sandbox, true, code);
    assert.match(simulated.structuredContent!.summary, /^Sandbox \(simulated\): /, code);
    assert.equal(text(simulated).split('\n')[0], SANDBOX_NOTICE, code);
    assert.equal(JSON.stringify(simulated).includes(marker), false, code);
    // The same failure with a key carries no mark.
    const live = await handlers(backend, false)('list_rentals');
    assert.equal(live.structuredContent!.error.code, code);
    assert.equal(/sandbox/i.test(JSON.stringify(live)), false, code);
  }
});

test('the network guard refuses every way out of the process, not only fetch', { timeout: 20_000 }, async () => {
  // Each probe must be refused by the guard itself; one that gets through prints REACHED.
  const probe = `
    const attempts = {
      'fetch': () => fetch('http://127.0.0.1:9/'),
      'net.connect': async () => (await import('node:net')).connect(9, '127.0.0.1'),
      'tls.connect': async () => (await import('node:tls')).connect(9, '127.0.0.1'),
      'http.get': async () => (await import('node:http')).get('http://127.0.0.1:9/'),
      'https.get': async () => (await import('node:https')).get('https://127.0.0.1:9/'),
      'dns.lookup': async () => (await import('node:dns')).lookup('sandbox.invalid', () => {}),
      'dns.resolve4': async () => (await import('node:dns')).resolve4('sandbox.invalid', () => {}),
      'dns.reverse': async () => (await import('node:dns')).reverse('192.0.2.1', () => {}),
      'dns.promises.lookup': async () => (await import('node:dns/promises')).lookup('sandbox.invalid'),
      'dns.promises.resolve': async () => (await import('node:dns/promises')).resolve('sandbox.invalid'),
      'dns.promises.resolveTxt': async () => (await import('node:dns')).promises.resolveTxt('sandbox.invalid'),
      'dns.Resolver': async () => new (await import('node:dns')).Resolver().resolve4('sandbox.invalid', () => {}),
      'dns.promises.Resolver': async () => new (await import('node:dns/promises')).Resolver().resolve('sandbox.invalid'),
      'dgram.send': async () => (await import('node:dgram')).createSocket('udp4').send('x', 9, '127.0.0.1'),
      'dgram.bind': async () => (await import('node:dgram')).createSocket('udp4').bind(0),
      'child_process.spawn': async () => (await import('node:child_process')).spawn(process.execPath, ['--version']),
      'child_process.execFileSync': async () => (await import('node:child_process')).execFileSync(process.execPath, ['--version']),
      'child_process.fork': async () => (await import('node:child_process')).fork('nothing.mjs'),
      'worker_threads.Worker': async () => new (await import('node:worker_threads')).Worker('1', { eval: true }),
      'WebSocket': () => new WebSocket('ws://127.0.0.1:9/'),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      try { await attempt(); console.log('REACHED ' + name); }
      catch (error) { console.log((error.message === 'Network use is not allowed in this test' ? 'REFUSED ' : 'OTHER ') + name); }
    }
    process.exit(0);`;
  const { stdout, stderr } = await run(process.execPath, ['--import', guard, '--input-type=module', '-e', probe], { cwd: root, env: { PATH: process.env.PATH ?? '' }, timeout: 15_000 });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 20);
  assert.deepEqual(lines.filter(line => !line.startsWith('REFUSED ')), [], stdout);
  assert.equal(stderr.trim().split('\n').filter(line => line.startsWith('NETWORK ATTEMPT: ')).length, 20, stderr);
});

test('sandbox source: sample data holds no key-shaped value and only reserved names and addresses', () => {
  const source = readFileSync(new URL('../src/account/sandbox.ts', import.meta.url), 'utf8');
  assert.equal(/ipvolt_[A-Za-z0-9_-]{16,}/.test(source), false, 'No API-key-shaped literal');
  assert.equal(/\bfetch\s*\(|node:(?:net|tls|http|https|dns|dgram|child_process)|XMLHttpRequest|WebSocket/.test(source), false, 'The sandbox imports nothing that can reach the network');
  // Every dotted-quad prefix in the file belongs to a documentation block, and the only host is under .invalid.
  for (const [prefix] of source.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) assert.ok(['203.0.113', '198.51.100', '192.0.2'].includes(prefix), prefix);
  for (const [host] of source.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ee|invalid)\b/g)) assert.match(host, /\.invalid$/, host);
});
