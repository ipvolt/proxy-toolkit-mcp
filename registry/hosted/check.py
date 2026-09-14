#!/usr/bin/env python3
"""Read-only guards for Registry0.1.1 with npm0.1.0 and the verified public remote."""
import argparse
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

HOSTED_SOURCE_COMMIT = "8e9ab8257776cb06c8252c719f576aba3b966fd9"
VERSION = "0.1.1"
RELEASE_REF = "refs/tags/registry-hosted-v0.1.1"
MANIFEST_SHA256 = "c69c3ddc2472e895ede2130797e8ec36370686ca41a6ce0ab932bbc67063a3b1"
REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/0.1.1"
FROZEN_FILES = {
    "package.json": "e32e33b270989e409a8eb670eecfc27d2ceaa46dda414931afca44f67d1acca7",
    "package-lock.json": "316de47b966cd4ba283c622a3d9f82f08f5c4b709fe2c8140960384fbb578ac2",
    "content/catalog.json": "ec3f7bf7eaac59be29233ecf60d7b0b27cbbef2fa5e5269917d64d4c3304d2f1",
}


def verify_dispatch(environment, head):
    reviewed = environment.get("REVIEWED_COMMIT", "")
    require(re.fullmatch(r"[0-9a-f]{40}", reviewed), "Provide the full reviewed metadata commit")
    require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual dispatch required")
    require(environment.get("GITHUB_REPOSITORY") == npm.REPOSITORY, "Unexpected GitHub repository")
    require(environment.get("GITHUB_REF") == RELEASE_REF, "Dispatch the frozen hosted Registry tag")
    require(environment.get("GITHUB_SHA") == reviewed == head, "Dispatch/checkout differs from reviewed commit")
    require(environment.get("GITHUB_WORKFLOW_SHA") == reviewed, "Workflow differs from reviewed commit")
    require(environment.get("GITHUB_WORKFLOW_REF") ==
            f"{npm.REPOSITORY}/.github/workflows/publish-registry-hosted.yml@{RELEASE_REF}", "Unexpected workflow ref")


def verify_manifest(raw, source_raw):
    require(hashlib.sha256(raw).hexdigest() == MANIFEST_SHA256, "Combined Registry manifest bytes changed")
    expected = npm.parse_json(source_raw)
    expected["version"] = VERSION
    manifest = npm.parse_json(raw)
    require(manifest == expected, "Only the Registry version may differ from the reviewed combined manifest")
    require(manifest["packages"][0]["version"] == "0.1.0", "Published npm version must remain immutable")
    require(manifest["remotes"] == [{"type": "streamable-http", "url": "https://mcp.ipvolt.com/mcp"}], "Unexpected hosted remote")
    return manifest


def check_local(dispatch=False):
    _old, package, source_raw = npm.check_local()
    npm.git("merge-base", "--is-ancestor", HOSTED_SOURCE_COMMIT, "HEAD")
    for name, digest in FROZEN_FILES.items():
        require(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, "Frozen runtime/dependency input changed")
    if dispatch:
        verify_dispatch(os.environ, npm.git("rev-parse", "HEAD").decode().strip())
        require(not npm.git("status", "--porcelain", "--untracked-files=no"), "Tracked checkout is modified")
    manifest = ROOT / "registry/hosted/server.json"
    require(not manifest.is_symlink(), "Registry manifest must be a regular file")
    return verify_manifest(manifest.read_bytes(), source_raw), package, source_raw


def fetch_version(allow_missing=False):
    request = urllib.request.Request(REGISTRY_URL, headers={"Accept": "application/json"})
    opener = urllib.request.build_opener(npm.NoRedirect(), urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=30) as response:
            require(response.status == 200, "Unexpected Registry status")
            raw = response.read(1048577)
            require(len(raw) <= 1048576, "Registry response exceeded its size limit")
            return npm.parse_json(raw)
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return None
        raise CheckError(f"Registry returned HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise CheckError("Registry request failed") from error


def verify_previous(response):
    previous = npm.parse_json((ROOT / "registry/npm/server.json").read_bytes())
    require(npm.normalize_registry_manifest(response.get("server", {})) == npm.normalize_registry_manifest(previous),
            "Published Registry0.1.0 metadata differs from its frozen manifest")
    require(response.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {}).get("status") == "active",
            "Published Registry0.1.0 is not active")


def check_remote():
    # The child receives no OIDC, npm, proxy, debug or app-secret environment.
    node = os.environ.get("IPVOLT_REGISTRY_NODE", "node")
    try:
        result = subprocess.run([node, str(ROOT / "registry/hosted/check-remote.mjs")], cwd=ROOT,
                                env={"PATH": os.environ.get("PATH", "")}, capture_output=True, timeout=75)
        require(result.returncode == 0 and not result.stderr, "Public remote verification failed")
        report = npm.parse_json(result.stdout)
        require(report.get("ok") is True and report.get("toolCalls") == 8, "Public remote verification failed")
        return report
    except (subprocess.SubprocessError, OSError) as error:
        raise CheckError("Public remote verification failed") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("local", "public-npm", "remote", "preflight", "prepublish", "read-back"))
    arguments = parser.parse_args()
    manifest, package, source_raw = check_local(dispatch=arguments.action in ("preflight", "prepublish"))
    if arguments.action in ("public-npm", "preflight", "prepublish"):
        npm.check_public_npm(package, source_raw)
    if arguments.action in ("preflight", "prepublish", "read-back"):
        verify_previous(npm.parse_json(npm.fetch(npm.REGISTRY_URL, 1048576)))
    if arguments.action in ("preflight", "prepublish"):
        require(fetch_version(allow_missing=True) is None, "Registry0.1.1 already exists; inspect read-back before any retry")
    remote = check_remote() if arguments.action in ("remote", "prepublish") else None
    if arguments.action == "read-back":
        npm.verify_readback(fetch_version(), manifest)
    print(json.dumps({"ok": True, "check": arguments.action, "name": npm.MCP_NAME, "registryVersion": VERSION,
                      "npmVersion": "0.1.0", "manifestSha256": MANIFEST_SHA256,
                      "npmArchiveSha256": npm.ARCHIVE_SHA256, "hostedSourceCommit": HOSTED_SOURCE_COMMIT,
                      "remote": remote}))


if __name__ == "__main__":
    try:
        main()
    except (CheckError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Registry verification failed: {error}", file=sys.stderr)
        sys.exit(1)
