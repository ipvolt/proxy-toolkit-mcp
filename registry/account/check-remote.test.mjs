import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_TOOLS, checkRemote, ENDPOINT, PURCHASE_TOOLS, SPENDING_TOOLS, TRAFFIC_TOOLS, verifyEnvironment } from './check-remote.mjs';

// The account server's source is not in this repository, so a small stand-in answers as the reviewed server does:
// JSON answers to POST, 202 to notifications, 405 to GET, tool errors (not HTTP errors) without a credential.
function standIn(change = {}) {
  const calls = [];
  const tools = (change.tools ?? [...BASE_TOOLS, ...TRAFFIC_TOOLS, ...PURCHASE_TOOLS]).map(name => ({
    name, description: name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: change.looseSchema === name ? true : false },
    annotations: { readOnlyHint: change.readOnly === name ? true : !SPENDING_TOOLS.includes(name) && name !== 'rotate_ip' && name !== 'get_purchase' },
  }));
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const refusal = code => ({ ...result({ ok: false, summary: 'refused', error: { code } }), isError: true });
  const call = (name) => {
    if (name === 'list_stock') return change.stock ?? result({ ok: true, offers: [{ country: 'US', days: 1 }], purchasesOpen: true });
    if (name === 'how_to_buy') return result({ ok: true, steps: [] });
    if (name === 'get_balance') return change.balance ?? refusal('credential_required');
    if (name === 'rent_proxy') return change.rent ?? refusal('credential_required');
    return refusal('unknown_tool');
  };
  const answer = message => {
    if (message.method === 'initialize') {
      return { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: false } },
               serverInfo: { name: change.serverName ?? 'ipvolt-account', version: change.serverVersion ?? '1.1.0' } };
    }
    if (message.method === 'tools/list') return { tools };
    if (message.method === 'tools/call') return call(message.params.name);
    return {};
  };
  return {
    calls,
    fetchImplementation: async (url, init) => {
      assert.equal(String(url), ENDPOINT);
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.ok(init.signal instanceof AbortSignal);
      const headers = new Headers(init.headers);
      assert.equal(headers.has('authorization'), false, 'the check never sends a credential');
      assert.match(headers.get('user-agent'), /^ipvolt-registry-check\/1 \(\+https:\/\/github\.com\/ipvolt\/proxy-toolkit-mcp; /);
      calls.push(init.method ?? 'GET');
      const extra = change.cookie ? { 'set-cookie': 'session=1' } : {};
      if ((init.method ?? 'GET') !== 'POST') return new Response(null, { status: 405, headers: extra });
      const message = JSON.parse(String(init.body));
      if (message.id === undefined) return new Response(null, { status: 202, headers: extra });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message) }),
                          { status: 200, headers: { 'content-type': 'application/json', ...extra } });
    },
  };
}
const refused = /^Error: Public remote verification failed$/;

test('the official client verifies the server, its tools and the four calls, without a credential', async () => {
  const server = standIn();
  const report = await checkRemote({ fetchImplementation: server.fetchImplementation });
  assert.deepEqual(report, { ok: true, endpoint: ENDPOINT, protocol: '2025-11-25', serverName: 'ipvolt-account', serverVersion: '1.1.0',
                             tools: [...BASE_TOOLS, ...TRAFFIC_TOOLS, ...PURCHASE_TOOLS].sort(), toolCalls: 4 });
  assert.ok(server.calls.length >= 6 && server.calls.length <= 20);
});

test('the three traffic tools may be absent; the report lists what the server lists', async () => {
  const report = await checkRemote({ fetchImplementation: standIn({ tools: BASE_TOOLS }).fetchImplementation });
  assert.deepEqual(report.tools, [...BASE_TOOLS].sort());
});

test('the two purchase tools may be absent too, but never one without the other', async () => {
  const without = await checkRemote({ fetchImplementation: standIn({ tools: [...BASE_TOOLS, ...TRAFFIC_TOOLS] }).fetchImplementation });
  assert.deepEqual(without.tools, [...BASE_TOOLS, ...TRAFFIC_TOOLS].sort());
  const only = await checkRemote({ fetchImplementation: standIn({ tools: [...BASE_TOOLS, ...PURCHASE_TOOLS] }).fetchImplementation });
  assert.deepEqual(only.tools, [...BASE_TOOLS, ...PURCHASE_TOOLS].sort());
  for (const name of PURCHASE_TOOLS) {
    await assert.rejects(checkRemote({ fetchImplementation: standIn({ tools: [...BASE_TOOLS, name] }).fetchImplementation }), refused, name);
  }
});

test('another server, version shape or tool catalog blocks publication', async () => {
  for (const change of [
    { serverName: 'ipvolt-proxy-toolkit' },
    { serverVersion: 'latest' },
    { tools: BASE_TOOLS.filter(name => name !== 'rent_proxy') },
    { tools: [...BASE_TOOLS, 'delete_account'] },
    { tools: [...BASE_TOOLS, 'list_stock'] },
    { looseSchema: 'rent_proxy' },
  ]) {
    await assert.rejects(checkRemote({ fetchImplementation: standIn(change).fetchImplementation }), refused, JSON.stringify(change));
  }
});

test('a spending tool announced as read-only blocks publication', async () => {
  for (const name of SPENDING_TOOLS) {
    await assert.rejects(checkRemote({ fetchImplementation: standIn({ readOnly: name }).fetchImplementation }), refused, name);
  }
});

test('an account that opens, or a charge that can be previewed, without a credential blocks publication', async () => {
  const data = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  for (const change of [
    { balance: data({ ok: true, balance: { availableMinor: '100' } }) },
    { balance: { ...data({ ok: false, error: { code: 'invalid_api_key' } }), isError: true } },
    { rent: data({ ok: true, requestId: 'r1.x.y' }) },
    { rent: { ...data({ ok: false, requestId: 'r1.x.y', error: { code: 'credential_required' } }), isError: true } },
    { stock: { ...data({ ok: false, error: { code: 'unavailable' } }), isError: true } },
    { stock: data({ ok: true, offers: 'none', purchasesOpen: true }) },
  ]) {
    await assert.rejects(checkRemote({ fetchImplementation: standIn(change).fetchImplementation }), refused, JSON.stringify(change));
  }
});

test('a server that sets a cookie is not the reviewed stateless server', async () => {
  await assert.rejects(checkRemote({ fetchImplementation: standIn({ cookie: true }).fetchImplementation }), refused);
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
  await assert.rejects(checkRemote({ timeoutMs: 25, fetchImplementation: async () => new Promise(() => {}) }), refused);
  assert.ok(Date.now() - started < 3000);
});

test('unsafe debug, proxy and TLS environment fails before any request', async () => {
  for (const environment of [{ DEBUG: 'pw:*' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { NODE_OPTIONS: '--trace-tls' }, { NODE_EXTRA_CA_CERTS: '/unreviewed-ca.pem' }, { NODE_USE_ENV_PROXY: '1' }]) {
    let calls = 0;
    await assert.rejects(checkRemote({ environment, fetchImplementation: async () => { calls++; return new Response('{}'); } }), refused);
    assert.equal(calls, 0);
  }
  assert.throws(() => verifyEnvironment({}, ['--tls-keylog=/tmp/keys']), refused);
  verifyEnvironment({ PATH: '/usr/bin' }, []);
});
