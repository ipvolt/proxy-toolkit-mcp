# Release candidate0.1.0

As of 14 September 2026, the reviewed source is public. npm, registry listings and the public hosted endpoint remain pending.

| Channel | State | Remaining dependency |
| --- | --- | --- |
| Source repository | [Public source](https://github.com/ipvolt/proxy-toolkit-mcp), reviewed core revision `71cdd37` | [CI passed](https://github.com/ipvolt/proxy-toolkit-mcp/actions/runs/34841591288) on Node 24.20.0 and 26.8.1 |
| npm `@ipvolt/proxy-toolkit-mcp` | Unpublished | Owner creating the ipvolt npm account; verify namespace and publishing access |
| Hosted MCP and echo | Inactive VPS candidate validated | DNS for `mcp.ipvolt.com` and coordinated public cutover |
| Website `/mcp` and `/mcp.md` | Reviewed candidate | Select and freeze a website release batch |
| Official MCP Registry | Validated metadata draft | Verify npm package and remote endpoint, then publish and read back |
| Smithery | Submission preparation | Verify endpoint and publisher access |
| Glama | Submission preparation | Verify public source/endpoint and ownership |
| PulseMCP | Deferred | Submissions are paused under its3 September2026 notice; recheck before submitting |

Update this table only from actual channel read-back. SDK tests and localhost clients establish implementation compatibility; they do not establish live directory discovery, public TLS or production proxy routing.

The clean npm archive is `ipvolt-proxy-toolkit-mcp-0.1.0.tgz`, SHA-256 `57adcee5dd4db1b0a4e11df196c415fcd6de3aa76f540689f399b75e81076339`. It passed clean installation, both supported protocol paths, Inspector and Claude Code. See [client evidence](client-compatibility.md) and the [independent implementation review](security-review-2026-09-14.md).

The inactive VPS release `20260914-mcp-toolkit-rc1` passed the actual guarded `validate` action on Node 24.20.0, Caddy 2.11.4 and systemd 259.5. It started under the nonroot service restrictions, required outbound `connect()` to return `EPERM`, verified health and exactly four hosted tools, and removed its temporary unit. Its runtime artifact SHA-256 is `e428227559bebfb49c6f0e833dcaefac5b5a381d3570d01f6b14eb41eec9bb09`. No active MCP current link, environment or service unit exists; Caddy and the website remain active, with website release `20260914-hero-fixes` preserved. DNS and public TLS were deliberately outside this inactive validation.
