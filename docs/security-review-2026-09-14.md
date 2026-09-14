# Independent implementation review — 14 September 2026

No blocking finding remains in the reviewed implementation revision. This records a source review, controlled regression checks and artifact inspection; it does not establish production activation, registry publication or the absence of all defects.

The reviewer implemented the local route checker, so that implementation is excluded from this independent review. A different agent reviewed it and recorded [separate route evidence](../deploy/route-review-2026-09-14.json). This review covers the public catalog, configuration templates, diagnostics, MCP server and transports, protocol error handling, package/registry metadata, release workflows and deployment tooling.

The reviewed npm archive is `ipvolt-proxy-toolkit-mcp-0.1.0.tgz`, SHA-256 `57adcee5dd4db1b0a4e11df196c415fcd6de3aa76f540689f399b75e81076339`. All 26 packed files matched the corresponding checkout files byte for byte. The archive contains compiled runtime/declarations, the public content catalog, package and server metadata, README and licenses. It excludes source tests, deployment scripts, development dependencies, Git history, environment files and operational application data. The public catalog contains 23 documents from source release `20260914-hero-split`.

Checks independently performed on Node 24.20.0, macOS arm64:

| Check | Observed result |
| --- | --- |
| `node --import tsx --test tests/security-review.test.ts` | 10 passed, none failed or skipped. |
| `IPVOLT_DEPLOY_NODE=/path/to/node-24/bin/node python3 -m unittest -v deploy/test_release.py` | 18 passed, including the actual Node HTTP service through the production Python health client. |
| Catalog reconstruction and tampering | Every document reconstructed exactly across continuation chunks; each structured chunk was below 16 KiB. Bundle/document hash changes, stale cursors and private or traversal paths were rejected. |
| Protocol and transport boundaries | Explicitly pinned `2025-11-25` and `2026-07-28` calls passed over stdio and HTTP. Both expose four public tools, preserve object-root schemas and suppress rejected secret-shaped inputs in protocol errors. |
| Generated Playwright debug regression | With `DEBUG=pw:*`, the exact generated template exited before importing Playwright or reading proxy credentials; output was the fixed `unsafe_debug_environment` category with no credential sentinel. |
| HTTP deadline recovery | An incomplete request received 408 and its socket closed; the next valid request succeeded with concurrency limited to one. |
| Archive and client evidence | Every recorded installed runtime/content hash in both real-client evidence files matched the reviewed archive and checkout. |

The following reproduced issues were corrected and rechecked during review:

| Original failure | Verified correction |
| --- | --- |
| Published integration guides disappeared from `topic: "setup"` search. | The exporter maps the public Integration category to setup; five client setup searches return results. |
| SDK validation errors reflected unknown argument keys and tool names before application error handling. | Shared outbound error handling sanitizes stdio and HTTP JSON/SSE responses while preserving required protocol metadata and safe application results. |
| Static tool discovery advertised change subscriptions that the service did not support. | `tools.listChanged` is false, and current-protocol clients no longer attempt an unsupported subscription. |
| Browser preflight omitted `MCP-Name`; an empty Origin was treated as absent. | The header is allowlisted and explicitly supplied invalid origins are rejected. |
| A trusted-proxy health request could carry an external peer address. | The private health boundary rejects it; Caddy exposes only the two public machine routes. |
| Sanitized modern errors lost `resultType`, and unsupported-version errors lost typed negotiation data. | Current results retain completion metadata; bounded date-shaped requested versions and supported versions retain the SDK's typed error behavior. |
| Playwright debug logging exposed proxy options before a request error could be caught. | A guard precedes dynamic import and credential reads; actual debug subprocess regressions are recorded with the template fixtures. |
| Deployment health treated legacy SSE discovery as JSON, rejecting a healthy service. | The bounded parser accepts JSON and request-scoped SSE, and a real-service integration test now runs in CI. |

Deployment review confirmed that `validate` and `activate` share the guarded artifact/current-release/Node/Caddy preflight and isolated candidate startup. Validation has no DNS/public TLS check, Caddy reload or active MCP file cutover. The service starts with an empty inherited environment plus explicit public settings; its startup check requires new loopback connections to fail with `EPERM`. Expected-current checks, immutable artifact verification, managed-file preservation and rollback cases passed in isolated tests. Actual Linux/systemd/Caddy enforcement and public TLS require the guarded host validation and activation checks described in the [runbook](../deploy/README.md).

The [package checker](../scripts/check-package.mjs) uses the invoking Node executable for installed-client calls and puts that executable's directory first for npm/shebang execution. Its saved release report records eight successful calls across the two explicitly pinned protocol versions. The workflows use pinned action revisions and exact Node versions; publication requires the matching version tag and runs the package checks before publishing the tested archive. No stored publishing token or install hook is introduced. Registry metadata, package identity and version agree; declared channels remain candidates until public read-back.

The real Inspector and Claude runs were performed by another agent. This reviewer inspected their harnesses and sanitized results and verified their archive/runtime hash binding; they were not independently repeated here. Their [compatibility report](client-compatibility.md) accurately limits the claim to the tested versions, transports and calls. Inspector reported zero errors and one nullable-schema warning per strict discovery operation. Both tested clients accepted that valid schema. Claude's negotiated protocol version was not separately captured. No desktop-client, public gateway or live proxy compatibility claim follows from these checks.

Revision binding for reviewed source and verification entrypoints:

| File | SHA-256 |
| --- | --- |
| `src/core/catalog.ts` | `1da405ac7552fc7c2484535f79a9dbdb6f4e0d424c0fd419aad9d283c4767946` |
| `src/core/config.ts` | `dbdb36e20683d8756c9c64f29fee0274978ab081aa9d2a6983b6f58e6c00de33` |
| `src/core/diagnostics.ts` | `549e29428d1b3012df74ae83c4fdb0b993d028541ae3170f330be1e06d6cf172` |
| `src/server.ts` | `9d750eb21ebabfc21e699a218274c05895327b36fba01855196839c0216bbcd3` |
| `src/transports/http.ts` | `fb2fdfba4e6acf7cf3ae159cebca7cdf2e0455a339e2bdc54fa792196c45b3d7` |
| `src/transports/stdio.ts` | `7d83b2e35d53cf91d0b78bd001675e130bd09be954e8ef1c97072e6b9584d991` |
| `src/protocol-safety.ts` | `43cdeaae45ec250d8481a53d0a911f7c5ffbe2d225713a88c4ec9086397067d0` |
| `package.json` | `6496ab650cb82a92651c1d39c4c8a9a4e17eacfb69d7bcb8ad3f2982371e7c6a` |
| `server.json` | `71dfab2b655ce27045a2a6e25b2b248ab23e54fbb64d2534f2a4150de68e9aa0` |
| `scripts/check-package.mjs` | `461f245ea5747a1e503cbd2feb22c30c00a261f76eb5293518c7198715ef858f` |
| `.github/workflows/ci.yml` | `beeef02614108ec74a278fc3acaf2a7dc0375e4488548ed0a79c049c5f56e707` |
| `.github/workflows/publish.yml` | `259d56a2b3d9eaca72ed80f42fdacc4801b74106a9cd10d9031a929da0d6e80d` |
| `deploy/release.py` | `74f3908000f986b25f0c7609b35970882492d62a22f7dfc868f6a2e4310f525e` |
| `deploy/ipvolt-mcp.service` | `2a3df8e68c5f1765185a0b81fbae218964b480a210b12d511fa71e70d72ed311` |
| `deploy/ipvolt-mcp.caddy` | `32a303d8fbfd7be44819ba24c1262f664bd310ea4bc63019977a8330e2e3a905` |
| `deploy/check-host-isolation.mjs` | `c6fa074220fb71c9885c0f79ddbdbaedd645c88027c855ec800bd67289299a0a` |
| `deploy/test_release.py` | `5504ebd59ad8c6f7f31b63ae075a963e043a72c23bba2df9d075de3f949a885c` |
| `tests/security-review.test.ts` | `76fb7cdc6514c459285a07d97a5c26edbd249717beac71638eb3577f3be1ea49` |

Later changes to these files or the archive need a review of the affected evidence. Public deployment and publication status belongs in [release status](release-status.md), separately from this implementation review.
