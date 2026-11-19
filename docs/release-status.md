# Toolkit distribution status

As of 14 September 2026, the source repository, npm package, hosted endpoint, official MCP Registry entry and Smithery listing are public. Glama submissions await moderation. The website landing and its Markdown version are public.

| Channel | Verified state | Remaining dependency |
| --- | --- | --- |
| [Source repository](https://github.com/ipvolt/proxy-toolkit-mcp) | Public; npm source tagged [`v0.1.0`](https://github.com/ipvolt/proxy-toolkit-mcp/releases/tag/v0.1.0) | None for the initial release |
| [npm `@ipvolt/proxy-toolkit-mcp`](https://www.npmjs.com/package/@ipvolt/proxy-toolkit-mcp) | Version `0.3.0` published on 18 November 2026 through GitHub Actions OIDC trusted publishing, with an SLSA provenance statement, and tagged `latest`; a fresh installation lists the four tools without a key, eleven with `IPVOLT_API_KEY` and eleven, simulated, with `IPVOLT_SANDBOX=1`. `0.1.0` and `0.2.0` stay published | None; [evidence](npm-publication-2026-09-14.json) |
| Hosted MCP and echo | `https://mcp.ipvolt.com/mcp` live; trusted TLS and all four tools verified | None; [evidence](hosted-publication-2026-09-14.json) |
| [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/0.3.0) | Version `0.3.0` active and latest since 18 November 2026, with the verified remote and npm `0.3.0`; `0.1.0`, `0.1.1` and `0.2.0` stay active | None; [publication run](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/44393970693) |
| [Official MCP Registry, second entry `io.github.ipvolt/account`](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Faccount/versions/1.0.0) | Version `1.0.0` active and latest since 19 November 2026: remote-only, the account server at `https://ipvolt.com/beta/mcp` | None; [publication run](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/44439643555) |
| [Smithery](https://smithery.ai/servers/ipvolt/proxy-toolkit) | Public listing and all four tools visible without signing in | Metadata save returned a permission error; gateway requires Smithery authorization |
| Glama | Source and remote submitted once each on 14 September 2026 | Moderation pending; no public listing URL has been issued |
| PulseMCP | Submission pause confirmed in its browser page on 14 September 2026 | Wait for its submission process to reopen |
| [Website landing](https://ipvolt.com/mcp) and [Markdown](https://ipvolt.com/mcp.md) | Live; public HTML and Markdown verified on 14 September 2026 | None for the initial release |

Update channel states only from actual read-back. Direct endpoint tests do not establish directory gateway compatibility, and directory publication does not establish search indexing or traffic gains.

## Version 0.3.0

Adds a sandbox mode for the seven account tools: a local stdio install started with `IPVOLT_SANDBOX=1` and no key runs them on a simulated account inside the server process, sends no network request and charges nothing. Every answer an account tool gives there is marked `sandbox: true`. The server refuses to start with the sandbox beside `IPVOLT_API_KEY` or `IPVOLT_ENABLE_ROUTE_CHECK=1`. With a key, the tools now accept the `null` fields the API answers for a rental without an order, place or end time, and the `insufficient_balance` hint also names the agent's own top-up.

Source tag [`v0.3.0`](https://github.com/ipvolt/proxy-toolkit-mcp/releases/tag/v0.3.0) on commit `f6e87716a77fb0b297111eb329da593d66ca14fb`; published by [publish workflow run 44393306398](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/44393306398) at `2026-11-18T20:40:04Z`. Read back from npm: `latest` is `0.3.0`, the archive `proxy-toolkit-mcp-0.3.0.tgz` has integrity `sha512-n1AbPG9oqJIiqps4bmRu94WQ+pohPog5IqRYjXh1c9fucZCbCclANX8haTEynEj5NwT+qSb5ELK52R5P4kpOEA==`, and its provenance statement names this repository, `publish.yml`, `refs/tags/v0.3.0` and that commit. A fresh installation of the public version in an empty directory listed four tools without a flag and eleven in sandbox mode, answered eleven sandbox calls (stock, balance, rent preview and confirm, a repeated confirm, list, read, rotate, extend preview and confirm, balance) with nothing on stderr, and refused both combinations at start. The hosted service is unchanged.

## Version 0.2.0

Adds seven optional account tools for local stdio installs with `IPVOLT_API_KEY`: `list_stock`, `get_balance`, `list_rentals`, `get_rental`, `rotate_ip`, `rent_proxy` and `extend_rental`. Source tag [`v0.2.0`](https://github.com/ipvolt/proxy-toolkit-mcp/releases/tag/v0.2.0); published by the [publish workflow](https://github.com/ipvolt/proxy-toolkit-mcp/actions/workflows/publish.yml) through the package's npm trusted publisher (`publish.yml`, environment `npm`, publish only), with provenance. The hosted service is unchanged. The Registry version for npm `0.2.0` followed the same day; see Official Registry versions.

## Account server entry

The Registry entry `io.github.ipvolt/account` version `1.0.0` was published at `2026-11-19T01:48:41Z` from commit `a9a05e6b3f52c74fd941d3c7c86e2d9601f8fab8`, tag `registry-account-v1.0.0`, by `publish-registry-account.yml` through GitHub OIDC ([run 44439643555](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/44439643555)). Before publishing, the guard confirmed the reviewed entry, the merged commit, the unused version and the public remote: asked without a credential, `https://ipvolt.com/beta/mcp` reported server `ipvolt-account` version `1.0.0`, listed the eight account tools and the three per-GB traffic tools, answered `list_stock` and `how_to_buy`, and refused `get_balance` and a `rent_proxy` preview. A separate read-back after the run found the exact entry active and latest: one Streamable HTTP remote and one optional, secret `Authorization` header. The Registry's search for "ipvolt" lists both entries.

The entry lists a server that is not built from this repository. Its version follows the server's own; see [publishing](publishing.md).

## npm artifact and clients

The published archive is `ipvolt-proxy-toolkit-mcp-0.1.0.tgz`, SHA-256 `4848d77611d09a004454577e9a2f3316c420bcbca3a33633ae8a43876ec48f81`. Its public download matches the reviewed upload. An anonymous fresh installation passed all four tool calls on both supported protocol paths. The package source is `7660651b2ee22866db5fa70e3d2b3dee68760c43`; its [CI passed on Node 24.20.0 and 26.8.1](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/34843987983).

Only the README and two package/registry homepage fields changed from the earlier archive tested with Inspector and Claude Code. All 23 other packed files, including runtime and content, match that archive, SHA-256 `57adcee5dd4db1b0a4e11df196c415fcd6de3aa76f540689f399b75e81076339`. See [client evidence](client-compatibility.md) and the [independent implementation review](security-review-2026-09-14.md).

The initial upload used a browser-authenticated maintainer and has no GitHub build provenance. The source release includes the matching archive. Later npm OIDC publication requires the package's Trusted Publisher configuration described in [publishing](publishing.md).

## Hosted release

Release `20260914-mcp-toolkit-rc2`, source `8e9ab8257776cb06c8252c719f576aba3b966fd9`, is active with artifact SHA-256 `aa48c45ee025851925068f9e900e99ee4fb6adb4e780663358f0fdd1f1f5d28b`. An initial activation exposed an HTTP startup defect through the deployment's `current` symlink; automatic rollback preserved the prior state. The corrected entrypoint and candidate check exercise that same symlink path. All 47 toolkit tests and 20 deployment checks passed, including compiled startup/shutdown and inactive-import regressions, with [CI on Node 24 and 26](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/34855809062).

External verification covered eight successful tool calls, rejected local-route dispatch, echo nonce and forwarded-header boundaries, hidden health, methods, CORS and response directives. The npm `0.1.0` archive and its stdio behavior are unchanged; the hosted release is independently identified by its source commit and artifact hash.

## Official Registry versions

The initial npm-only Registry `0.1.0` was published through GitHub OIDC from metadata revision `7c21c2b81dc9a75759e556d6611bcb017fdc540b`, tag `registry-npm-v0.1.0`. Its [publication workflow](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/34846480414) passed, and independent read-back confirmed the exact npm-only manifest. That immutable version remains active and unchanged, with `isLatest=false`.

Combined Registry `0.1.1` was published at `2026-09-14T14:50:56.514389Z` from reviewed metadata `5e0b7cd707ddf90bc9015c5c83946f9c46cdb564`, tag `registry-hosted-v0.1.1`. Its [OIDC publication workflow](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/34858211777) passed the source/npm/version guards, 16 focused checks, eight fresh public tool calls and exact-version read-back. Independent verification confirmed active/latest state and the exact npm and remote metadata. npm `0.1.0` was not republished.

Registry `0.2.0` was published at `2026-11-18T19:34:34Z` from metadata commit `18f5e1611f1aad53f86341f4a87beff5c2b9e135`, tag `registry-v0.2.0`, by `publish-registry-release.yml` through GitHub OIDC. It names npm `0.2.0` and the unchanged hosted remote, and its description reads "Rent and manage ipvolt mobile proxies locally with an API key; proxy setup guides and diagnostics." Before publishing, the [run](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/44381799863) checked that the commit is merged and descends from `v0.2.0`, that npm's provenance statement for `0.2.0` names this repository, `publish.yml`, that tag, its commit and the archive's digest, that the Registry answered for `0.1.1` and did not hold `0.2.0`, and that the hosted remote answered eight tool calls. Its read-back and a separate read of the Registry's public search confirmed `0.2.0` as active and latest with the exact metadata. The hosted server itself is unchanged: release `20260914-mcp-toolkit-rc2`, four tools, reporting version `0.1.0`. Directories that copy the Registry or this repository pick the new text up on their own schedule; none was resubmitted.

Registry `0.3.0` was published at `2026-11-18T20:43:41Z` from commit `f6e87716a77fb0b297111eb329da593d66ca14fb`, tag `registry-v0.3.0`, by the same workflow ([run 44393970693](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/44393970693)), after the same checks against npm `0.3.0` and its provenance. It names npm `0.3.0` and the unchanged hosted remote, lists the new `IPVOLT_SANDBOX` variable, and its description reads "Rent and manage ipvolt mobile proxies locally with an API key, or try a no-key sandbox; proxy docs." The run's read-back and a separate read of the Registry's public search confirmed `0.3.0` as active and latest. No directory was resubmitted.

## Directory limitations

Submission receipts, exact public read-back and gateway results are recorded in [directory evidence](directory-publication-2026-09-14.json).

Smithery scanned the live endpoint and published `ipvolt/proxy-toolkit`. Its public page returns HTTP 200 and exposes all four hosted tool names. Attempts to initialize its advertised gateway without Smithery authorization returned HTTP 401; discovery and tool calls through that gateway remain unverified. The direct ipvolt endpoint requires no account or API key. Smithery's metadata save returned a permission error despite the current workspace showing Admin access. The display name remains `proxy-toolkit`, and the description, homepage and repository fields remain empty. Correct these through the normal editor once the platform permission problem is resolved; do not create another release or purchase optional verification to retry a metadata edit.

Glama confirmed both the GitHub source submission and the remote connector submission as received for review. No public source or connector URL has been issued, and no acceptance is claimed. Do not resubmit either item while moderation is pending.

PulseMCP's [submission page](https://www.pulsemcp.com/submit) still displayed its 3 September 2026 pause notice when checked on 14 September. It says it will pick up Official MCP Registry entries after reopening. No PulseMCP submission was made.
