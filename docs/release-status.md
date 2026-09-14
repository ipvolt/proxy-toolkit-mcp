# Release candidate0.1.0

As of14 September2026, this repository contains the implementation candidate. Publication and public endpoint availability have not been established.

| Channel | State | Remaining dependency |
| --- | --- | --- |
| Source repository | Local candidate | Independent review, clean public history and push |
| npm `@ipvolt/proxy-toolkit-mcp` | Unpublished | Owner creating the ipvolt npm account; verify namespace and publishing access |
| Hosted MCP and echo | Undeployed | DNS for `mcp.ipvolt.com`, host validation and coordinated cutover |
| Website `/mcp` and `/mcp.md` | Reviewed candidate | Select and freeze a website release batch |
| Official MCP Registry | Validated metadata draft | Verify npm package and remote endpoint, then publish and read back |
| Smithery | Submission preparation | Verify endpoint and publisher access |
| Glama | Submission preparation | Verify public source/endpoint and ownership |
| PulseMCP | Deferred | Submissions are paused under its3 September2026 notice; recheck before submitting |

Update this table only from actual channel read-back. SDK tests and localhost clients establish implementation compatibility; they do not establish live directory discovery, public TLS or production proxy routing.
