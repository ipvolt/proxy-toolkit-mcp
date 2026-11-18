#!/usr/bin/env python3
"""Read-only guards for publishing the root server.json as a new Registry version.

The version is the one in package.json and server.json. The npm version of the same number must
already be public, the Registry must not hold it yet, and the hosted remote must answer.
"""
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

WORKFLOW = "publish-registry-release.yml"
REMOTES = [{"type": "streamable-http", "url": "https://mcp.ipvolt.com/mcp"}]
REPOSITORY_URLS = ("https://github.com/ipvolt/proxy-toolkit-mcp.git", "git+https://github.com/ipvolt/proxy-toolkit-mcp.git")
VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})")
# Versions published by the two frozen workflows; this guard never republishes them.
FROZEN_VERSIONS = ("0.1.0", "0.1.1")


def release_ref(version):
    return f"refs/tags/registry-v{version}"


def npm_url(version):
    return f"https://registry.npmjs.org/@ipvolt%2fproxy-toolkit-mcp/{version}"


def registry_url(version):
    return f"https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/{version}"


def verify_manifest(raw, package_raw):
    manifest = npm.parse_json(raw)
    package = npm.parse_json(package_raw)
    require(isinstance(manifest, dict) and isinstance(package, dict), "Unexpected manifest shape")
    version = manifest.get("version")
    require(isinstance(version, str) and VERSION_PATTERN.fullmatch(version), "Registry version must be a plain x.y.z")
    require(version not in FROZEN_VERSIONS, "This version belongs to a frozen workflow")
    require(package.get("name") == npm.PACKAGE and package.get("version") == version,
            "package.json and server.json versions differ")
    require(manifest.get("name") == npm.MCP_NAME == package.get("mcpName"), "Unexpected MCP identity")
    require(manifest.get("repository") == {"url": f"https://github.com/{npm.REPOSITORY}", "source": "github"},
            "Unexpected source repository")
    require(manifest.get("websiteUrl") == "https://ipvolt.com", "Unexpected website")
    description = manifest.get("description")
    require(isinstance(description, str) and 1 <= len(description) <= 100, "Description must be 1 to 100 characters")
    packages = manifest.get("packages")
    require(isinstance(packages, list) and len(packages) == 1 and isinstance(packages[0], dict), "Expected one npm package")
    entry = packages[0]
    require(entry.get("registryType") == "npm" and entry.get("registryBaseUrl") == "https://registry.npmjs.org"
            and entry.get("identifier") == npm.PACKAGE and entry.get("version") == version
            and entry.get("transport") == {"type": "stdio"}, "Unexpected npm package entry")
    require(manifest.get("remotes") == REMOTES, "Unexpected hosted remote")
    return manifest


def verify_dispatch(environment, head, version):
    reviewed = environment.get("REVIEWED_COMMIT", "")
    ref = release_ref(version)
    require(re.fullmatch(r"[0-9a-f]{40}", reviewed), "Provide the full reviewed metadata commit")
    require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual dispatch required")
    require(environment.get("GITHUB_REPOSITORY") == npm.REPOSITORY, "Unexpected GitHub repository")
    require(environment.get("GITHUB_REF") == ref, "Dispatch the Registry tag of this version")
    require(environment.get("GITHUB_SHA") == reviewed == head, "Dispatch/checkout differs from reviewed commit")
    require(environment.get("GITHUB_WORKFLOW_SHA") == reviewed, "Workflow differs from reviewed commit")
    require(environment.get("GITHUB_WORKFLOW_REF") == f"{npm.REPOSITORY}/.github/workflows/{WORKFLOW}@{ref}",
            "Unexpected workflow ref")


def check_local(dispatch=False):
    path = ROOT / "server.json"
    require(not path.is_symlink(), "Registry manifest must be a regular file")
    manifest = verify_manifest(path.read_bytes(), (ROOT / "package.json").read_bytes())
    if dispatch:
        verify_dispatch(os.environ, npm.git("rev-parse", "HEAD").decode().strip(), manifest["version"])
        require(not npm.git("status", "--porcelain", "--untracked-files=no"), "Tracked checkout is modified")
        # The metadata must descend from the source that npm version was built from.
        npm.git("merge-base", "--is-ancestor", f"refs/tags/v{manifest['version']}", "HEAD")
    return manifest


def fetch_json(url, allow_missing=False):
    # Fixed HTTPS public endpoints; no credentials, no redirects, no proxy.
    require(re.fullmatch(r"https://registry\.npmjs\.org/@ipvolt%2fproxy-toolkit-mcp/[0-9.]{5,14}"
                         r"|https://registry\.modelcontextprotocol\.io/v0\.1/servers/io\.github\.ipvolt%2Fproxy-toolkit/versions/[0-9.]{5,14}",
                         url), "Unexpected verification endpoint")
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


def verify_npm_metadata(metadata, version):
    require(isinstance(metadata, dict), "Unexpected npm metadata shape")
    require(metadata.get("name") == npm.PACKAGE, "Public npm package name mismatch")
    require(metadata.get("version") == version, "Public npm version mismatch")
    require(metadata.get("mcpName") == npm.MCP_NAME, "Public npm MCP identity mismatch")
    repository = metadata.get("repository", {})
    require(isinstance(repository, dict) and repository.get("type") == "git"
            and repository.get("url") in REPOSITORY_URLS, "Public npm repository mismatch")
    distribution = metadata.get("dist", {})
    require(isinstance(distribution, dict), "Public npm distribution is missing")
    require(isinstance(distribution.get("integrity"), str) and distribution["integrity"].startswith("sha512-"),
            "Public npm integrity is missing")
    require(distribution.get("tarball") ==
            f"https://registry.npmjs.org/@ipvolt/proxy-toolkit-mcp/-/proxy-toolkit-mcp-{version}.tgz",
            "Public npm tarball URL mismatch")
    # Versions after 0.1.0 are published by the repository's workflow through npm trusted publishing.
    attestations = distribution.get("attestations")
    require(isinstance(attestations, dict) and isinstance(attestations.get("provenance"), dict)
            and attestations["provenance"].get("predicateType") == "https://slsa.dev/provenance/v1",
            "Public npm version has no build provenance")
    return distribution["integrity"]


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
    manifest = check_local(dispatch=arguments.action in ("preflight", "prepublish"))
    version = manifest["version"]
    integrity = None
    if arguments.action in ("public-npm", "preflight", "prepublish"):
        integrity = verify_npm_metadata(fetch_json(npm_url(version)), version)
    if arguments.action in ("preflight", "prepublish"):
        require(fetch_json(registry_url(version), allow_missing=True) is None,
                f"Registry {version} already exists; inspect read-back before any retry")
    remote = check_remote() if arguments.action in ("remote", "prepublish") else None
    if arguments.action == "read-back":
        npm.verify_readback(fetch_json(registry_url(version)), manifest)
    print(json.dumps({"ok": True, "check": arguments.action, "name": npm.MCP_NAME, "registryVersion": version,
                      "npmVersion": version, "npmIntegrity": integrity,
                      "manifestSha256": hashlib.sha256((ROOT / "server.json").read_bytes()).hexdigest(),
                      "remote": remote}))


if __name__ == "__main__":
    try:
        main()
    except (CheckError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Registry verification failed: {error}", file=sys.stderr)
        sys.exit(1)
