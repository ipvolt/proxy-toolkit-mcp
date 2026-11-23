# ipvolt Proxy Toolkit

An MCP server for finding reviewed proxy documentation, generating tested configuration examples and diagnosing structured proxy failures. The public tools run locally against a bundled catalog. They do not need an API key or access to an ipvolt proxy account.

Without an API key, the toolkit does not provision proxies, spend money or access account data. With one, the optional [account tools](#account-tools-optional) let a local install rent and manage ipvolt mobile proxies paid from your prepaid balance. To try those tools before you have an account, start the server in [sandbox mode](#try-them-without-an-account-sandbox): the same tools on a simulated account, with no key and nothing charged. The toolkit never configures another agent's network route.

## Availability

The npm package and the public hosted service provide four tools using a bundled public catalog. Version 0.2.0 adds seven optional account tools to local (stdio) installs that set an API key, and version 0.3.0 adds a sandbox mode that runs them on a simulated account without a key; the hosted service never offers either. Version 0.3.1 refreshes the bundled documents. Check [release status](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/docs/release-status.md) for verified npm availability, the hosted endpoint and registry listings. Source builds work independently of those distribution channels. Registry metadata in `server.json` describes the intended release and is not evidence that a channel is live.

## Tools

| Tool | What it does | Availability |
| --- | --- | --- |
| `search_proxy_docs` | Search reviewed guides and articles; return canonical links, excerpts and a content revision. | Hosted and local |
| `get_proxy_doc` | Retrieve a named document or section in bounded chunks, with revision-bound continuation cursors. | Hosted and local |
| `generate_proxy_config` | Return an exact-version HTTPS GET template with local environment placeholders. It does not execute code. | Hosted and local |
| `diagnose_proxy_error` | Interpret structured observations such as CONNECT407, TLS failure or an ambiguous timeout; state uncertainty and retry boundaries. | Hosted and local |
| `check_proxy_route` | Make one bounded request through an explicitly configured local proxy to the fixed ipvolt echo endpoint. | Local, explicitly enabled |
| `list_stock`, `get_balance`, `list_rentals`, `get_rental` | Read stock and prices, your balance and key limits, and your rentals with their connection details. | Local, with `IPVOLT_API_KEY`; simulated with `IPVOLT_SANDBOX=1` |
| `rent_proxy`, `extend_rental`, `rotate_ip` | Rent or extend mobile proxies from your prepaid balance (after a confirmation step), or rotate a rental's IP. | Local, with a read-write `IPVOLT_API_KEY`; simulated with `IPVOLT_SANDBOX=1` |

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

Without `IPVOLT_API_KEY`, the local server exposes four tools, sends no telemetry and makes no network requests. With `IPVOLT_SANDBOX=1` it exposes eleven and still makes none. A client may send tool results to its own model provider. The server cannot control that client's data handling.

For the npm distribution, use the pinned package version after confirming its availability in release status:

```json
{
  "mcpServers": {
    "ipvolt": {
      "command": "npx",
      "args": ["--yes", "@ipvolt/proxy-toolkit-mcp@0.3.1"]
    }
  }
}
```

Exact real-application and protocol results are recorded in [client compatibility](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/docs/client-compatibility.md).

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

The diagnostic requires the hosted echo service to be available. Check release status before enabling it. Controlled fixture checks do not claim a successful request through a live supplier.

## Account tools (optional)

With an ipvolt API key, a local stdio install adds seven tools that call the ipvolt customer API at `https://ipvolt.com/beta/api/v1`. Without the key they are not registered, unless you start the [sandbox](#try-them-without-an-account-sandbox). The hosted service at `mcp.ipvolt.com` never offers them.

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_stock` | Countries, carriers, lengths (1 or 30 days), prices and whether each is in stock now. Never a stock count. | Free, read only |
| `get_balance` | Available and held prepaid balance, and this key's access level, daily limit, spending today and what remains today. | Free, read only |
| `list_rentals` | Your active rentals with their connection details (host, ports, username, password). | Free, read only |
| `get_rental` | One active rental with its connection details. | Free, read only |
| `rent_proxy` | Rent 1 to 20 devices for 1 or 30 days. | Charges the prepaid balance, after confirmation |
| `extend_rental` | Extend an active rental by 1 or 30 days. | Charges the prepaid balance, after confirmation |
| `rotate_ip` | Ask for a new IP address on a rental. Open connections through the device may drop. | Free; changes the device's IP |

### Try them without an account (sandbox)

Set `IPVOLT_SANDBOX=1` and no API key. The server then offers the same seven tools on a simulated account that exists only inside the server process. You need no ipvolt account, key or balance.

```json
{
  "mcpServers": {
    "ipvolt-sandbox": {
      "command": "npx",
      "args": ["--yes", "@ipvolt/proxy-toolkit-mcp@0.3.1"],
      "env": { "IPVOLT_SANDBOX": "1" }
    }
  }
}
```

With Claude Code:

```sh
claude mcp add ipvolt-sandbox -e IPVOLT_SANDBOX=1 -- npx --yes @ipvolt/proxy-toolkit-mcp@0.3.1
```

Then ask the assistant to list the stock, rent a proxy, show its connection details, rotate its IP and extend it.

- **Nothing is real.** A server in sandbox mode sends no network request, reads no key and stores nothing. No proxy is rented and nothing is charged. Restarting the server resets the account.
- **Every answer from an account tool says so.** A successful answer starts with a `SANDBOX:` line. Every structured result, success or refusal, has `sandbox: true` and a summary that starts `Sandbox (simulated):`. Tool titles end in "(sandbox)", and each description starts with `SANDBOX MODE` before it says what the tool does with a real key. A call with arguments the tool does not accept never reaches the tool: it gets the short protocol error, which has nothing simulated in it.
- **The account.** It starts with a pretend balance of $500.00 and no rentals. Its key is read-write and has no daily limit.
- **Stock and prices are samples.** `list_stock` returns eleven sample offers in stock, and a twelfth that is sold out when you pass `includeSoldOut: true`. They are a subset of the public list on 18 November 2026 and are not live. Current prices are at [ipvolt.com/pricing](https://ipvolt.com/pricing).
- **Renting and extending** take the same two steps as with a key: a preview with the charge and a `requestId`, then `confirm: true`. Repeating a confirm returns the same order, now `fulfilled`, and charges the pretend balance once; a repeated rental order then also names its rental ids. A new rental is in `list_rentals` at once; a real device takes minutes to set up.
- **Simulated rentals connect to nothing.** Their ids start with `sandbox-`. The host is `proxy.sandbox.invalid`, which cannot resolve. The usernames and passwords are made up when the rental is created, and the IP addresses come from the blocks reserved for documentation.
- **Rotating** gives the rental a new simulated address. A second rotation within 30 seconds is refused with `rotation_cooldown` and the seconds to wait, the refusal the API gives after a real rotation.
- **Refusals you can try:** spend the balance (`insufficient_balance`), rent France SFR for 30 days (`stock_unavailable`), rotate twice in a row (`rotation_cooldown`), or use a rental id that does not exist (`rental_not_found`).

The sandbox does not show live stock or prices, the time a real device takes to become ready, a rotation that is still running (`pending`), a read-only key, a daily limit, rate limits, or whether a proxy works for your target. Tool annotations differ too: in sandbox mode none marks a tool as destructive or as reaching outside the process, because no account tool is or does there. With a key, renting, extending and rotating are marked destructive.

`IPVOLT_SANDBOX=1` together with `IPVOLT_API_KEY` stops the server at start, so a simulated rental cannot be mistaken for a real one. It also stops beside `IPVOLT_ENABLE_ROUTE_CHECK=1`, because the route check makes a real request through a real proxy. To use a real account, remove `IPVOLT_SANDBOX` and set the key as described below. Keep the sandbox as its own server entry, as in the example, and add the real one separately: a client may remember approvals you gave to the sandbox's tools under that entry's name.

### Create a key

Sign in to the ipvolt dashboard and open **Account settings → API keys**. The key is shown once; store it like a password. Each key has:

- an access level: **read only** (`list_stock`, `get_balance`, `list_rentals`, `get_rental`; renting, rotating and extending are refused with `read_only_api_key`) or **read and write** (also rent, rotate and extend);
- an optional **daily limit** from $1 to $10,000, which caps what the key can spend on rentals and extensions per UTC day. Without one, the balance is the limit. `get_balance` shows what the key can still spend today;
- an expiry of 30 or 90 days. You can revoke a key at any time; it stops working at once.

Use a read-only key unless the assistant needs to rent, rotate or extend, and give a read-write key a daily limit you are comfortable with.

### Configure it

Put the key only in your MCP client's local environment, never in a tool argument, a prompt or a file you share. The examples pin version 0.3.1; confirm it in [release status](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/docs/release-status.md) first.

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ipvolt": {
      "command": "npx",
      "args": ["--yes", "@ipvolt/proxy-toolkit-mcp@0.3.1"],
      "env": { "IPVOLT_API_KEY": "ipvolt_your_key" }
    }
  }
}
```

Claude Code, reading the key from your shell so it stays out of the command history:

```sh
claude mcp add ipvolt -e IPVOLT_API_KEY="$IPVOLT_API_KEY" -- npx --yes @ipvolt/proxy-toolkit-mcp@0.3.1
```

This uses Claude Code's default local scope. Do not add it with `--scope project`, which writes the key into the repository's `.mcp.json`.

Any other client that accepts `mcpServers` takes the same `env` entry, also with a source build (`"command": "node"`, `"args": ["/absolute/path/to/proxy-toolkit-mcp/dist/transports/stdio.js"]`). Restart the client after changing it.

### How spending works

- `rent_proxy` and `extend_rental` work in two steps. Called without `confirm: true`, they only look up the current price and answer with the exact charge and a `requestId`, for example: "Renting 1 × US Verizon for 30 days will charge $100.00 from your balance. Nothing has been charged yet. To proceed, call rent_proxy again with confirm: true and requestId: …". Nothing is charged. Approve that charge before the assistant confirms it.
- Called with `confirm: true` and that `requestId`, the tool sends the request with the `requestId` as its `Idempotency-Key` and the previewed price as the maximum per device. Repeating a confirm returns the same order and never charges twice. If the price rose in between, the API refuses the request instead of charging more.
- If a confirm times out or the connection drops, its outcome is unknown. Repeat it with the same `requestId` to see the order; it cannot charge twice.
- All charges come from the prepaid balance. The tools cannot add funds, withdraw or change the account. Add funds in the dashboard, or let the agent pay its own USDC on Base through the top-up described at https://ipvolt.com/docs/api.
- A preview is kept by the running server for 15 minutes. After a restart, preview again.
- A new rental is charged when the order is accepted, and the device is usually ready within minutes: `list_rentals` then shows it. If setup fails, the money returns to the balance.
- Refusals arrive with the API's error code and message, for example `insufficient_balance` with the missing amount, `daily_limit_exceeded` with what remains today, or `rotation_cooldown` with the seconds to wait.

### Keys and connection details

- The key travels only in the `Authorization` header of HTTPS requests to the API. The server never logs it, writes it to stderr or returns it in a result, and withholds any answer that contains it. The account tools refuse to start when Node network debugging, TLS key logging or disabled TLS verification is configured.
- `list_rentals` and `get_rental` return your own rentals' connection details. Like any tool result, your MCP client passes them to its model. The server never logs them or writes them to stderr, and error messages never contain them.
- The public stock list is read without the key. Every other request is made with it, and the API keeps each key's activity (time, action, result and amount charged; never the key, proxy credentials or request bodies) for 90 days under **Account settings → API keys → Activity**.
- `IPVOLT_API_BASE` replaces the API address for local testing. It must be `https`, or `http` only for `127.0.0.1` or `localhost`.

The [Acceptable Use Policy](https://ipvolt.com/acceptable-use) applies to everything done through the API, including these tools.

## Hosted service

The public remote URL is `https://mcp.ipvolt.com/mcp`, using Streamable HTTP. Select that transport in your MCP client and enter the URL. Public HTTPS, all four tools on both supported protocol versions, and the echo endpoint were verified on 14 September 2026; see [hosted verification](docs/hosted-publication-2026-09-14.json). It exposes the four public tools without signup or an API key. The local route diagnostic and the account tools are omitted and direct attempts to call it are rejected. No proxy configuration is accepted by this service.

For a local development instance:

```sh
IPVOLT_MCP_PUBLIC_URL=http://127.0.0.1:3040/mcp npm start
```

The process binds to loopback. Production configuration and coordinated rollback are documented in [deployment instructions](https://github.com/ipvolt/proxy-toolkit-mcp/blob/main/deploy/README.md). Default bounds are 32 KiB request bodies, 8 KiB headers, 16 concurrent requests and 120 requests per minute per observed peer address. Exact browser origins are allowlisted. Reverse-proxy address headers are trusted only with an explicitly configured loopback proxy that overwrites them.

Hosted metrics contain only the tool name, success/error status, duration and toolkit version. Tool arguments, result bodies, credentials and exit addresses are not logged. Rate limiting retains temporary keyed address hashes for up to 60 seconds; local stdio usage is untracked. Machine endpoints use `noindex` and remain separate from the public website's consent-controlled analytics.

## ipvolt account server (remote)

ipvolt also runs a second, separate MCP server at `https://ipvolt.com/beta/mcp` (Streamable HTTP). It is part of the ipvolt customer app, not of this package, and its source is not in this repository. Without a credential it lists the mobile proxies on sale with their prices. With an ipvolt API key in the `Authorization` header (`Bearer`, a space, the key) it reads your balance and rentals, rotates an IP, and rents or extends from your prepaid balance: it shows the exact charge first and charges only when you confirm it. A read-only key cannot spend, and a key's daily limit applies. See [ipvolt.com/mcp](https://ipvolt.com/mcp) for the tools and a configuration example.

Use it when your client connects to remote servers and you want no local install. Use the account tools of this package (above) when you prefer a local stdio server; both call the same customer API under the same rules. The hosted toolkit at `mcp.ipvolt.com` stays as it is: four public tools, no key.

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

`check:package` inspects the actual npm tarball, installs it in a temporary consumer directory and discovers/calls all four tools with the current and legacy protocol paths. It also checks that an API key adds the seven account tools, and calls all seven in sandbox mode; the account tests in `tests/account-tools.test.ts` run them against a local stand-in for the API, and `tests/sandbox.test.ts` runs the sandbox in a process where any network use is refused. `check:content -- --live` compares every bundled Markdown document to its public canonical export; it performs only those allowlisted public reads.

The runtime does not crawl the website. A maintainer exports only the reviewed public guide/blog catalogs from a verified website source using `scripts/export-content.ts` (with `--bundled-only` to refresh the documents already in the bundle and add none), reviews the resulting diff and publishes a new immutable package version. Drafts and private operational applications are outside that allowlist. Bundle and document SHA-256 values make source changes observable.

Code is MIT licensed. Bundled editorial content has a separate [content license](CONTENT-LICENSE.md). Support belongs in the repository's issue tracker; omit credentials and private logs from reports.
