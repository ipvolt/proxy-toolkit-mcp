# Release 0.1.0 distribution status

As of 14 September 2026, the reviewed source, npm package and official MCP Registry entry are public. The hosted endpoint and other directory submissions remain pending.

| Channel | State | Remaining dependency |
| --- | --- | --- |
| Source repository | [Version 0.1.0 release](https://github.com/ipvolt/proxy-toolkit-mcp/releases/tag/v0.1.0), source revision `7660651` | [CI passed](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/34843987983) on Node 24.20.0 and 26.8.1 |
| npm `@ipvolt/proxy-toolkit-mcp` | [Version 0.1.0 published](https://www.npmjs.com/package/@ipvolt/proxy-toolkit-mcp) | Public metadata, archive hash and fresh installation verified; [evidence](npm-publication-2026-09-14.json) |
| Hosted MCP and echo | Inactive VPS candidate validated | DNS for `mcp.ipvolt.com` and coordinated public cutover |
| Website `/mcp` and `/mcp.md` | Reviewed candidate | Select and freeze a website release batch |
| Official MCP Registry | [Version 0.1.0 active and latest](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/0.1.0) | npm-only distribution verified; [publication evidence](../registry/npm/publication-2026-09-14.json) |
| Smithery | Submission preparation | Verify endpoint and publisher access |
| Glama | Submission preparation; account login required by the actual form | Sign in for the source listing; connector also needs the hosted endpoint |
| PulseMCP | Deferred | Submissions are paused under its3 September2026 notice; recheck before submitting |

Update this table only from actual channel read-back. SDK tests and localhost clients establish implementation compatibility; they do not establish live directory discovery, public TLS or production proxy routing.

The published npm archive is `ipvolt-proxy-toolkit-mcp-0.1.0.tgz`, SHA-256 `4848d77611d09a004454577e9a2f3316c420bcbca3a33633ae8a43876ec48f81`. The public npm download matches those exact reviewed bytes. An anonymous fresh installation passed all four tool calls on both supported protocol paths. Its README and two package/registry homepage fields were updated for distribution; all 23 other packed files, including runtime and content, match the earlier archive `57adcee5dd4db1b0a4e11df196c415fcd6de3aa76f540689f399b75e81076339` tested with Inspector and Claude Code. See [client evidence](client-compatibility.md) and the [independent implementation review](security-review-2026-09-14.md).

The initial npm upload used a browser-authenticated maintainer and has no GitHub build provenance. The source tag `v0.1.0` points to the reviewed package source and the release includes the matching archive. Later OIDC npm publication requires the package's Trusted Publisher configuration described in [publishing](publishing.md).

The official Registry release was published through GitHub OIDC from metadata revision `7c21c2b81dc9a75759e556d6611bcb017fdc540b`, tag `registry-npm-v0.1.0`. Its [publication workflow](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/34846480414) passed all steps, and an independent public read-back confirmed the exact local package, active/latest state and absence of the pending remote endpoint. The Registry entry does not claim a hosted service is live.

The inactive VPS release `20260914-mcp-toolkit-rc1` passed the actual guarded `validate` action on Node 24.20.0, Caddy 2.11.4 and systemd 259.5. It started under the nonroot service restrictions, required outbound `connect()` to return `EPERM`, verified health and exactly four hosted tools, and removed its temporary unit. Its runtime artifact SHA-256 is `e428227559bebfb49c6f0e833dcaefac5b5a381d3570d01f6b14eb41eec9bb09`. The validation installed no active MCP current link, environment or service unit and preserved the then-current website release `20260914-hero-fixes`. The website subsequently changed independently; refresh its actual current release before activation. DNS and public TLS were outside this inactive validation.
