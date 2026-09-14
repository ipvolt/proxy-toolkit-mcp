# ipvolt Proxy Toolkit

An MCP server for finding reviewed proxy documentation, generating tested configuration examples and diagnosing structured proxy failures. The public tools run locally against a bundled catalog. They do not need an API key or access to an ipvolt proxy account.

The toolkit is separate from ipvolt's commercial proxy service, which is not open yet. It does not provision proxies, buy traffic, access account data or configure another agent's network route.

## Availability

This is the initial release candidate. Build from source using the instructions below. npm, the hosted endpoint and registry submissions are pending verification; see [release status](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/docs/release-status.md). Registry metadata in `server.json` describes the intended release and is not evidence that a channel is live.

## Tools

| Tool | What it does | Availability |
| --- | --- | --- |
| `search_proxy_docs` | Search reviewed guides and articles; return canonical links, excerpts and a content revision. | Hosted and local |
| `get_proxy_doc` | Retrieve a named document or section in bounded chunks, with revision-bound continuation cursors. | Hosted and local |
| `generate_proxy_config` | Return an exact-version HTTPS GET template with local environment placeholders. It does not execute code. | Hosted and local |
| `diagnose_proxy_error` | Interpret structured observations such as CONNECT407, TLS failure or an ambiguous timeout; state uncertainty and retry boundaries. | Hosted and local |
| `check_proxy_route` | Make one bounded request through an explicitly configured local proxy to the fixed ipvolt echo endpoint. | Local, explicitly enabled |

For example, search with `{"query":"curl proxy","topic":"setup"}`, then retrieve `{"documentId":"/guides/curl-proxy-setup"}`. Generate a synchronous HTTPX example with `{"client":"httpx","version":"0.28.1"}`. Diagnose a proxy authentication failure with `{"client":"httpx","version":"0.28.1","phase":"proxy_connect","status":407}`. A 407 observation points to proxy authentication; it does not establish whether a password, account state or access policy is responsible.

Use short topic queries and structured observations. Supply credentials only through your local environment when you execute a generated example or enable the local diagnostic. Never send credentials, private URLs or raw logs as tool arguments.

## Build and connect locally

Requires Node.js 24 or newer and npm. From the repository directory:

```sh
npm ci
npm run build
npm run check:content
node dist/transports/stdio.js --version
```

For a client that accepts a `mcpServers` configuration, use an absolute path to the compiled entry:

```json
{
  "mcpServers": {
    "ipvolt": {
      "command": "node",
      "args": ["/absolute/path/to/proxy-toolkit-mcp/dist/transports/stdio.js"]
    }
  }
}
```

The default local server exposes four tools, sends no telemetry and makes no network requests. A client may send tool results to its own model provider. The server cannot control that client's data handling.

After the release is available on npm, the equivalent version-pinned command will be `npx --yes @ipvolt/proxy-toolkit-mcp@0.1.0`. Check release status before using it. Exact real-application and protocol results are recorded in [client compatibility](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/docs/client-compatibility.md).

## Tested configuration examples

| Client | Version | Tested interface |
| --- | --- | --- |
| curl | 8.22.0 | Command line, macOS/OpenSSL |
| Requests | 2.34.2 | `Session`, Python 3.14.7 |
| HTTPX | 0.28.1 | Synchronous `Client`, Python 3.14.7 |
| Playwright | 1.63.0 | `APIRequestContext`, Node 24.20.0 |

Templates use an HTTP proxy with HTTPS CONNECT, verify destination TLS, disable redirects and automatic retries, and print status or a bounded failure category. The destination and proxy remain local `TARGET_URL` and `PROXY_URL` variables. Requests and HTTPX timeouts are phase/inactivity budgets; they are not total job deadlines. Playwright's example uses its request API, buffers the response and is intended for small diagnostic targets. It does not configure browser navigation.

The exact matrix was executed against controlled authenticated proxies and HTTPS origins. See [fixture method and evidence](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/tests/template-fixtures/README.md). Other versions, proxy protocols and platforms are not claimed to have been tested. Review generated code before executing it against an authorized destination.

## Optional local route diagnostic

Set `IPVOLT_ENABLE_ROUTE_CHECK=1` and provide the private `IPVOLT_PROXY_URL` through your MCP client's local secret environment. Invoke `check_proxy_route` with `{"profile":"default"}`. The tool accepts no proxy URL, credential or destination argument. Enabling it performs no request until the tool is called.

The check uses an HTTP CONNECT proxy and verified destination TLS to request only `https://mcp.ipvolt.com/egress`, with a random nonce. It has a ten-second total deadline, no redirect or direct fallback, one active request, bounded headers/body and cancellation cleanup. The HTTP connection to the proxy is not encrypted; HTTP proxy authentication can be observed on that first hop. Use a trusted network or a local tunnel appropriate to your setup.

Success reports the exit address seen by that one echo request. It does not prove anonymity, country, proxy type, ownership, or the routing of a browser, shell, SDK or other agent tool. It consumes a small amount of proxy bandwidth. The echo service receives the request's exit address; application access logging is disabled. Diagnostic debug/TLS settings that could expose credentials or weaken verification are rejected.

The diagnostic requires the hosted echo service to be available. The release candidate's controlled fixture checks do not claim a successful request through a live supplier.

## Hosted service

The planned remote URL is `https://mcp.ipvolt.com/mcp`, using Streamable HTTP. It exposes the four public tools without signup or an API key. The local route diagnostic is omitted and direct attempts to call it are rejected. No proxy configuration is accepted by this service.

For a local development instance:

```sh
IPVOLT_MCP_PUBLIC_URL=http://127.0.0.1:3040/mcp npm start
```

The process binds to loopback. Production configuration and coordinated rollback are documented in [deployment instructions](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/deploy/README.md). Default bounds are 32 KiB request bodies, 8 KiB headers, 16 concurrent requests and 120 requests per minute per observed peer address. Exact browser origins are allowlisted. Reverse-proxy address headers are trusted only with an explicitly configured loopback proxy that overwrites them.

Hosted metrics contain only the tool name, success/error status, duration and toolkit version. Tool arguments, result bodies, credentials and exit addresses are not logged. Rate limiting retains temporary keyed address hashes for up to 60 seconds; local stdio usage is untracked. Machine endpoints use `noindex` and remain separate from the public website's consent-controlled analytics.

## Maintain and verify

```sh
npm run typecheck
npm run build
npm test
npm run check:content
npm run check:manifest
npm run check:package
python3 -m unittest discover -s deploy -p 'test_*.py' -v
```

`check:package` inspects the actual npm tarball, installs it in a temporary consumer directory and discovers/calls all four tools with the current and legacy protocol paths. `check:content -- --live` compares every bundled Markdown document to its public canonical export; it performs only those allowlisted public reads.

The runtime does not crawl the website. A maintainer exports only the reviewed public guide/blog catalogs from a verified website source using `scripts/export-content.ts`, reviews the resulting diff and publishes a new immutable package version. Drafts and private operational applications are outside that allowlist. Bundle and document SHA-256 values make source changes observable.

Code is MIT licensed. Bundled editorial content has a separate [content license](CONTENT-LICENSE.md). Support belongs in the repository's issue tracker; omit credentials and private logs from reports.
