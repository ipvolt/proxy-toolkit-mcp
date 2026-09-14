import { z } from "zod";

/** Exact versions exercised by tests/template-fixtures/run-templates.ts. */
export const SUPPORTED_CLIENTS = [
  { client: "curl", version: "8.22.0", language: "sh", interface: "command-line", runtime: "curl 8.22.0 / macOS OpenSSL 3.6.4", source: "https://ipvolt.com/guides/curl-proxy-setup" },
  { client: "requests", version: "2.34.2", language: "python", interface: "Session", runtime: "Python 3.14.7", source: "https://ipvolt.com/guides/python-requests-proxy" },
  { client: "httpx", version: "0.28.1", language: "python", interface: "Client (synchronous)", runtime: "Python 3.14.7", source: "https://ipvolt.com/guides/httpx-async-proxy" },
  { client: "playwright", version: "1.63.0", language: "javascript", interface: "APIRequestContext (not browser navigation)", runtime: "Node 24.20.0", source: "https://ipvolt.com/guides/playwright-proxy-setup" },
] as const;

export const supportedClients = SUPPORTED_CLIENTS;
export const clientSchema = z.enum(["curl", "requests", "httpx", "playwright"]);
export const clientVersionSchema = z.enum(["8.22.0", "2.34.2", "0.28.1", "1.63.0"]);

export function isSupportedClientVersion(client: string, version: string): boolean {
  return SUPPORTED_CLIENTS.some((entry) => entry.client === client && entry.version === version);
}

export const configInputSchema = z.strictObject({
  client: clientSchema.describe("Client whose exact tested configuration to generate."),
  version: clientVersionSchema.describe("Exact tested version matching the client. Other versions are unsupported."),
  protocol: z.literal("http").default("http").describe("HTTP proxy with HTTPS CONNECT. Other proxy protocols are not tested."),
  timeoutSeconds: z.number().int().min(1).max(60).default(15),
}).refine((input) => isSupportedClientVersion(input.client, input.version), {
  message: "Client and version must match the supported-client manifest.", path: ["version"],
});

export type ConfigInput = z.input<typeof configInputSchema>;

export const configOutputSchema = z.strictObject({
  client: clientSchema,
  version: clientVersionSchema,
  protocol: z.literal("http"),
  templateRevision: z.string(),
  language: z.enum(["sh", "python", "javascript"]),
  interface: z.string(),
  testedRuntime: z.string(),
  code: z.string().max(16384),
  environment: z.array(z.strictObject({ name: z.string(), required: z.boolean(), secret: z.boolean(), description: z.string() })).max(3),
  behavior: z.strictObject({
    method: z.literal("GET"), followsRedirects: z.literal(false), automaticRetries: z.literal(0),
    bypassesProxy: z.literal(false), verifiesTargetTls: z.literal(true), output: z.string(),
    timeoutSeconds: z.number().int().min(1).max(60), timeoutScope: z.string(),
  }),
  limitations: z.array(z.string()).max(4),
  summary: z.string(),
  sources: z.array(z.url()).max(3),
});

const pythonEnvironment = `import json
import os
import sys
from urllib.parse import urlsplit


def checked_url(name, scheme, proxy=False):
    value = os.environ[name]
    if len(value) > 4096 or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise ValueError("invalid local configuration")
    parsed = urlsplit(value)
    if parsed.scheme != scheme or not parsed.hostname or parsed.fragment:
        raise ValueError("invalid local configuration")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError("invalid local configuration")
    if proxy and (parsed.path not in ("", "/") or parsed.query):
        raise ValueError("invalid local configuration")
    if not proxy and (parsed.username is not None or parsed.password is not None):
        raise ValueError("target credentials are unsupported")
    return value
`;

function curlTemplate(timeout: number): string {
  // curl 8.3+ imports the private variable itself, keeping its value out of argv.
  return `#!/bin/sh
set -eu

# Inject both variables locally; never paste credentials into an MCP argument.
case "\${PROXY_URL-}" in http://?*) ;; *) printf '%s\\n' '{"error":"invalid_proxy_configuration"}' >&2; exit 2 ;; esac
case "\${TARGET_URL-}" in https://?*) ;; *) printf '%s\\n' '{"error":"invalid_target_configuration"}' >&2; exit 2 ;; esac

# --disable must be first: ignore personal curlrc files. --noproxy overrides bypass env.
# No --location, no retries, no response body or raw error text in the output.
if status="$(curl --disable --silent \\
  --variable '%PROXY_URL' --expand-proxy '{{PROXY_URL}}' \\
  --variable '%TARGET_URL' --expand-url '{{TARGET_URL}}' \\
  --noproxy '' --proto '=https' --globoff \\
  --connect-timeout ${timeout} --max-time ${timeout} --retry 0 \\
  --output /dev/null --write-out '%{response_code}' 2>/dev/null)"; then
  printf '{"status":%s}\\n' "$status"
else
  code=$?
  printf '{"error":"request_failed","exitCode":%s}\\n' "$code" >&2
  exit "$code"
fi
`;
}

function requestsTemplate(timeout: number): string {
  return `# Tested with requests==2.34.2. Save as proxy_request.py, not requests.py.
# This makes one HTTPS GET and prints only status.
${pythonEnvironment}
import requests

try:
    proxy = checked_url("PROXY_URL", "http", proxy=True)
    target = checked_url("TARGET_URL", "https")
    with requests.Session() as session:
        session.trust_env = False  # Ignore ambient proxy settings, NO_PROXY and netrc.
        with session.get(
            target,
            proxies={"http": proxy, "https": proxy},
            timeout=(${timeout}, ${timeout}),
            allow_redirects=False,
            stream=True,
            verify=os.environ.get("TARGET_CA_BUNDLE") or True,
        ) as response:
            print(json.dumps({"status": response.status_code}))
except (KeyError, ValueError):
    print('{"error":"invalid_local_configuration"}', file=sys.stderr)
    sys.exit(2)
except requests.exceptions.RequestException as error:
    allowed = {"ProxyError", "SSLError", "ConnectTimeout", "ReadTimeout", "ConnectionError", "Timeout"}
    category = type(error).__name__
    print(json.dumps({"error": category if category in allowed else "request_failed"}), file=sys.stderr)
    sys.exit(1)
except Exception:
    # Do not print arbitrary exception messages; they may contain a credential URL.
    print('{"error":"request_failed"}', file=sys.stderr)
    sys.exit(1)
`;
}

function httpxTemplate(timeout: number): string {
  return `# Tested with httpx==0.28.1. Save as proxy_httpx.py, not httpx.py.
# This is a synchronous Client example.
${pythonEnvironment}
import ssl
import httpx

try:
    proxy = checked_url("PROXY_URL", "http", proxy=True)
    target = checked_url("TARGET_URL", "https")
    trust = ssl.create_default_context(cafile=os.environ.get("TARGET_CA_BUNDLE") or None)
    with httpx.Client(
        proxy=proxy,
        trust_env=False,
        timeout=httpx.Timeout(${timeout}.0),
        follow_redirects=False,
        verify=trust,
    ) as client:
        with client.stream("GET", target) as response:
            print(json.dumps({"status": response.status_code}))
except (KeyError, ValueError):
    print('{"error":"invalid_local_configuration"}', file=sys.stderr)
    sys.exit(2)
except httpx.HTTPError as error:
    allowed = {"ProxyError", "ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "ReadError", "WriteError", "RemoteProtocolError"}
    category = type(error).__name__
    print(json.dumps({"error": category if category in allowed else "request_failed"}), file=sys.stderr)
    sys.exit(1)
except Exception:
    print('{"error":"request_failed"}', file=sys.stderr)
    sys.exit(1)
`;
}

function playwrightTemplate(timeout: number): string {
  return `// Tested with playwright@1.63.0 and Node 24.20.0. Save as proxy-check.mjs.
// This configures APIRequestContext only; it does not configure a browser context.
import { debuglog } from 'node:util';

// Check before importing Playwright or reading proxy credentials. Its DEBUG=pw:*
// channel can log the proxy options before application error handling runs.
const unsafeEnvironment = Boolean(process.env.DEBUG || process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE)
  || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  || /--(?:tls-keylog|trace-tls)/.test(process.env.NODE_OPTIONS || '')
  || process.execArgv.some((argument) => /^--(?:tls-keylog|trace-tls)(?:=|$)/.test(argument))
  || ['http', 'https', 'http2', 'net', 'tls'].some((category) => debuglog(category).enabled);

function checkedUrl(name, protocol, proxy = false) {
  const value = process.env[name];
  if (!value || value.length > 4096 || /[\\x00-\\x20\\x7f]/.test(value)) throw new Error('configuration');
  const url = new URL(value);
  if (url.protocol !== protocol || !url.hostname || url.hash) throw new Error('configuration');
  if (proxy && (url.pathname !== '/' || url.search)) throw new Error('configuration');
  if (!proxy && (url.username || url.password)) throw new Error('configuration');
  return url;
}

if (unsafeEnvironment) {
  console.error(JSON.stringify({ error: 'unsafe_debug_environment' }));
  process.exitCode = 1;
} else {
 let context;
 try {
  const { request } = await import('playwright');
  const proxy = checkedUrl('PROXY_URL', 'http:', true);
  const target = checkedUrl('TARGET_URL', 'https:');
  context = await request.newContext({
    proxy: {
      server: proxy.origin,
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
      bypass: '',
    },
    timeout: ${timeout * 1000},
    ignoreHTTPSErrors: false,
    maxRedirects: 0,
  });
  const response = await context.get(target.href, { maxRetries: 0 });
  console.log(JSON.stringify({ status: response.status() }));
  await response.dispose();
 } catch {
  // Playwright error text may include request details. Keep the output bounded.
  console.error(JSON.stringify({ error: 'request_failed' }));
  process.exitCode = 1;
 } finally {
  if (context) await context.dispose().catch(() => {});
 }
}
`;
}

export function generateProxyConfig(input: unknown) {
  const parsed = configInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid configuration input. Select an exact supported client/version and bounded options; do not submit URLs or credentials.");
  const options = parsed.data;
  const manifest = SUPPORTED_CLIENTS.find((entry) => entry.client === options.client)!;
  const templates = { curl: curlTemplate, requests: requestsTemplate, httpx: httpxTemplate, playwright: playwrightTemplate };
  const python = options.client === "requests" || options.client === "httpx";
  return configOutputSchema.parse({
    client: options.client,
    version: options.version,
    protocol: options.protocol,
    templateRevision: "2026-09-14.2",
    language: manifest.language,
    interface: manifest.interface,
    testedRuntime: manifest.runtime,
    code: templates[options.client](options.timeoutSeconds),
    environment: [
      { name: "PROXY_URL", required: true, secret: true, description: "Inject the HTTP proxy URL privately in the local process environment. Percent-encode username/password components if present." },
      { name: "TARGET_URL", required: true, secret: false, description: "An HTTPS URL you are authorized to request. This template makes one GET; it is not a hosted fetch tool." },
      { name: options.client === "curl" ? "CURL_CA_BUNDLE" : python ? "TARGET_CA_BUNDLE" : "NODE_EXTRA_CA_CERTS", required: false, secret: false, description: options.client === "playwright" ? "Optional PEM trust roots, set before starting Node. TLS verification remains enabled." : "Optional PEM trust roots for an authorized private test origin. TLS verification remains enabled." },
    ],
    behavior: {
      method: "GET", followsRedirects: false, automaticRetries: 0, bypassesProxy: false,
      verifiesTargetTls: true, output: "HTTP status or a bounded error category; no response body or URL",
      timeoutSeconds: options.timeoutSeconds,
      timeoutScope: python ? "Per connect/read phase or inactivity operation; not a total wall-clock deadline." : "Whole request, with a bounded connection timeout where supported.",
    },
    limitations: [
      "Only the exact listed client version and an HTTP proxy carrying an HTTPS request are tested. Other proxy protocols and authentication schemes are unsupported.",
      "HTTPS verification protects the target connection. An HTTP proxy connection itself is not encrypted; select a gateway appropriate to your network and authentication requirements.",
      "A returned status does not establish content correctness, anonymity, country or proxy use by any other process.",
      ...(options.client === "playwright" ? ["This is APIRequestContext traffic, not browser navigation. Use a small target because Playwright buffers responses. DEBUG, NODE_DEBUG/NATIVE and insecure TLS/tracing settings must be off before starting."] : []),
    ],
    summary: `One ${manifest.interface} HTTPS GET using a privately configured HTTP proxy, TLS verification and no redirects or automatic retries.`,
    sources: [manifest.source, "https://ipvolt.com/guides/proxy-environment-variables", "https://ipvolt.com/guides/proxy-timeout-troubleshooting"],
  });
}
