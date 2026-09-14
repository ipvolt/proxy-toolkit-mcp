import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type Socket } from 'node:net';
import * as tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { debuglog } from 'node:util';
import { z } from 'zod';

export const routeInputSchema = z.object({
  profile: z.literal('default').default('default'),
}).strict();

export type RouteCheckInput = z.input<typeof routeInputSchema>;
export interface RouteOperatorConfig {
  enabled: boolean;
  /** Local operator secret; never accepted as an MCP tool argument. */
  proxyUrl?: string | undefined;
}
export interface RouteCheckOptions { signal?: AbortSignal | undefined }
export type RouteChecker = (input: unknown, options?: RouteCheckOptions) => Promise<RouteCheckResult>;

const SCOPE = 'This result describes one HTTPS request from this local process through the configured HTTP proxy. It does not verify other tools, geography, proxy type, or anonymity.';
const MAX_BODY_BYTES = 2_048;
const MAX_HEADER_BYTES = 8_192;

const failureMessages = {
  DISABLED: 'The local route check is not enabled by the operator.',
  INVALID_INPUT: 'Choose the default local profile. Proxy credentials and target URLs are not tool arguments.',
  BUSY: 'A route check is already running. Wait for it to finish before checking again.',
  UNSAFE_ENVIRONMENT: 'The local route check requires Node network debugging, TLS tracing/key logging, and disabled TLS verification to be off.',
  ABORTED: 'The route check was cancelled. No direct fallback was attempted.',
  TIMEOUT: 'The route check exceeded its total time limit. No direct fallback was attempted.',
  PROXY_CONNECT_FAILED: 'The configured HTTP proxy connection failed. Check its address, availability, and local network access.',
  PROXY_AUTH_REQUIRED: 'The proxy returned 407 during CONNECT. Check the configured authentication scheme, credentials, account access, and any source-address restrictions.',
  PROXY_CONNECT_REJECTED: 'The proxy did not establish the required HTTPS CONNECT tunnel.',
  TLS_FAILED: 'TLS verification or negotiation with the diagnostic endpoint failed. Certificate verification was not disabled.',
  ENDPOINT_FAILED: 'The diagnostic endpoint did not complete a successful response through the proxy.',
  REDIRECT_REFUSED: 'The diagnostic endpoint returned a redirect. It was not followed.',
  INVALID_RESPONSE: 'The diagnostic endpoint returned an invalid response or a mismatched request nonce.',
  RESPONSE_TOO_LARGE: 'The diagnostic response exceeded the 2 KiB body limit.',
} as const;

type FailureCode = keyof typeof failureMessages;
type Phase = 'validation' | 'proxy_connect' | 'tls_handshake' | 'echo_response';
/** Object-root schema for clients that do not accept a union at the root. */
export const routeOutputSchema = z.object({
  ok: z.boolean(),
  profile: z.literal('default'),
  endpoint: z.url(),
  scope: z.string(),
  observedIp: z.string().optional(),
  checkedAt: z.iso.datetime().optional(),
  timingsMs: z.object({
    proxyConnect: z.number().nonnegative(),
    tlsHandshake: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }).strict().optional(),
  code: z.enum(Object.keys(failureMessages) as [FailureCode, ...FailureCode[]]).optional(),
  message: z.string().optional(),
  phase: z.enum(['validation', 'proxy_connect', 'tls_handshake', 'echo_response']).optional(),
  elapsedMs: z.number().nonnegative().optional(),
}).strict().refine((result) => result.ok
  ? result.observedIp !== undefined && result.checkedAt !== undefined && result.timingsMs !== undefined && result.code === undefined && result.message === undefined && result.phase === undefined && result.elapsedMs === undefined
  : result.code !== undefined && result.message !== undefined && result.phase !== undefined && result.elapsedMs !== undefined && result.observedIp === undefined && result.checkedAt === undefined && result.timingsMs === undefined,
{ message: 'Route result must have exactly the success or failure fields.' });

interface ResultBase {
  profile: 'default';
  endpoint: string;
  scope: string;
}
export type RouteCheckResult =
  | ResultBase & {
    ok: true;
    observedIp: string;
    checkedAt: string;
    timingsMs: { proxyConnect: number; tlsHandshake: number; total: number };
  }
  | ResultBase & {
    ok: false;
    code: FailureCode;
    message: string;
    phase: Phase;
    elapsedMs: number;
  };

/** Sanitized startup failure: no input, cause, URL or parser exception attached. */
export class RouteConfigurationError extends Error {
  readonly code = 'INVALID_PROXY_CONFIGURATION';
  constructor() {
    super('IPVOLT_PROXY_URL must be a valid HTTP proxy URL with an optional percent-encoded username and password, no query or fragment, and no path other than /. HTTPS and SOCKS proxy schemes are not supported by the local route check.');
    this.name = 'RouteConfigurationError';
  }
}

/** Node's built-in debug output can expose headers before application redaction. */
export class RouteEnvironmentError extends Error {
  readonly code = 'UNSAFE_ROUTE_DEBUG_ENVIRONMENT';
  constructor() {
    super('The local route check requires NODE_DEBUG and NODE_DEBUG_NATIVE to be unset, NODE_TLS_REJECT_UNAUTHORIZED not to be 0, and TLS tracing/key logging options to be absent. Restart the process after changing these settings.');
    this.name = 'RouteEnvironmentError';
  }
}

function unsafeRouteEnvironment(): boolean {
  return Boolean(process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    /--(?:tls-keylog|trace-tls)/.test(process.env.NODE_OPTIONS ?? '') ||
    process.execArgv.some((argument) => /^--(?:tls-keylog|trace-tls)(?:=|$)/.test(argument)) ||
    // NODE_DEBUG is captured by Node at process startup. Clearing the variable
    // afterwards does not turn off already-enabled built-in debug categories.
    ['http', 'https', 'http2', 'net', 'tls'].some((category) => debuglog(category).enabled);
}

export function assertSafeRouteEnvironment(): void {
  if (unsafeRouteEnvironment()) throw new RouteEnvironmentError();
}

interface ProxyConfig { hostname: string; port: number; authorization?: string }

function readProxyConfig(value: string | undefined): ProxyConfig {
  try {
    if (!value || value.length > 4_096 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'http:' || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw new Error();
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (username.includes(':') || /[\u0000-\u001f\u007f]/u.test(username + password)) throw new Error();
    if (Buffer.byteLength(username + ':' + password) > 1_024) throw new Error();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error();
    return {
      hostname,
      port,
      ...(url.username || url.password
        ? { authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` }
        : {}),
    };
  } catch {
    throw new RouteConfigurationError();
  }
}

/**
 * Internal fixture seam. The public factory supplies constants; neither the CLI
 * nor operator configuration accepts an endpoint, CA or timeout override.
 */
export interface RouteRuntimeDependencies {
  endpoint: string;
  timeoutMs: number;
  ca?: string | Buffer | undefined;
}

export function createChecker(config: RouteOperatorConfig, dependencies: RouteRuntimeDependencies): RouteChecker {
  if (config.enabled) assertSafeRouteEnvironment();
  const proxy = config.enabled ? readProxyConfig(config.proxyUrl) : undefined;
  const endpoint = new URL(dependencies.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/egress') {
    throw new Error('Invalid internal route endpoint.');
  }
  if (!Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 10_000) {
    throw new Error('Invalid internal route timeout.');
  }
  const base: ResultBase = { profile: 'default', endpoint: endpoint.href, scope: SCOPE };
  let active = false;

  function failure(code: FailureCode, phase: Phase = 'validation', elapsedMs = 0): RouteCheckResult {
    return { ...base, ok: false, code, message: failureMessages[code], phase, elapsedMs };
  }

  return async (input, options = {}) => {
    if (!routeInputSchema.safeParse(input).success) return failure('INVALID_INPUT');
    if (!proxy) return failure('DISABLED');
    if (unsafeRouteEnvironment()) return failure('UNSAFE_ENVIRONMENT');
    if (options.signal?.aborted) return failure('ABORTED');
    if (active) return failure('BUSY');
    active = true;
    try {
      return await runProbe(proxy, endpoint, dependencies, base, options.signal);
    } finally {
      active = false;
    }
  };
}

const echoSchema = z.object({
  ip: z.string().max(45).refine((ip) => !ip.includes('%') && isIP(ip) !== 0),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

function runProbe(
  proxy: ProxyConfig,
  endpoint: URL,
  dependencies: RouteRuntimeDependencies,
  base: ResultBase,
  signal?: AbortSignal,
): Promise<RouteCheckResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 100) / 100;
    const nonce = randomBytes(16).toString('hex');
    const authority = `${endpoint.hostname}:${endpoint.port || '443'}`;
    let phase: Phase = 'proxy_connect';
    let settled = false;
    let proxyConnectMs = 0;
    let tlsStarted = 0;
    let tlsHandshakeMs = 0;
    let connectRequest: http.ClientRequest | undefined;
    let echoRequest: http.ClientRequest | undefined;
    let echoResponse: http.IncomingMessage | undefined;
    let tunnel: Socket | undefined;
    let secureSocket: tls.TLSSocket | undefined;
    let echoAgent: https.Agent | undefined;
    // A private agent explicitly ignores global proxy and NO_PROXY settings.
    const connectAgent = new http.Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, proxyEnv: {} });

    function finish(result: RouteCheckResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      echoResponse?.destroy();
      echoRequest?.destroy();
      connectRequest?.destroy();
      secureSocket?.destroy();
      tunnel?.destroy();
      echoAgent?.destroy();
      connectAgent.destroy();
      resolve(result);
    }
    function fail(code: FailureCode): void {
      finish({ ...base, ok: false, code, message: failureMessages[code], phase, elapsedMs: elapsed() });
    }
    function onAbort(): void { fail('ABORTED'); }
    const timer = setTimeout(() => fail('TIMEOUT'), dependencies.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }

    function requestEcho(socket: tls.TLSSocket): void {
      if (settled) { socket.destroy(); return; }
      phase = 'echo_response';
      echoAgent = new https.Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, proxyEnv: {} });
      // Returning only this verified tunnel makes a direct reconnect impossible.
      let handedOut = false;
      echoAgent.createConnection = () => {
        if (handedOut || socket.destroyed) throw new Error('Diagnostic tunnel is unavailable.');
        handedOut = true;
        return socket;
      };
      try {
        echoRequest = https.request({
          hostname: endpoint.hostname,
          port: endpoint.port || 443,
          method: 'GET',
          path: `/egress?nonce=${nonce}`,
          agent: echoAgent,
          maxHeaderSize: MAX_HEADER_BYTES,
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close' },
        }, (response) => {
          echoResponse = response;
          response.on('error', () => fail('ENDPOINT_FAILED'));
          response.on('aborted', () => fail('ENDPOINT_FAILED'));
          if (settled) { response.destroy(); return; }
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) { fail('REDIRECT_REFUSED'); return; }
          if (status !== 200) { fail('ENDPOINT_FAILED'); return; }
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '') ||
              (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            fail('INVALID_RESPONSE'); return;
          }
          const length = response.headers['content-length'];
          if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
            fail('RESPONSE_TOO_LARGE'); return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) { fail('RESPONSE_TOO_LARGE'); return; }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            try {
              const parsed = echoSchema.safeParse(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
              if (!parsed.success || parsed.data.nonce !== nonce) { fail('INVALID_RESPONSE'); return; }
              finish({
                ...base,
                ok: true,
                observedIp: parsed.data.ip,
                checkedAt: new Date().toISOString(),
                timingsMs: { proxyConnect: proxyConnectMs, tlsHandshake: tlsHandshakeMs, total: elapsed() },
              });
            } catch {
              fail('INVALID_RESPONSE');
            }
          });
        });
        echoRequest.on('error', () => fail('ENDPOINT_FAILED'));
        echoRequest.end();
      } catch {
        fail('ENDPOINT_FAILED');
      }
    }

    try {
      connectRequest = http.request({
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: authority,
        agent: connectAgent,
        maxHeaderSize: MAX_HEADER_BYTES,
        headers: {
          Host: authority,
          ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}),
        },
      });
      connectRequest.on('socket', (socket) => {
        tunnel = socket;
        // Keep a safe listener through cancellation and ownership transfer to TLS.
        socket.on('error', () => fail(phase === 'proxy_connect' ? 'PROXY_CONNECT_FAILED' : phase === 'tls_handshake' ? 'TLS_FAILED' : 'ENDPOINT_FAILED'));
        if (settled) socket.destroy();
      });
      connectRequest.on('error', () => fail('PROXY_CONNECT_FAILED'));
      connectRequest.on('response', (response) => {
        response.on('error', () => fail('PROXY_CONNECT_FAILED'));
        response.destroy();
        fail(response.statusCode === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_REJECTED');
      });
      connectRequest.on('connect', (response, socket, head) => {
        tunnel = socket;
        if (settled) { socket.destroy(); return; }
        const status = response.statusCode ?? 0;
        if (status === 407) { fail('PROXY_AUTH_REQUIRED'); return; }
        if (status < 200 || status >= 300 || head.length !== 0) { fail('PROXY_CONNECT_REJECTED'); return; }
        proxyConnectMs = elapsed();
        phase = 'tls_handshake';
        tlsStarted = performance.now();
        try {
          secureSocket = tls.connect({
            socket,
            servername: endpoint.hostname,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            ALPNProtocols: ['http/1.1'],
            ...(dependencies.ca ? { ca: dependencies.ca } : {}),
          });
          secureSocket.on('error', () => fail(phase === 'tls_handshake' ? 'TLS_FAILED' : 'ENDPOINT_FAILED'));
          secureSocket.once('secureConnect', () => {
            if (!secureSocket || !secureSocket.authorized) { fail('TLS_FAILED'); return; }
            tlsHandshakeMs = Math.round((performance.now() - tlsStarted) * 100) / 100;
            requestEcho(secureSocket);
          });
        } catch {
          fail('TLS_FAILED');
        }
      });
      connectRequest.end();
    } catch {
      fail('PROXY_CONNECT_FAILED');
    }
  });
}
