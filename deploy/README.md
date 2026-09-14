# Hosted deployment

These files deploy the anonymous hosted toolkit independently of the ipvolt website, admin, board and customer services. The installer accepts a prebuilt, reviewed runtime artifact. It does not build as root, submit registry entries, change DNS or deploy a website batch.

Production activation has **not** been performed by these offline tests. Validate the actual Caddy 2.11.4/systemd 259 host configuration and candidate service before launch. The deployment entrypoint performs that validation under the shared guard; the local simulation is not a substitute for it.

The fixed endpoint is `https://mcp.ipvolt.com/mcp`. Node listens on `127.0.0.1:3040` as the dedicated nonlogin `ipvolt-mcp` account. Caddy exposes only `/mcp` and `/egress`; `/healthz` remains local. The MCP hostname must resolve directly to the explicitly reviewed host address before `activate` can proceed. The installer makes no DNS changes. Preserve unrelated DNS and mail records when arranging the hostname.

The current deployment runtime is `/usr/local/bin/node`, Node 24.20.0. Confirm the actual host value before release; `activate --node` accepts a reviewed root-owned Node 24 executable and validates its resolved parent directories. The unit clears inherited environment variables using `env -i` and forwards only its listed public configuration fields. The environment file must not contain application, supplier, board, mailbox or proxy credentials.

The unit applies filesystem/process/resource restrictions, denies nonloopback IP traffic and denies the `connect` syscall, including new connections to other loopback applications. A startup check requires a harmless loopback connection attempt to fail with `EPERM`; a missing syscall restriction prevents startup. Replying on an accepted Caddy connection remains possible. Kernel IP filtering support and the complete unit must still be verified on the host. The service needs no application database or outbound request capability.

Caddy overwrites `X-IPVolt-Peer` with `{http.request.remote.host}`, the actual connection peer. It does not trust supplied forwarding headers for the echo address. Putting a CDN or another external reverse proxy in front changes the observed peer and requires a separately reviewed design. `log_skip` disables access logging for this hostname; no request arguments, query strings, diagnostic IPs or nonces are application metrics. The application emits bounded JSON tool metrics and startup information. Do not enable request/debug logging. `handle_errors` produces a fixed response instead of exposing proxy failure detail.

Prepare a clean runtime artifact from the reviewed revision as an unprivileged build account. Use Node 24, run the repository's build and checks, inspect the npm package separately, and copy only the following into a new artifact directory:

```text
dist/ content/ node_modules/ package.json package-lock.json
LICENSE CONTENT-LICENSE.md README.md server.json deploy/
```

Install production dependencies in that separate artifact directory with `npm ci --omit=dev --ignore-scripts --bin-links=false`. Use a clean export of `deploy/` without `__pycache__` or `.pyc` files. The installer rejects symlinks, environment/npm credential files, Python bytecode and unexpected file types. It intentionally does not copy source checkouts, Git history, local secrets or unrelated application data. The artifact must already include the compiled HTTP entrypoint and reviewed content bundle. Record the source revision and checks with the release evidence before proceeding.

Before any VPS mutation, read the project discussion and relevant task threads, process pause/handoff requests, claim the release task and agree on the cutover owner. Website edits belong in their selected, frozen website batch. Read the current website and MCP symlinks, review that exact state, and choose unique release identifiers. Do not automatically discover and substitute a newer expected value to bypass a conflict.

The canonical shared `/usr/local/sbin/ipvolt-deploy-guard` must already be installed by the project's authorized operator. Every CLI action below acquires or inherits that guard automatically. Its descriptor remains inherited throughout staging, candidate validation, active mutations, restart and rollback. No unguarded CLI mode exists.

Stage the reviewed runtime artifact on the VPS, replacing the uppercase arguments with reviewed values:

```sh
sudo python3 /path/to/reviewed/deploy/release.py stage \
  --source /path/to/prebuilt-runtime \
  --release UNIQUE_MCP_RELEASE \
  --expected-website REVIEWED_WEBSITE_RELEASE \
  --expected-mcp none
```

For an update, supply the reviewed MCP release instead of `none`. Staging uses a new directory under `/opt/ipvolt-mcp/releases/`, writes a file-hash manifest and freezes files to mode 0444/directories to 0555. It never overwrites a release. Record and review the returned `artifactSha256`; validation and activation require that exact hash and recheck both bytes and permissions.

Validate the inactive candidate on the actual VPS even while DNS is pending:

```sh
sudo python3 /path/to/reviewed/deploy/release.py validate \
  --release UNIQUE_MCP_RELEASE \
  --artifact-sha256 REVIEWED_ARTIFACT_SHA256 \
  --expected-website REVIEWED_WEBSITE_RELEASE \
  --expected-mcp none \
  --node /usr/local/bin/node
```

`validate` uses the same guard, expected-current checks, artifact/Node validation, full Caddy parsing and candidate service hardening as activation. It may provision the inert nonlogin account and briefly starts a separate candidate unit on an available loopback port. It removes that candidate unit afterwards. It does not check DNS/public TLS, reload Caddy, or install/change the active MCP unit, environment, current link or active metadata. Success reports `candidateValidated: true` and `activated: false`. A successful validation does not authorize skipping activation's repeated preflight or public checks.

After DNS resolves to the reviewed address, activate:

```sh
sudo python3 /path/to/reviewed/deploy/release.py activate \
  --release UNIQUE_MCP_RELEASE \
  --artifact-sha256 REVIEWED_ARTIFACT_SHA256 \
  --expected-website REVIEWED_WEBSITE_RELEASE \
  --expected-mcp none \
  --expected-dns-address REVIEWED_VPS_ADDRESS \
  --node /usr/local/bin/node
```

The entrypoint refuses unexpected existing account settings, user files, managed edits and systemd drop-ins. For a first installation it may create the dedicated system account after static preflight; if candidate startup fails, that inert nonlogin account remains provisioned. It does not receive a home, credentials or application access.

Before cutover, the entrypoint validates the full existing Caddy configuration and the candidate beside the original file, preserving relative imports. It starts a temporary candidate unit on an available loopback port with the same hardening and clean environment, checks local health/version/content provenance and discovers exactly the four hosted tools. The health client accepts bounded JSON or request-scoped SSE. It then rechecks expected current releases, artifact integrity and managed configuration before installing the unit/environment/current link.

The managed hostname block is appended/replaced within the existing Caddyfile. Existing global options, imports and unrelated sites remain intact. A pre-existing unmanaged MCP host or wildcard requires reconciliation; the fragment is never used as a replacement for the entire Caddyfile. Post-cutover checks require a trusted TLS certificate, prove that Caddy overwrites spoofed peer headers, and confirm `/healthz` is not public. The service restart can cause a short interruption.

Exact previous unit/environment/active metadata and a complete Caddy snapshot are stored in root-only `/var/lib/ipvolt-mcp-deploy/transactions/`. The successful activation returns a transaction identifier. Keep this private operational evidence off registries and public issue threads. Failures restore the previous managed files, file modes/ownership, current link, enablement/running state and Caddy routing, then verify the previous running service. A failed first installation removes its new active files/site block and leaves the MCP service stopped/disabled. Immutable staged releases are retained for inspection. If rollback verification itself fails, stop further releases and investigate the private transaction before retrying.

For a later explicit rollback, review the then-current website/MCP state and use the transaction from the active release:

```sh
sudo python3 /path/to/reviewed/deploy/release.py rollback \
  --transaction RECORDED_TRANSACTION \
  --expected-website REVIEWED_CURRENT_WEBSITE_RELEASE \
  --expected-mcp REVIEWED_CURRENT_MCP_RELEASE
```

Rollback verifies that the active managed revision still matches. It restores only the MCP block within today's full Caddyfile, preserving unrelated Caddy changes made since the original activation. Unexpected edits to the MCP block, unit or environment are preserved and rejected for reconciliation. Do not restore an old whole-site Caddy backup over newer unrelated routes.

Run the offline checks from this repository:

```sh
IPVOLT_DEPLOY_NODE=/path/to/node-24/bin/node \
  python3 -m unittest -v deploy/test_release.py
```

The suite uses temporary files and simulated systemd/Caddy actions for release and rollback cases. With `IPVOLT_DEPLOY_NODE` set, it also starts the real current MCP HTTP implementation on an ephemeral local port and validates discovery through the production Python health client. It does not contact the VPS, install units, call a supplier or submit production data. The separate route checker was independently source-reviewed and its 19 controlled Node 24 tests passed; see `route-review-2026-09-14.json` for the revision binding and limits of that review.

Primary operating references: [systemd resource-control documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [systemd execution restrictions](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) and [Caddy log_skip](https://caddyserver.com/docs/caddyfile/directives/log_skip).
