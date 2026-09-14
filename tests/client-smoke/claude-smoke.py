#!/usr/bin/env python3
"""Exercise actual Claude Code with temporary MCP config and public tool inputs.

Requires an already authenticated CLI. This never logs in, changes account/client
settings, reads chats, or copies credentials. No built-in agent tools are enabled.
Only the two named public MCP tools are allowed; session persistence, memory,
hooks and automatic discovery of other MCP servers are disabled for the run.
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

EXPECTED_TOOLS = {"mcp__ipvolt__search_proxy_docs", "mcp__ipvolt__diagnose_proxy_error"}
PROMPT = """This is a public-input MCP interoperability check. Use only the ipvolt MCP server.
Call search_proxy_docs with {"query":"HTTPX proxy authentication 407","limit":2}.
Call diagnose_proxy_error with {"client":"httpx","version":"0.28.1","phase":"connect_tunnel","status":407,"method":"GET","responseSource":"proxy"}.
Do not run a route check, access files, use other tools, or perform any other task.
After both real calls complete, reply with a short JSON object containing the source URL returned by search and the first diagnostic candidate code. Do not answer from memory or simulate tool results."""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-root", type=Path, required=True)
    parser.add_argument("--claude", default=shutil.which("claude"))
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--archive", type=Path, help="Release archive used for the clean install")
    args = parser.parse_args()
    root = args.server_root.resolve(strict=True)
    package = json.loads((root / "package.json").read_text())
    assert package["name"] == "@ipvolt/proxy-toolkit-mcp"
    client_version = subprocess.run([args.claude, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    node_version = subprocess.run([args.node, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    report = {"passed": False, "checkedAt": datetime.now(timezone.utc).isoformat(), "client": "Claude Code", "clientVersion": client_version, "nodeVersion": node_version, "packageVersion": package["version"], **artifact_evidence(root, args.archive), "runs": []}
    with tempfile.TemporaryDirectory(prefix="ipvolt-claude-fixture-") as temporary:
        temp = Path(temporary)
        base_env = {"PATH": os.path.dirname(args.node) + os.pathsep + os.environ["PATH"], "LC_ALL": "C"}
        # Preserve the caller's identity environment so the installed client can
        # use its existing login. Do not load, copy or print authentication data.
        identity_env = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR") if key in os.environ}
        env = base_env | identity_env | {
            "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
            "CLAUDE_CODE_DISABLE_CRON": "1", "CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS": "1",
            "CLAUDE_CODE_DISABLE_ATTACHMENTS": "1", "CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1",
        }
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        endpoint = f"http://127.0.0.1:{port}/mcp"
        with (temp / "server.stderr").open("w+") as stderr_file:
            server = subprocess.Popen([args.node, str(root / "dist/transports/http.js")], env=base_env | {"IPVOLT_MCP_PORT": str(port), "IPVOLT_MCP_PUBLIC_URL": endpoint}, cwd=temp, stdout=subprocess.DEVNULL, stderr=stderr_file)
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
                    target = {"type": "stdio", "command": args.node, "args": [str(root / "dist/transports/stdio.js")]} if transport == "stdio" else {"type": "http", "url": endpoint}
                    config = temp / "mcp.json"
                    config.write_text(json.dumps({"mcpServers": {"ipvolt": target}}))
                    command = [args.claude, "--restricted", "--print", "--no-session-persistence", "--setting-sources", "", "--settings", json.dumps({"disableAllHooks": True, "autoMemoryEnabled": False}), "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", str(config), "--tools", "", "--allowedTools", ",".join(sorted(EXPECTED_TOOLS)), "--permission-mode", "dontAsk", "--permission-prompts", "none", "--max-turns", "4", "--max-budget-usd", "1", "--output-format", "stream-json", "--verbose", "--system-prompt", "You are an MCP interoperability tester. Use only the two requested public fixture tools and return the observed results. Do not use subagents or other tools.", PROMPT]
                    result = subprocess.run(command, env=env, cwd=temp, text=True, capture_output=True, timeout=120)
                    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
                    init = next((event for event in events if event.get("type") == "system" and event.get("subtype") == "init"), {})
                    tool_uses = [block for event in events if event.get("type") == "assistant" for block in event.get("message", {}).get("content", []) if block.get("type") == "tool_use"]
                    public_call_ids = {block["id"] for block in tool_uses if block["name"] in EXPECTED_TOOLS}
                    tool_results = [block for event in events if event.get("type") == "user" for block in event.get("message", {}).get("content", []) if block.get("type") == "tool_result" and block.get("tool_use_id") in public_call_ids]
                    final = next((event for event in reversed(events) if event.get("type") == "result"), {})
                    # Retain only public fixture/tool evidence, not session IDs,
                    # account metadata, machine context, or the full client stream.
                    entry = {"transport": transport, "exitCode": result.returncode, "connections": init.get("mcp_servers"), "toolCalls": [{"name": block["name"], "input": block.get("input")} for block in tool_uses], "toolResults": [{"name": next(call["name"] for call in tool_uses if call["id"] == block["tool_use_id"]), "isError": block.get("is_error", False), "content": block.get("content")} for block in tool_results], "resultSubtype": final.get("subtype"), "resultIsError": final.get("is_error"), "answer": final.get("result"), "stderr": result.stderr.strip()[:2000]}
                    report["runs"].append(entry)
                    assert result.returncode == 0, entry
                    assert init.get("mcp_servers") == [{"name": "ipvolt", "status": "connected"}], entry
                    assert {block["name"] for block in tool_uses} == EXPECTED_TOOLS, entry
                    assert {result["name"] for result in entry["toolResults"]} == EXPECTED_TOOLS, entry
                    assert all(not result["isError"] for result in entry["toolResults"]), entry
                    observed = {result["name"]: json.loads(result["content"]) for result in entry["toolResults"]}
                    assert observed["mcp__ipvolt__search_proxy_docs"]["results"][0]["url"].startswith("https://ipvolt.com/"), entry
                    assert observed["mcp__ipvolt__diagnose_proxy_error"]["candidates"][0]["code"] == "proxy_authentication_required", entry
                    assert not final.get("is_error") and final.get("subtype") == "success", entry
                    assert "proxy_authentication_required" in final.get("result", ""), entry
                report["passed"] = True
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait(timeout=5)
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("passed", "clientVersion", "nodeVersion", "packageVersion")} | {"transports": len(report["runs"])}))


if __name__ == "__main__":
    main()
