// Fixed public endpoint verification for the io.github.ipvolt/account Registry entry: the remote MCP server inside
// the ipvolt customer app. It sends no credential, so it reads only what anyone can read and confirms that the
// account tools refuse without one. No response bodies, addresses or arbitrary target inputs are logged.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ENDPOINT = 'https://ipvolt.com/beta/mcp';
export const PROTOCOL = '2025-11-25';
export const SERVER_NAME = 'ipvolt-account';
export const BASE_TOOLS = ['extend_rental', 'get_balance', 'get_rental', 'how_to_buy', 'list_rentals', 'list_stock', 'rent_proxy', 'rotate_ip'];
// Listed by the server only while per-GB traffic is on sale.
export const TRAFFIC_TOOLS = ['buy_traffic_pack', 'get_traffic_connection', 'list_traffic'];
export const SPENDING_TOOLS = ['buy_traffic_pack', 'extend_rental', 'rent_proxy'];
// A truthful client name: the site's edge refuses anonymous default clients.
const USER_AGENT = 'ipvolt-registry-check/1 (+https://github.com/ipvolt/proxy-toolkit-mcp; MCP Registry publication check)';
const failure = () => new Error('Public remote verification failed');
const require = condition => { if (!condition) throw failure(); };

export function verifyEnvironment(environment, arguments_ = process.execArgv) {
  for (const key of ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']) {
    require(!environment[key]);
  }
  require(environment.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
  require(environment.NODE_USE_ENV_PROXY !== '1');
  require(!arguments_.some(value => /(?:trace-tls|tls-keylog|use-env-proxy)/.test(value)));
}

const errorCode = result => {
  const error = result?.structuredContent?.error;
  return typeof error === 'string' ? error : error?.code;
};

export async function checkRemote({ fetchImplementation = globalThis.fetch, environment = process.env, timeoutMs = 60_000 } = {}) {
  let client;
  const abort = new AbortController();
  let timer;
  try {
    verifyEnvironment(environment);
    require(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000);
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(failure()); }, timeoutMs);
    });
    let requests = 0;
    const boundedFetch = async (url, init = {}) => {
      require(String(url) === ENDPOINT && ++requests <= 20);
      require(['GET', 'POST'].includes(init.method ?? 'GET'));
      const headers = new Headers(init.headers);
      for (const name of ['authorization', 'proxy-authorization', 'cookie']) require(!headers.has(name));
      headers.set('user-agent', USER_AGENT);
      const signals = [abort.signal, AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])];
      const response = await fetchImplementation(url, {
        ...init, headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.any(signals),
      });
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            require(size <= 262_144);
            chunks.push(part.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      }
      // The server sets no cookie; a session it tried to start here would be a change to review.
      require(!response.headers.has('set-cookie'));
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
        status: response.status, headers: response.headers,
      });
    };
    const report = await Promise.race([deadline, (async () => {
      client = new Client({ name: 'ipvolt-registry-account-check', version: '1.0.0' }, {
        supportedProtocolVersions: [PROTOCOL],
        versionNegotiation: { mode: 'legacy' },
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        fetch: boundedFetch,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
      }));
      const server = client.getServerVersion();
      require(server?.name === SERVER_NAME);
      require(typeof server.version === 'string' && /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(server.version));
      const list = await client.listTools();
      const names = list.tools.map(tool => tool.name).sort();
      require(new Set(names).size === names.length);
      require(BASE_TOOLS.every(name => names.includes(name)));
      require(names.every(name => BASE_TOOLS.includes(name) || TRAFFIC_TOOLS.includes(name)));
      for (const tool of list.tools) {
        require(tool.inputSchema?.type === 'object' && tool.inputSchema.additionalProperties === false);
        // A tool that spends must never be announced as read-only.
        if (SPENDING_TOOLS.includes(tool.name)) require(tool.annotations?.readOnlyHint !== true);
      }
      // What anyone can read.
      const stock = await client.callTool({ name: 'list_stock', arguments: {} });
      require(stock?.isError !== true && Array.isArray(stock.structuredContent?.offers));
      require(typeof stock.structuredContent.purchasesOpen === 'boolean');
      const how = await client.callTool({ name: 'how_to_buy', arguments: {} });
      require(how?.isError !== true && how.structuredContent && typeof how.structuredContent === 'object');
      // The account is closed without a credential, and nothing can be previewed for spending.
      const balance = await client.callTool({ name: 'get_balance', arguments: {} });
      require(balance?.isError === true && errorCode(balance) === 'credential_required');
      const rent = await client.callTool({ name: 'rent_proxy', arguments: { country: 'US', carrier: 'none', days: 1 } });
      require(rent?.isError === true && !JSON.stringify(rent).includes('requestId'));
      await client.close();
      return { ok: true, endpoint: ENDPOINT, protocol: PROTOCOL, serverName: server.name, serverVersion: server.version, tools: names, toolCalls: 4 };
    })()]);
    return report;
  } catch { throw failure(); }
  finally {
    clearTimeout(timer);
    abort.abort();
    await client?.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    require(process.argv.length === 2);
    console.log(JSON.stringify(await checkRemote()));
  } catch { process.stderr.write('Public remote verification failed.\n'); process.exitCode = 1; }
}
