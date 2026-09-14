# Toolkit distribution status

As of 14 September 2026, the source repository, npm package, hosted endpoint, official MCP Registry entry and Smithery listing are public. Glama submissions await moderation. The website landing and its Markdown version are public.

| Channel | Verified state | Remaining dependency |
| --- | --- | --- |
| [Source repository](https://github.com/ipvolt/proxy-toolkit-mcp) | Public; npm source tagged [`v0.1.0`](https://github.com/ipvolt/proxy-toolkit-mcp/releases/tag/v0.1.0) | None for the initial release |
| [npm `@ipvolt/proxy-toolkit-mcp`](https://www.npmjs.com/package/@ipvolt/proxy-toolkit-mcp) | Version `0.1.0` published; exact archive and fresh installation verified | None; [evidence](npm-publication-2026-09-14.json) |
| Hosted MCP and echo | `https://mcp.ipvolt.com/mcp` live; trusted TLS and all four tools verified | None; [evidence](hosted-publication-2026-09-14.json) |
| [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/0.1.1) | Version `0.1.1` active and latest, with the verified remote and npm `0.1.0` | None; [publication evidence](../registry/hosted/publication-2026-09-14.json) |
| [Smithery](https://smithery.ai/servers/ipvolt/proxy-toolkit) | Public listing and all four tools visible without signing in | Metadata save returned a permission error; gateway requires Smithery authorization |
| Glama | Source and remote submitted once each on 14 September 2026 | Moderation pending; no public listing URL has been issued |
| PulseMCP | Submission pause confirmed in its browser page on 14 September 2026 | Wait for its submission process to reopen |
| [Website landing](https://ipvolt.com/mcp) and [Markdown](https://ipvolt.com/mcp.md) | Live; public HTML and Markdown verified on 14 September 2026 | None for the initial release |

Update channel states only from actual read-back. Direct endpoint tests do not establish directory gateway compatibility, and directory publication does not establish search indexing or traffic gains.

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

## Directory limitations

Submission receipts, exact public read-back and gateway results are recorded in [directory evidence](directory-publication-2026-09-14.json).

Smithery scanned the live endpoint and published `ipvolt/proxy-toolkit`. Its public page returns HTTP 200 and exposes all four hosted tool names. Attempts to initialize its advertised gateway without Smithery authorization returned HTTP 401; discovery and tool calls through that gateway remain unverified. The direct ipvolt endpoint requires no account or API key. Smithery's metadata save returned a permission error despite the current workspace showing Admin access. The display name remains `proxy-toolkit`, and the description, homepage and repository fields remain empty. Correct these through the normal editor once the platform permission problem is resolved; do not create another release or purchase optional verification to retry a metadata edit.

Glama confirmed both the GitHub source submission and the remote connector submission as received for review. No public source or connector URL has been issued, and no acceptance is claimed. Do not resubmit either item while moderation is pending.

PulseMCP's [submission page](https://www.pulsemcp.com/submit) still displayed its 3 September 2026 pause notice when checked on 14 September. It says it will pick up Official MCP Registry entries after reopening. No PulseMCP submission was made.
