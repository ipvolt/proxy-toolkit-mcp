#!/usr/bin/env python3
"""Run the real MCP Inspector CLI against an installed, built toolkit package.

All inputs are public fixtures. Inspector configuration/auth state is temporary;
the secrets backend is memory-only. No operator proxy or client settings are used.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from _artifact import artifact_evidence

TOOLS = {"search_proxy_docs", "get_proxy_doc", "generate_proxy_config", "diagnose_proxy_error"}
CALLS = [
    ("search_proxy_docs", {"query": "HTTPX proxy authentication 407", "limit": 2}),
    ("get_proxy_doc", {"documentId": "/guides/fix-proxy-error-407"}),
    ("generate_proxy_config", {"client": "httpx", "version": "0.28.1"}),
    ("diagnose_proxy_error", {"client": "httpx", "version": "0.28.1", "phase": "connect_tunnel", "status": 407, "method": "GET", "responseSource": "proxy"}),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-root", type=Path, required=True)
    parser.add_argument("--inspector", type=Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--archive", type=Path, help="Release archive used for the clean install")
    args = parser.parse_args()
    root = args.server_root.resolve(strict=True)
    inspector = args.inspector.resolve(strict=True)
    package = json.loads((root / "package.json").read_text())
    assert package["name"] == "@ipvolt/proxy-toolkit-mcp"
    inspector_root = next(parent for parent in inspector.parents if (parent / "package.json").is_file() and json.loads((parent / "package.json").read_text()).get("name") == "@modelcontextprotocol/inspector")
    inspector_version = json.loads((inspector_root / "package.json").read_text())["version"]
    node_version = subprocess.run([args.node, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    report = {"passed": False, "checkedAt": datetime.now(timezone.utc).isoformat(), "client": "MCP Inspector CLI", "clientVersion": inspector_version, "nodeVersion": node_version, "packageVersion": package["version"], **artifact_evidence(root, args.archive), "runs": [], "proxyRequests": 0}
    with tempfile.TemporaryDirectory(prefix="ipvolt-inspector-fixture-") as temporary:
        temp = Path(temporary)
        env = {"PATH": os.path.dirname(args.node) + os.pathsep + os.environ["PATH"], "LC_ALL": "C", "MCP_INSPECTOR_SECRET_STORE": "memory", "MCP_INSPECTOR_OAUTH_STATE_PATH": str(temp / "oauth.json")}
        (temp / "client.json").write_text("{}")
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        endpoint = f"http://127.0.0.1:{port}/mcp"
        stderr_file = (temp / "server.stderr").open("w+")
        server = subprocess.Popen([args.node, str(root / "dist/transports/http.js")], env=env | {"IPVOLT_MCP_PORT": str(port), "IPVOLT_MCP_PUBLIC_URL": endpoint}, cwd=temp, stdout=subprocess.DEVNULL, stderr=stderr_file)
        try:
            for _ in range(60):
                if server.poll() is not None:
                    raise AssertionError("HTTP server exited before health check")
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as response:
                        assert response.status == 200
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError("HTTP startup timeout")
            for transport in ("stdio", "http"):
                for era in ("modern", "legacy"):
                    target = {"command": args.node, "args": [str(root / "dist/transports/stdio.js")]} if transport == "stdio" else {"type": "http", "url": endpoint}
                    (temp / "mcp.json").write_text(json.dumps({"mcpServers": {"ipvolt": target | {"protocolEra": era}}}))
                    base = [args.node, str(inspector), "--cli", "--config", str(temp / "mcp.json"), "--server", "ipvolt", "--client-config", str(temp / "client.json"), "--stored-auth-only", "--format", "json"]
                    outcomes = []
                    for method, tool, inputs in [("initialize", None, None), ("tools/list", None, None)] + [("tools/call", tool, value) for tool, value in CALLS]:
                        command = base + ["--method", method]
                        if tool:
                            command += ["--tool-name", tool, "--tool-args-json", json.dumps(inputs)]
                        if method == "tools/list":
                            command += ["--strict"]
                        result = subprocess.run(command, env=env, cwd=temp, text=True, capture_output=True, timeout=30)
                        assert result.returncode == 0, (transport, era, method, tool, result.stderr, result.stdout[:1000])
                        body = json.loads(result.stdout)["result"]
                        assert not body.get("isError"), (method, tool, body)
                        if method == "initialize":
                            assert body["serverInfo"]["version"] == package["version"]
                            assert body["protocolVersion"] == ("2026-07-28" if era == "modern" else "2025-11-25")
                        if method == "tools/list":
                            assert {item["name"] for item in body["tools"]} == TOOLS
                        if tool == "search_proxy_docs":
                            assert body["structuredContent"]["results"]
                            assert all(item["url"].startswith("https://ipvolt.com/") for item in body["structuredContent"]["results"])
                        if tool == "get_proxy_doc":
                            assert body["structuredContent"]["document"]["id"] == inputs["documentId"]
                        if tool == "generate_proxy_config":
                            assert body["structuredContent"]["behavior"]["automaticRetries"] == 0
                        if tool == "diagnose_proxy_error":
                            assert body["structuredContent"]["candidates"][0]["code"] == "proxy_authentication_required"
                        outcomes.append({"method": method, "tool": tool, "arguments": inputs, "exitCode": result.returncode, "stderr": result.stderr.strip(), "response": body})
                    report["runs"].append({"transport": transport, "protocolEra": era, "outcomes": outcomes})
            report["passed"] = True
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait(timeout=5)
            stderr_file.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("passed", "client", "clientVersion", "nodeVersion", "packageVersion")} | {"transportEraPairs": len(report["runs"]), "requests": sum(len(run["outcomes"]) for run in report["runs"])}))


if __name__ == "__main__":
    main()
