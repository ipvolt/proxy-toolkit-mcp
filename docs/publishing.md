# Publishing the toolkit

The release consists of independently versioned source, npm artifact, hosted service, website landing and registry metadata. Keep their actual states in [release status](release-status.md); a prepared manifest is not a published listing. Website/reporting changes use the project's selected, frozen batch and shared deployment guard.

## Account and immutable source

Use an ipvolt-owned npm account with verified business email and2FA. Confirm the username or organization controls `@ipvolt` before publication. Authenticate the dedicated publishing identity through npm's browser login; keep its credential storage outside source. Passwords and recovery codes belong in the owner's password manager.

Push only this clean toolkit repository to `ipvolt/proxy-toolkit-mcp`. Never publish the private website/operations repository or its history. Record the reviewed commit, passing CI, package version, catalog revision, client evidence and packed SHA-256. Keep package.json and server.json names/versions aligned.

## npm

`npm run check:package -- --output-dir .artifacts` produces the exact tested tarball and a JSON integrity report. Install and verify that tarball before any publish.

For the initial account bootstrap, a browser-authenticated maintainer can publish that tarball from the dedicated account with `npm publish PATH_TO_REVIEWED_TARBALL --access public --provenance=false`. Local publication cannot obtain GitHub build provenance; record that limitation. Complete any npm authentication challenge through the owner's browser. Do not create or paste a general publishing token into chat.

After the package exists, configure its npm Trusted Publisher:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization/user | `ipvolt` |
| Repository | `proxy-toolkit-mcp` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed action | Direct `npm publish` |

The checked-in workflow is manually dispatched against the reviewed `vVERSION` tag, verifies the matching immutable version and tests the packed artifact before publishing it with OIDC and provenance. It uses no stored npm token. npm requires a supported GitHub-hosted runner, Node22.14+ and npm11.5.1+; this workflow pins Node24.20.0 and the host's current npm meets that requirement. Verify the repository's configured trust relationship before the first run. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

Read back the public version, `mcpName`, repository URL and `dist.integrity` from npm. Install that public exact version in a fresh consumer and repeat discovery/tool calls. An uploaded package alone does not establish installation success. Versions are immutable: correct defects with a new version and deprecate a defective one when appropriate.

## Hosted service and website

DNS must resolve `mcp.ipvolt.com` to the VPS, and Caddy must obtain a valid public certificate. Use the [guarded deployment entrypoint](../deploy/README.md) against the exact current website and MCP releases. Verify public discovery and a real public tool call, strict TLS, echo nonce semantics, absence of the local tool, limits, no public health route and no access/body logging.

Enable only verified channels in the separately reviewed website content settings. Release `/mcp`, `/mcp.md`, its narrow reporting migration and matching discovery/privacy changes in the selected website batch. Check those URLs before using them as directory landing links.

## Official MCP Registry

The identity is `io.github.ipvolt/proxy-toolkit`. The published npm artifact contains the matching `mcpName`. The first Registry release uses `registry/npm/server.json`, which derives from the reviewed package manifest with the inactive remote omitted. The root `server.json` is the original combined-channel draft for Registry version `0.1.0`; that version has already been published using the npm-only manifest and cannot be overwritten. The published combined distribution uses `registry/hosted/server.json`, Registry `0.1.1` with the unchanged npm `0.1.0` package and verified remote. The registry hosts metadata; it does not host the npm code. [Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)

The official publisher release inspected for this candidate is1.8.1. Its Linux/amd64 archive is:

```text
https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/mcp-publisher_linux_amd64.tar.gz
sha256:a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc
```

Download into an isolated temporary directory, verify that digest before extracting/executing, and keep publisher authentication state outside the repository. The manually dispatched `publish-registry.yml` uses `login github-oidc` with `id-token: write` and no stored registry secret. It requires the separate tag `registry-npm-v0.1.0` and `reviewed_commit` matching the full reviewed metadata/workflow commit, verifies the exact public npm archive, refuses an already published Registry version, and reads back the active listing after a single publish attempt. The npm source tag stays `v0.1.0`; the registry workflow does not publish npm. [Registry Actions authentication](https://modelcontextprotocol.io/registry/github-actions)

Registry versions and their metadata are immutable. The verified remote was added in Registry `0.1.1`, continuing to reference the unchanged npm `0.1.0`. Its dedicated `publish-registry-hosted.yml` workflow requires the frozen `registry-hosted-v0.1.1` tag and reviewed integration commit, verifies the existing npm archive and prior Registry entry, rejects an already published target version, and exercises all four public tools on both protocols immediately before one publish attempt. This release is complete; any later metadata change needs a separately reviewed new Registry version and guard update. Never rerun either completed release to overwrite it. [Registry versioning](https://modelcontextprotocol.io/registry/versioning)

Later Registry versions use the root `server.json`, whose version equals the npm version it names, and the manually dispatched `publish-registry-release.yml`. Tag the reviewed metadata commit `registry-vVERSION` and dispatch the workflow on that tag with the same commit as `reviewed_commit`. `registry/release/check.py` then requires that the commit is merged into `main` and descends from the source tag `vVERSION`; that npm serves that exact version with this package's identity, and that the provenance statement npm stores for it names this repository, `publish.yml`, that tag, the tag's commit and the archive's digest; that the Registry still answers for the known version `0.1.1` and does not hold the new version; and that the hosted remote answers all four tools on both protocol paths. After publishing it reads the exact version back as active and latest. The provenance check compares the statement npm serves and does not verify its Sigstore signature, which npm checks at publication. The workflow has no protected environment: anyone who can push a tag to this repository can dispatch it, as with the two frozen workflows. `registry/hosted/check-remote.mjs` pins the hosted server's content bundle and runtime version, so a hosted redeploy needs that file re-pinned before the next Registry release. Versions `0.1.0` and `0.1.1` stay with their frozen workflows and are refused here. A change of description alone still needs a new npm version, because the two numbers are kept equal.

### Second entry: the ipvolt account server

`io.github.ipvolt/account` is a separate Registry entry for a separate server: the MCP endpoint inside the ipvolt customer app at `https://ipvolt.com/beta/mcp`. Its source is not in this repository and it has no package, so the entry in `registry/account/server.json` is remote-only and names no repository. It is not the hosted toolkit at `mcp.ipvolt.com`, which keeps its own entry, takes no key and has no account tools.

Its version is the version the server itself reports in `initialize`. Publish a new Registry version only when that changes or the reviewed texts change. Tag the reviewed, merged metadata commit `registry-account-vVERSION` and dispatch `publish-registry-account.yml` on that tag with the same commit as `reviewed_commit`. `registry/account/check.py` then requires that the entry is exactly the reviewed one (name, title, website, the one remote and its one optional, secret `Authorization` header; only the version and the two texts may differ, and the texts may hold no key-shaped value and none of the words the website's claims rule out); that the commit is merged into `main`; that the Registry still answers for the known toolkit version `0.1.1` and does not hold this entry's version; and that the public remote, asked without a credential by `registry/account/check-remote.mjs`, reports that same version, lists the reviewed tools (three of them only while per-GB traffic is on sale), announces no spending tool as read-only, answers `list_stock` and `how_to_buy`, and refuses `get_balance` and a `rent_proxy` preview. After publishing it reads the exact version back as active and latest. The check never sends a credential and spends nothing.

The toolkit's tags and workflows cannot publish this entry, and this workflow cannot publish the toolkit's: each guard accepts only its own tag, workflow file and manifest. As with the other Registry workflows there is no protected environment, and no publish retry: an uncertain result is resolved by read-back.

## Smithery and Glama

Use the display name **ipvolt Proxy Toolkit**, description from server.json, public repository URL, and verified remote URL `https://mcp.ipvolt.com/mcp`. The remote requires no account, key or proxy credential. Describe the local route tool as optional and local only. Use the live homepage until `/mcp` is actually batch-released. Afterward, use a directory-specific campaign link to `/mcp` only where a listing supports website links; retain clean canonical links inside tool output.

Smithery accepts a public HTTPS Streamable HTTP URL through its publishing page or `smithery mcp publish "https://mcp.ipvolt.com/mcp" -n @ipvolt/proxy-toolkit`. Verify namespace access first. It scans the remote tools and its gateway may mediate subsequent calls. Test discovery and a tool call through the resulting directory URL; the direct endpoint test does not cover this path. [Smithery publishing](https://smithery.ai/docs/build/publish)

Glama accepts a public GitHub repository for the source listing and a healthy HTTPS Streamable HTTP URL for the connector. Its Add Server form currently requires a Glama account; the root `glama.json` identifies GitHub user `ipvolt` as the source maintainer. Submit the matching source and remote without implying that the remote exposes the local diagnostic. Claim ownership through the matching GitHub identity when available. A directory gateway has its own logging/data handling; ipvolt's no-body-log policy applies to ipvolt's service, not third-party gateways. [Glama submission and ownership](https://glama.ai/mcp/faq)

PulseMCP paused submissions and updates in its3 September2026 notice. Recheck its actual submission page before proceeding; do not claim acceptance or create duplicate listings to work around the pause. [PulseMCP submissions](https://www.pulsemcp.com/submit)

Record each actual listing URL, submitted revision, pending/accepted state, public read-back and direct/gateway compatibility result. Directory inclusion and search ranking effects remain outcomes to measure, not release guarantees.
