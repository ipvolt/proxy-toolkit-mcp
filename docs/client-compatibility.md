# Client compatibility evidence

Validated on 2026-09-14 with a clean consumer installation of `@ipvolt/proxy-toolkit-mcp@0.1.0`, using Node **24.20.0** on macOS arm64. Both real clients connected over stdio and loopback Streamable HTTP and completed public tool calls.

| Client | Transport | Discovery / protocol | Actual calls | Result |
| --- | --- | --- | --- | --- |
| MCP Inspector CLI 2.6.0 | stdio | `2026-07-28` and `2025-11-25`; exact four tools | All four public tools in each protocol era | Passed |
| MCP Inspector CLI 2.6.0 | Streamable HTTP | `2026-07-28` and `2025-11-25`; exact four tools | All four public tools in each protocol era | Passed |
| Claude Code 2.1.270 | stdio | Client reported the isolated `ipvolt` server connected | `search_proxy_docs`, `diagnose_proxy_error` | Passed |
| Claude Code 2.1.270 | Streamable HTTP | Client reported the isolated `ipvolt` server connected | `search_proxy_docs`, `diagnose_proxy_error` | Passed |

Inspector executed 24 CLI operations: initialization, strict tool discovery and four calls for each transport/protocol pair. Strict discovery returned **zero errors and one warning**: `get_proxy_doc.outputSchema.properties.nextCursor` is emitted as `type: ["string", "null"]`. This is valid JSON Schema, but Inspector notes that some clients only accept a single string in `type`. Both clients above accepted this schema. No broader client compatibility is implied.

Claude Code's captured tool results include the reviewed source `https://ipvolt.com/blog/proxy-status-codes-407-429-502` and diagnostic candidate `proxy_authentication_required`. The evidence preserves the actual tool calls and returned public data, not just the assistant's final answer. Claude's negotiated protocol version was not captured separately.

These checks used a locally installed release archive and a temporary HTTP listener on `127.0.0.1`. They do not establish npm publication, public HTTPS availability or registry acceptance. They did not exercise the opt-in route probe or make proxy requests. Desktop clients, Cursor and VS Code were not tested in this run.

## Revision and evidence

- Archive SHA256: `57adcee5dd4db1b0a4e11df196c415fcd6de3aa76f540689f399b75e81076339`.
- Content source release: `20260914-hero-split`.
- Content bundle SHA256: `c6679b20124395b58cc00aea571589d466364dc41271134fb3d27e8803c5255b`.
- [Inspector evidence](../tests/client-smoke/inspector-2026-09-14.json): version, protocols, schemas, arguments, public responses, diagnostics and all installed runtime/content file hashes.
- [Claude Code evidence](../tests/client-smoke/claude-2026-09-14.json): version, connection status, public tool calls/results and the same artifact identity.

Both harnesses compare every installed `dist/` and `content/` file with the supplied archive before running. A later archive or changed runtime/content requires fresh evidence.

## Reproduce

Use Node 24 or newer and Python 3.10 or newer. Set `MCP_TEST_ARCHIVE` to the release archive being reviewed. Install into a disposable directory; the separate empty npm configuration files avoid inheriting registry credentials.

```sh
MCP_TEST_ARCHIVE=/absolute/path/ipvolt-proxy-toolkit-mcp-0.1.0.tgz
MCP_TEST_ROOT="$(mktemp -d -t ipvolt-mcp-client-check)"
touch "$MCP_TEST_ROOT/user.npmrc" "$MCP_TEST_ROOT/global.npmrc"
npm install --prefix "$MCP_TEST_ROOT" --ignore-scripts --no-audit --no-fund \
  --userconfig "$MCP_TEST_ROOT/user.npmrc" \
  --globalconfig "$MCP_TEST_ROOT/global.npmrc" \
  @modelcontextprotocol/inspector@2.6.0 "$MCP_TEST_ARCHIVE"
python3 tests/client-smoke/inspector-smoke.py \
  --server-root "$MCP_TEST_ROOT/node_modules/@ipvolt/proxy-toolkit-mcp" \
  --inspector "$MCP_TEST_ROOT/node_modules/.bin/mcp-inspector" \
  --archive "$MCP_TEST_ARCHIVE" --output "$MCP_TEST_ROOT/inspector.json"
```

The [Inspector harness](../tests/client-smoke/inspector-smoke.py) uses temporary read-only server configuration, a temporary client/OAuth state path and the memory-only secret store. Each CLI call uses `--stored-auth-only`. The official [Inspector CLI documentation](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli) describes these flags and strict schema diagnostics.

If Claude Code is already installed and authenticated, run the bounded two-transport fixture:

```sh
python3 tests/client-smoke/claude-smoke.py \
  --server-root "$MCP_TEST_ROOT/node_modules/@ipvolt/proxy-toolkit-mcp" \
  --archive "$MCP_TEST_ARCHIVE" --output "$MCP_TEST_ROOT/claude.json"
```

The [Claude harness](../tests/client-smoke/claude-smoke.py) uses the existing login without reading or copying credentials. It preserves the caller's identity environment, uses an empty temporary working directory and passes all restrictions for this invocation only. Built-in tools, hooks, slash commands, memory, other MCP configurations and session persistence are disabled; only the two named public tools are allowed. Each transport run is capped at four turns and a $1 budget. Saved evidence excludes account/session metadata and unrelated client context. See the official [CLI flags](https://code.claude.com/docs/en/cli-reference) and [environment variables](https://code.claude.com/docs/en/env-vars).

Both harnesses stop their temporary HTTP process and delete temporary configuration files on completion. The caller may remove the disposable installation directory after reviewing its evidence.
