// Fixed public endpoint verification for the manually reviewed Registry release.
// No credentials, response bodies, addresses or arbitrary target inputs are logged.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ENDPOINT = 'https://mcp.ipvolt.com/mcp';
export const PROTOCOLS = ['2025-11-25', '2026-07-28'];
export const TOOLS = ['diagnose_proxy_error', 'generate_proxy_config', 'get_proxy_doc', 'search_proxy_docs'];
const BUNDLE = 'c6679b20124395b58cc00aea571589d466364dc41271134fb3d27e8803c5255b';
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

function structured(result) {
  require(result?.isError !== true && result?.structuredContent && typeof result.structuredContent === 'object');
  require(Array.isArray(result.content) && result.content.length === 1 && result.content[0].type === 'text');
  require(JSON.stringify(JSON.parse(result.content[0].text)) === JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

export async function checkRemote({ fetchImplementation = globalThis.fetch, environment = process.env, timeoutMs = 60_000 } = {}) {
  const clients = [];
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
      require(String(url) === ENDPOINT && ++requests <= 30);
      require(['GET', 'POST'].includes(init.method ?? 'GET'));
      const headers = new Headers(init.headers);
      for (const name of ['authorization', 'proxy-authorization', 'cookie']) require(!headers.has(name));
      const signals = [abort.signal, AbortSignal.timeout(10_000), ...(init.signal ? [init.signal] : [])];
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
            require(size <= 131_072);
            chunks.push(part.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      }
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
        status: response.status, headers: response.headers,
      });
    };
    await Promise.race([deadline, (async () => {
      for (const protocol of PROTOCOLS) {
        const client = new Client({ name: 'ipvolt-registry-public-check', version: '0.1.1' }, {
          supportedProtocolVersions: [protocol],
          versionNegotiation: { mode: protocol === '2026-07-28' ? { pin: protocol } : 'legacy' },
        });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), {
          fetch: boundedFetch,
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
        }));
        require(client.getServerVersion()?.name === 'ipvolt-proxy-toolkit');
        require(client.getServerVersion()?.version === '0.1.0');
        const list = await client.listTools();
        require(!list.nextCursor && JSON.stringify(list.tools.map(tool => tool.name).sort()) === JSON.stringify(TOOLS));
        require(client.getServerCapabilities()?.tools?.listChanged !== true);
        for (const tool of list.tools) {
          require(tool.inputSchema?.type === 'object' && tool.outputSchema?.type === 'object');
          require(tool.annotations?.readOnlyHint === true && tool.annotations?.openWorldHint === false);
        }
        const call = async (name, arguments_) => structured(await client.callTool({ name, arguments: arguments_ }));
        const search = await call('search_proxy_docs', { query: 'curl proxy', topic: 'setup' });
        require(search.provenance?.bundleSha256 === BUNDLE);
        require(search.results?.some(document => document.id === '/guides/curl-proxy-setup' && document.url === 'https://ipvolt.com/guides/curl-proxy-setup'));
        const document = await call('get_proxy_doc', { documentId: '/guides/curl-proxy-setup' });
        require(document.provenance?.bundleSha256 === BUNDLE && document.document?.id === '/guides/curl-proxy-setup');
        require(typeof document.markdown === 'string' && document.markdown.length > 100);
        const config = await call('generate_proxy_config', { client: 'httpx', version: '0.28.1' });
        require(config.client === 'httpx' && config.version === '0.28.1' && config.templateRevision === '2026-09-14.2');
        require(typeof config.code === 'string' && config.code.includes('PROXY_URL'));
        const diagnosis = await call('diagnose_proxy_error', { client: 'httpx', version: '0.28.1', phase: 'proxy_connect', status: 407 });
        require(diagnosis.evidence?.status === 407 && diagnosis.retry?.automaticRetryRecommended === false);
        require(diagnosis.candidates?.some(candidate => candidate.code === 'proxy_authentication_required'));
        await client.close();
      }
    })()]);
    return { ok: true, endpoint: ENDPOINT, protocols: PROTOCOLS, tools: TOOLS, toolCalls: 8, runtimeVersion: '0.1.0', bundleSha256: BUNDLE };
  } catch { throw failure(); }
  finally {
    clearTimeout(timer);
    abort.abort();
    await Promise.allSettled(clients.map(client => client.close()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    require(process.argv.length === 2);
    console.log(JSON.stringify(await checkRemote()));
  } catch { process.stderr.write('Public remote verification failed.\n'); process.exitCode = 1; }
}
