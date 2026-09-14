# Configuration execution fixtures

`run-templates.ts` executes the exact generated examples against a temporary localhost HTTPS origin and an authenticated HTTP CONNECT proxy. It does not contact a live supplier or arbitrary remote target. Certificates, keys and generated scripts are created in an OS temporary directory and removed when the test finishes.

The frozen compatibility matrix is curl 8.22.0 (macOS OpenSSL 3.6.4), Requests 2.34.2 and HTTPX 0.28.1 on Python 3.14.7, and Playwright 1.63.0 APIRequestContext on Node 24.20.0. This is an exact tested matrix, not a claim that all releases/platforms or browser navigation work. The script checks these versions before running. If curl 8.22.0 is outside `PATH`, select its absolute path with `IPVOLT_TEMPLATE_CURL`.

Install the external fixture dependencies in a disposable directory, without changing the toolkit's runtime dependency set:

```sh
python3 -m venv /your/temporary/fixture-deps/venv
/your/temporary/fixture-deps/venv/bin/pip install requests==2.34.2 httpx==0.28.1
npm install --prefix /your/temporary/fixture-deps --ignore-scripts --no-audit --no-fund playwright@1.63.0
```

Run from the toolkit repository using the tested Node version. `openssl`, `/bin/sh` and curl must be available. The fixture never downloads dependencies itself.

```sh
IPVOLT_TEMPLATE_PYTHON=/your/temporary/fixture-deps/venv/bin/python \
IPVOLT_TEMPLATE_PLAYWRIGHT_MODULES=/your/temporary/fixture-deps/node_modules \
node --import tsx tests/template-fixtures/run-templates.ts
```

For each generated template the script checks authenticated CONNECT, explicit routing despite hostile proxy environment variables and `NO_PROXY=*`, no redirects, failed authentication without fallback, an unavailable proxy without fallback, untrusted TLS rejection, bounded response timeout, unsupported proxy protocol rejection, and credential sentinels absent from stdout/stderr. Public output records versions and check names only. Requests/HTTPX timeout settings are phase/inactivity budgets; they are not claimed to be total wall-clock deadlines.

The Playwright example configures `APIRequestContext`, not a browser. APIRequestContext buffers responses, so its template is intended for small authorized diagnostic targets. It can expose a proxy's 407 as a response instead of throwing; the fixture accepts that explicit status while asserting that the origin was not reached. Generated templates deliberately print only status or a bounded failure category.

The Playwright template rejects nonempty `DEBUG`, `NODE_DEBUG`, `NODE_DEBUG_NATIVE`, disabled TLS verification and TLS tracing/key logging before importing Playwright or reading proxy credentials. Seven real subprocess cases include `DEBUG=pw:*`, which otherwise exposes proxy options through Playwright's debug channels. The guard cases assert a fixed failure category, no credential sentinel and no network request. Clear these settings before starting the example; do not rely on catching request errors to redact a library's earlier debug output.

Primary API references used while implementing the templates:

- [curl manual](https://curl.se/docs/manpage.html)
- [Requests advanced usage](https://requests.readthedocs.io/en/latest/user/advanced/)
- [HTTPX proxies](https://www.python-httpx.org/advanced/proxies/), [timeouts](https://www.python-httpx.org/advanced/timeouts/) and [exceptions](https://www.python-httpx.org/exceptions/)
- [Playwright APIRequest](https://playwright.dev/docs/api/class-apirequest) and [APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext)
