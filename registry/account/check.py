#!/usr/bin/env python3
"""Read-only guards for publishing registry/account/server.json to the official MCP Registry.

This is a second Registry entry, io.github.ipvolt/account: the remote MCP server inside the ipvolt customer
app at https://ipvolt.com/beta/mcp. It has no package: its source is not in this repository, and nothing here
is installed. The entry is remote-only, so the guard checks the metadata, the dispatch, the Registry's state
and that the public remote answers as the entry says.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
FROZEN_NPM_HELPER_SHA256 = "1a172b64e6ca0687912bc150338b496d70a49813f3dff213f8b7a407bb4f910e"
helper = ROOT / "registry/npm/check.py"
if hashlib.sha256(helper.read_bytes()).hexdigest() != FROZEN_NPM_HELPER_SHA256:
    raise SystemExit("Frozen npm publication helper changed")
spec = importlib.util.spec_from_file_location("frozen_npm_check", helper)
npm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(npm)
require = npm.require
CheckError = npm.CheckError

MANIFEST = "registry/account/server.json"
WORKFLOW = "publish-registry-account.yml"
NAME = "io.github.ipvolt/account"
ENDPOINT = "https://ipvolt.com/beta/mcp"
SERVER_NAME = "ipvolt-account"
VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})")
# Everything except the version and the two reviewed texts is fixed here, so a changed entry cannot be published
# without changing this guard in the same reviewed commit.
FIXED = {
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    "name": NAME,
    "title": "ipvolt account",
    "websiteUrl": "https://ipvolt.com/mcp",
}
HEADER_FIXED = {"name": "Authorization", "placeholder": "Bearer YOUR_IPVOLT_API_KEY", "format": "string",
                "isRequired": False, "isSecret": True}
# The tools every answer must have, and the three the server adds while per-GB traffic is on sale.
BASE_TOOLS = ("extend_rental", "get_balance", "get_rental", "how_to_buy", "list_rentals", "list_stock", "rent_proxy",
              "rotate_ip")
TRAFFIC_TOOLS = ("buy_traffic_pack", "get_traffic_connection", "list_traffic")
# The two the server adds, together, while it sells a proxy for an x402 payment without an account.
PURCHASE_TOOLS = ("buy_proxy", "get_purchase")
# An entry of this publisher the Registry is known to hold. Reading it first proves the endpoint answers as
# expected, so that a 404 for the new version means "not published" and not "the address changed".
KNOWN_URL = "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/0.1.1"
# No key-shaped text and nothing the website's claims rule out may enter a public listing.
FORBIDDEN_TEXT = re.compile(r"ipvolt_[A-Za-z0-9_-]{8,}|IPV-[0-9A-Z]{5}|unlimited|instant|guarantee|free trial|OAuth", re.I)


def release_ref(version):
    return f"refs/tags/registry-account-v{version}"


def registry_url(version):
    return f"https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Faccount/versions/{version}"


def verify_manifest(raw):
    manifest = npm.parse_json(raw)
    require(isinstance(manifest, dict), "Unexpected manifest shape")
    require(set(manifest) == {*FIXED, "description", "version", "remotes"}, "Unexpected manifest fields")
    for key, value in FIXED.items():
        require(manifest[key] == value, f"Unexpected {key}")
    version = manifest["version"]
    require(isinstance(version, str) and VERSION_PATTERN.fullmatch(version), "Registry version must be a plain x.y.z")
    description = manifest["description"]
    require(isinstance(description, str) and 1 <= len(description) <= 100, "Description must be 1 to 100 characters")
    remotes = manifest["remotes"]
    require(isinstance(remotes, list) and len(remotes) == 1 and isinstance(remotes[0], dict), "Expected one remote")
    remote = remotes[0]
    require(set(remote) == {"type", "url", "headers"} and remote["type"] == "streamable-http"
            and remote["url"] == ENDPOINT, "Unexpected remote")
    headers = remote["headers"]
    require(isinstance(headers, list) and len(headers) == 1 and isinstance(headers[0], dict), "Expected one header")
    header = headers[0]
    require(set(header) == {*HEADER_FIXED, "description"}, "Unexpected header fields")
    for key, value in HEADER_FIXED.items():
        require(header[key] == value, f"Unexpected header {key}")
    require(isinstance(header["description"], str) and 1 <= len(header["description"]) <= 400,
            "Header description must be 1 to 400 characters")
    # The credential is optional (two tools are public) and must be said to be.
    require(header["description"].startswith("Optional."), "The header must be described as optional")
    for text in (description, header["description"]):
        require(not FORBIDDEN_TEXT.search(text), "Forbidden wording in the listing")
    return manifest


def verify_dispatch(environment, head, version):
    reviewed = environment.get("REVIEWED_COMMIT", "")
    ref = release_ref(version)
    require(re.fullmatch(r"[0-9a-f]{40}", reviewed), "Provide the full reviewed metadata commit")
    require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual dispatch required")
    require(environment.get("GITHUB_REPOSITORY") == npm.REPOSITORY, "Unexpected GitHub repository")
    require(environment.get("GITHUB_REF") == ref, "Dispatch the account Registry tag of this version")
    require(environment.get("GITHUB_SHA") == reviewed == head, "Dispatch/checkout differs from reviewed commit")
    require(environment.get("GITHUB_WORKFLOW_SHA") == reviewed, "Workflow differs from reviewed commit")
    require(environment.get("GITHUB_WORKFLOW_REF") == f"{npm.REPOSITORY}/.github/workflows/{WORKFLOW}@{ref}",
            "Unexpected workflow ref")


def check_local(dispatch=False):
    path = ROOT / MANIFEST
    require(not path.is_symlink(), "Registry manifest must be a regular file")
    manifest = verify_manifest(path.read_bytes())
    if dispatch:
        verify_dispatch(os.environ, npm.git("rev-parse", "HEAD").decode().strip(), manifest["version"])
        require(not npm.git("status", "--porcelain", "--untracked-files=no"), "Tracked checkout is modified")
        # Only metadata that was reviewed and merged is published.
        npm.git("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")
    return manifest


def fetch_json(url, allow_missing=False):
    # Fixed HTTPS public endpoints; no credentials, no redirects, no proxy.
    require(url == KNOWN_URL or re.fullmatch(
        r"https://registry\.modelcontextprotocol\.io/v0\.1/servers/io\.github\.ipvolt%2Faccount/versions/[0-9.]{5,14}", url),
        "Unexpected verification endpoint")
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    opener = urllib.request.build_opener(npm.NoRedirect(), urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=30) as response:
            require(response.status == 200, "Unexpected public endpoint status")
            raw = response.read(1048577)
            require(len(raw) <= 1048576, "Public response exceeded its size limit")
            return npm.parse_json(raw)
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return None
        raise CheckError(f"Public endpoint returned HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise CheckError("Public endpoint request failed") from error


def require_unpublished(version, fetcher=fetch_json):
    known = fetcher(KNOWN_URL)
    require(isinstance(known, dict) and isinstance(known.get("server"), dict)
            and known["server"].get("name") == npm.MCP_NAME and known["server"].get("version") == "0.1.1"
            and known.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {}).get("status") == "active",
            "Registry did not return the known published entry")
    require(fetcher(registry_url(version), allow_missing=True) is None,
            f"Registry {version} already exists; inspect read-back before any retry")


def check_remote(version):
    # The child receives no OIDC, npm, proxy, debug or app-secret environment, and sends no credential.
    node = os.environ.get("IPVOLT_REGISTRY_NODE", "node")
    try:
        result = subprocess.run([node, str(ROOT / "registry/account/check-remote.mjs")], cwd=ROOT,
                                env={"PATH": os.environ.get("PATH", "")}, capture_output=True, timeout=75)
        require(result.returncode == 0 and not result.stderr, "Public remote verification failed")
        report = npm.parse_json(result.stdout)
    except (subprocess.SubprocessError, OSError) as error:
        raise CheckError("Public remote verification failed") from error
    require(isinstance(report, dict) and report.get("ok") is True and report.get("endpoint") == ENDPOINT
            and report.get("serverName") == SERVER_NAME and report.get("toolCalls") == 4,
            "Public remote verification failed")
    # The entry's version is the version the server itself reports.
    require(report.get("serverVersion") == version, "The remote reports another version than the entry")
    tools = report.get("tools")
    require(isinstance(tools, list) and all(isinstance(name, str) for name in tools) and len(set(tools)) == len(tools)
            and set(BASE_TOOLS) <= set(tools) <= {*BASE_TOOLS, *TRAFFIC_TOOLS, *PURCHASE_TOOLS}
            and len(set(PURCHASE_TOOLS) & set(tools)) in (0, len(PURCHASE_TOOLS)), "The remote lists other tools than reviewed")
    return report


def normalize(manifest):
    # Publisher 1.8.1's Go model omits false boolean fields when serializing.
    normalized = copy.deepcopy(manifest)
    for remote in normalized.get("remotes", []):
        for header in remote.get("headers", []):
            for field in ("isRequired", "isSecret"):
                if header.get(field) is False:
                    del header[field]
    return normalized


def verify_readback(response, manifest):
    require(isinstance(response, dict), "Unexpected Registry response shape")
    require(normalize(response.get("server", {})) == normalize(manifest), "Published Registry metadata mismatch")
    official = response.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {})
    require(official.get("status") == "active", "Registry version is not active")
    require(official.get("isLatest") is True, "Registry version is not latest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("local", "remote", "preflight", "prepublish", "read-back"))
    arguments = parser.parse_args()
    manifest = check_local(dispatch=arguments.action in ("preflight", "prepublish"))
    version = manifest["version"]
    if arguments.action in ("preflight", "prepublish"):
        require_unpublished(version)
    remote = check_remote(version) if arguments.action in ("remote", "prepublish") else None
    if arguments.action == "read-back":
        verify_readback(fetch_json(registry_url(version)), manifest)
    print(json.dumps({"ok": True, "check": arguments.action, "name": NAME, "registryVersion": version,
                      "manifestSha256": hashlib.sha256((ROOT / MANIFEST).read_bytes()).hexdigest(),
                      "remote": remote}))


if __name__ == "__main__":
    try:
        main()
    except (CheckError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Account Registry verification failed: {error}", file=sys.stderr)
        sys.exit(1)
