#!/usr/bin/env python3
"""Read-only checks for the frozen, npm-only Registry publication.

No npm installation, Registry authentication or publication happens here.
The workflow runs these checks before it authenticates the official publisher.
"""

import argparse
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request


SOURCE_COMMIT = "7660651b2ee22866db5fa70e3d2b3dee68760c43"
REPOSITORY = "ipvolt/proxy-toolkit-mcp"
RELEASE_REF = "refs/tags/registry-npm-v0.1.0"
VERSION = "0.1.0"
PACKAGE = "@ipvolt/proxy-toolkit-mcp"
MCP_NAME = "io.github.ipvolt/proxy-toolkit"
MANIFEST_SHA256 = "08e336e884ff50c5da13f7897187b9dae9f1d422262b8b07e85d86bdf6540e2d"
SOURCE_MANIFEST_SHA256 = "b606887b289949c9fd210e8f8e88e24ddd68c090d82d0871cd74a152ddecfb80"
ARCHIVE_SHA256 = "4848d77611d09a004454577e9a2f3316c420bcbca3a33633ae8a43876ec48f81"
ARCHIVE_INTEGRITY = "sha512-ubn8Tv3ROGwkN6kln8gEJ98qF+7x1r/QIAobCacJ+1X4cV/WOISSg95rgVDfBW379KiXMQmIlLvWC24nAR8t7A=="
NPM_URL = "https://registry.npmjs.org/@ipvolt%2fproxy-toolkit-mcp/0.1.0"
ARCHIVE_URL = "https://registry.npmjs.org/@ipvolt/proxy-toolkit-mcp/-/proxy-toolkit-mcp-0.1.0.tgz"
REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/0.1.0"
PUBLISHER_SHA256 = "a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc"
ROOT = Path(__file__).resolve().parents[2]


class CheckError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CheckError(message)


def parse_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "Duplicate JSON field")
            value[key] = item
        return value

    def reject_constant(_):
        raise CheckError("Invalid JSON constant")

    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CheckError("Invalid JSON response") from error


def git(*arguments):
    try:
        return subprocess.check_output(
            ["git", *arguments], cwd=ROOT, stderr=subprocess.DEVNULL, timeout=15
        )
    except (subprocess.SubprocessError, OSError) as error:
        raise CheckError("Frozen Git revision check failed") from error


def verify_dispatch(environment, head):
    reviewed = environment.get("REVIEWED_COMMIT", "")
    require(re.fullmatch(r"[0-9a-f]{40}", reviewed), "Provide the full reviewed metadata commit")
    require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual dispatch required")
    require(environment.get("GITHUB_REPOSITORY") == REPOSITORY, "Unexpected GitHub repository")
    require(environment.get("GITHUB_REF") == RELEASE_REF, "Dispatch the frozen Registry release tag")
    require(environment.get("GITHUB_SHA") == reviewed == head, "Dispatch/checkout differs from reviewed commit")
    require(environment.get("GITHUB_WORKFLOW_SHA") == reviewed, "Workflow differs from reviewed commit")
    require(
        environment.get("GITHUB_WORKFLOW_REF")
        == f"{REPOSITORY}/.github/workflows/publish-registry.yml@{RELEASE_REF}",
        "Unexpected workflow ref",
    )
    return reviewed


def verify_manifest(raw, source_raw, source_package):
    require(hashlib.sha256(raw).hexdigest() == MANIFEST_SHA256, "Registry manifest bytes changed")
    require(hashlib.sha256(source_raw).hexdigest() == SOURCE_MANIFEST_SHA256, "Source manifest changed")
    manifest, source = parse_json(raw), parse_json(source_raw)
    require("remotes" not in manifest, "The npm-only release cannot advertise a remote")
    source.pop("remotes", None)
    require(manifest == source, "Registry manifest must only omit source remotes")
    require(manifest["name"] == source_package["mcpName"] == MCP_NAME, "MCP identity mismatch")
    require(manifest["version"] == source_package["version"] == VERSION, "Version mismatch")
    require(source_package["name"] == PACKAGE, "Package identity mismatch")
    return manifest


def check_local(dispatch=False):
    git("cat-file", "-e", f"{SOURCE_COMMIT}^{{commit}}")
    git("merge-base", "--is-ancestor", SOURCE_COMMIT, "HEAD")
    if dispatch:
        verify_dispatch(os.environ, git("rev-parse", "HEAD").decode().strip())
        require(not git("status", "--porcelain", "--untracked-files=no"), "Tracked checkout is modified")
    manifest_path = ROOT / "registry/npm/server.json"
    require(not manifest_path.is_symlink(), "Registry manifest must be a regular file")
    source_package = parse_json(git("show", f"{SOURCE_COMMIT}:package.json"))
    source_raw = git("show", f"{SOURCE_COMMIT}:server.json")
    manifest = verify_manifest(manifest_path.read_bytes(), source_raw, source_package)
    return manifest, source_package, source_raw


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_arguments, **_keywords):
        return None


def fetch(url, limit, allow_missing=False):
    # Fixed HTTPS public endpoints; never read npm credentials or follow redirects.
    require(url in (NPM_URL, ARCHIVE_URL, REGISTRY_URL), "Unexpected verification endpoint")
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=30) as response:
            require(response.status == 200, "Unexpected public endpoint status")
            raw = response.read(limit + 1)
            require(len(raw) <= limit, "Public response exceeded its size limit")
            return raw
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return None
        raise CheckError(f"Public endpoint returned HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise CheckError("Public endpoint request failed") from error


def verify_npm_metadata(metadata):
    require(isinstance(metadata, dict), "Unexpected npm metadata shape")
    require(metadata.get("name") == PACKAGE, "Public npm package name mismatch")
    require(metadata.get("version") == VERSION, "Public npm version mismatch")
    require(metadata.get("mcpName") == MCP_NAME, "Public npm MCP identity mismatch")
    repository = metadata.get("repository", {})
    require(isinstance(repository, dict), "Public npm repository is missing")
    require(repository.get("type") == "git", "Public npm repository type mismatch")
    require(repository.get("url") in (
        "https://github.com/ipvolt/proxy-toolkit-mcp.git",
        "git+https://github.com/ipvolt/proxy-toolkit-mcp.git",
    ), "Public npm repository URL mismatch")
    distribution = metadata.get("dist", {})
    require(isinstance(distribution, dict), "Public npm distribution is missing")
    require(distribution.get("integrity") == ARCHIVE_INTEGRITY, "Public npm integrity mismatch")
    require(distribution.get("tarball") == ARCHIVE_URL, "Public npm tarball URL mismatch")


def verify_archive(raw, source_package, source_manifest):
    require(hashlib.sha256(raw).hexdigest() == ARCHIVE_SHA256, "Downloaded archive SHA-256 mismatch")
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    require(integrity == ARCHIVE_INTEGRITY, "Downloaded archive integrity mismatch")
    # The hashes are checked before reading archive metadata; nothing is extracted or run.
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for name, expected in (("package/package.json", source_package),
                               ("package/server.json", parse_json(source_manifest))):
            matches = [member for member in archive.getmembers() if member.name == name]
            require(len(matches) == 1 and matches[0].isreg(), "Archive metadata entry mismatch")
            require(matches[0].size <= 65536, "Archive metadata entry exceeds its size limit")
            stream = archive.extractfile(matches[0])
            require(stream is not None, "Archive metadata is missing")
            with stream:
                require(parse_json(stream.read(65537)) == expected, "Archive metadata differs from reviewed source")


def check_public_npm(source_package, source_manifest, fetcher=fetch):
    metadata = parse_json(fetcher(NPM_URL, 1048576))
    verify_npm_metadata(metadata)
    raw = fetcher(ARCHIVE_URL, 5242880)
    verify_archive(raw, source_package, source_manifest)


def require_unpublished(fetcher=fetch):
    existing = fetcher(REGISTRY_URL, 1048576, allow_missing=True)
    require(existing is None,
            "Registry version already exists; read it back instead of retrying publication")


def normalize_registry_manifest(manifest):
    # Publisher 1.8.1's Go model omits these false boolean fields when serializing.
    normalized = copy.deepcopy(manifest)
    for package in normalized.get("packages", []):
        for variable in package.get("environmentVariables", []):
            for field in ("isRequired", "isSecret"):
                if variable.get(field) is False:
                    del variable[field]
    return normalized


def verify_readback(response, manifest):
    require(isinstance(response, dict), "Unexpected Registry response shape")
    require(normalize_registry_manifest(response.get("server", {}))
            == normalize_registry_manifest(manifest), "Published Registry metadata mismatch")
    official = response.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {})
    require(official.get("status") == "active", "Registry version is not active")
    require(official.get("isLatest") is True, "Registry version is not latest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("local", "public-npm", "prepublish", "read-back"))
    arguments = parser.parse_args()
    manifest, package, source_manifest = check_local(dispatch=arguments.action == "prepublish")
    if arguments.action in ("public-npm", "prepublish"):
        check_public_npm(package, source_manifest)
    if arguments.action == "prepublish":
        require_unpublished()
    if arguments.action == "read-back":
        verify_readback(parse_json(fetch(REGISTRY_URL, 1048576)), manifest)
    print(json.dumps({
        "ok": True, "check": arguments.action, "name": MCP_NAME, "version": VERSION,
        "distribution": "npm-only", "sourceCommit": SOURCE_COMMIT,
        "manifestSha256": MANIFEST_SHA256, "npmArchiveSha256": ARCHIVE_SHA256,
        "npmIntegrity": ARCHIVE_INTEGRITY,
    }))


if __name__ == "__main__":
    try:
        main()
    except (CheckError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"Registry verification failed: {error}", file=sys.stderr)
        sys.exit(1)
