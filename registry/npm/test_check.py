"""Controlled checks for publication refusal and public artifact/read-back verification."""

import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location("registry_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class RegistryChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest, cls.package, cls.source_raw = check.check_local()
        cls.raw = (check.ROOT / "registry/npm/server.json").read_bytes()

    def environment(self):
        revision = "a" * 40
        return {
            "REVIEWED_COMMIT": revision,
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REPOSITORY": check.REPOSITORY,
            "GITHUB_REF": check.RELEASE_REF,
            "GITHUB_SHA": revision,
            "GITHUB_WORKFLOW_SHA": revision,
            "GITHUB_WORKFLOW_REF": f"{check.REPOSITORY}/.github/workflows/publish-registry.yml@{check.RELEASE_REF}",
        }

    def metadata(self):
        return {
            "name": check.PACKAGE, "version": check.VERSION, "mcpName": check.MCP_NAME,
            "repository": {"type": "git", "url": "git+https://github.com/ipvolt/proxy-toolkit-mcp.git"},
            "dist": {"integrity": check.ARCHIVE_INTEGRITY, "tarball": check.ARCHIVE_URL},
        }

    def readback(self):
        return {
            "server": copy.deepcopy(self.manifest),
            "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active", "isLatest": True}},
        }

    def archive(self, package=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, raw in (("package/package.json", json.dumps(package or self.package).encode()),
                              ("package/server.json", self.source_raw)):
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
        return buffer.getvalue()

    def fixture_digests(self, raw):
        return patch.multiple(check, ARCHIVE_SHA256=hashlib.sha256(raw).hexdigest(),
                              ARCHIVE_INTEGRITY="sha512-" + check.base64.b64encode(hashlib.sha512(raw).digest()).decode())

    def test_manifest_is_exact_frozen_npm_derivative(self):
        self.assertNotIn("remotes", self.manifest)
        source = check.parse_json(self.source_raw)
        del source["remotes"]
        self.assertEqual(self.manifest, source)

    def test_manifest_changes_are_rejected(self):
        for field, value in (("remotes", []), ("version", "0.1.1"), ("websiteUrl", "https://invalid.example")):
            with self.subTest(field=field):
                changed = {**self.manifest, field: value}
                with self.assertRaises(check.CheckError):
                    check.verify_manifest(json.dumps(changed).encode(), self.source_raw, self.package)

    def test_source_package_identity_must_match(self):
        with self.assertRaises(check.CheckError):
            check.verify_manifest(self.raw, self.source_raw, {**self.package, "mcpName": "io.github.other/server"})

    def test_dispatch_accepts_only_reviewed_exact_tag_and_commit(self):
        environment = self.environment()
        self.assertEqual(check.verify_dispatch(environment, "a" * 40), "a" * 40)
        for field, value in (
            ("REVIEWED_COMMIT", "$(touch /tmp/not-executed)"),
            ("REVIEWED_COMMIT", "a" * 39), ("GITHUB_REF", "refs/heads/main"),
            ("GITHUB_REF", "refs/tags/v0.1.0"), ("GITHUB_SHA", "b" * 40),
            ("GITHUB_WORKFLOW_SHA", "b" * 40), ("GITHUB_EVENT_NAME", "push"),
            ("GITHUB_REPOSITORY", "other/proxy-toolkit-mcp"), ("GITHUB_WORKFLOW_REF", "other/workflow"),
        ):
            with self.subTest(field=field, value=value), self.assertRaises(check.CheckError):
                check.verify_dispatch({**environment, field: value}, "a" * 40)
        with self.assertRaises(check.CheckError):
            check.verify_dispatch(environment, "b" * 40)

    def test_public_metadata_identity_integrity_and_url_checks(self):
        check.verify_npm_metadata(self.metadata())
        for path, value in (
            (("name",), "@other/tool"), (("version",), "0.1.1"),
            (("mcpName",), "io.github.other/tool"), (("dist", "integrity"), "sha512-other"),
            (("dist", "tarball"), "http://127.0.0.1/private"),
            (("repository", "url"), "git+https://github.com/other/tool.git"),
        ):
            with self.subTest(path=path):
                metadata = self.metadata()
                target = metadata if len(path) == 1 else metadata[path[0]]
                target[path[-1]] = value
                with self.assertRaises(check.CheckError):
                    check.verify_npm_metadata(metadata)

    def test_archive_hashes_are_checked_before_tar_parsing(self):
        with patch.object(check.tarfile, "open", side_effect=AssertionError("must not open")):
            with self.assertRaises(check.CheckError):
                check.verify_archive(b"unreviewed archive", self.package, self.source_raw)

    def test_archive_contents_match_source_without_extraction(self):
        raw = self.archive()
        with self.fixture_digests(raw):
            check.verify_archive(raw, self.package, self.source_raw)
        changed = self.archive({**self.package, "mcpName": "io.github.other/tool"})
        with self.fixture_digests(changed), self.assertRaises(check.CheckError):
            check.verify_archive(changed, self.package, self.source_raw)

    def test_sha512_must_also_match_when_sha256_matches(self):
        raw = self.archive()
        with patch.object(check, "ARCHIVE_SHA256", hashlib.sha256(raw).hexdigest()):
            with self.assertRaises(check.CheckError):
                check.verify_archive(raw, self.package, self.source_raw)

    def test_invalid_public_metadata_stops_before_downloading_archive(self):
        calls = []
        def fetcher(url, _limit):
            calls.append(url)
            return json.dumps({**self.metadata(), "mcpName": "wrong"}).encode()
        with self.assertRaises(check.CheckError):
            check.check_public_npm(self.package, self.source_raw, fetcher)
        self.assertEqual(calls, [check.NPM_URL])

    def test_existing_version_refuses_republication(self):
        check.require_unpublished(lambda *_args, **_kwargs: None)
        with self.assertRaisesRegex(check.CheckError, "already exists"):
            check.require_unpublished(lambda *_args, **_kwargs: json.dumps(self.readback()).encode())

    def test_fixed_endpoints_and_bounded_response(self):
        with self.assertRaises(check.CheckError):
            check.fetch("https://invalid.example", 16)
        class Response(io.BytesIO):
            status = 200
        with patch.object(check.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = Response(b"12345")
            with self.assertRaisesRegex(check.CheckError, "size limit"):
                check.fetch(check.NPM_URL, 4)

    def test_only_explicit_404_counts_as_missing(self):
        with patch.object(check.urllib.request, "build_opener") as opener:
            for status in (301, 403, 404, 429, 500):
                opener.return_value.open.side_effect = urllib.error.HTTPError(check.REGISTRY_URL, status, "fixture", {}, None)
                with self.subTest(status=status):
                    if status == 404:
                        self.assertIsNone(check.fetch(check.REGISTRY_URL, 32, allow_missing=True))
                    else:
                        with self.assertRaises(check.CheckError):
                            check.fetch(check.REGISTRY_URL, 32, allow_missing=True)
            opener.return_value.open.side_effect = urllib.error.HTTPError(check.REGISTRY_URL, 404, "fixture", {}, None)
            with self.assertRaises(check.CheckError):
                check.fetch(check.REGISTRY_URL, 32)

    def test_readback_accepts_official_omitted_false_fields(self):
        response = self.readback()
        response["server"] = check.normalize_registry_manifest(response["server"])
        check.verify_readback(response, self.manifest)

    def test_readback_rejects_remote_changed_secret_or_inactive_version(self):
        remote = self.readback()
        remote["server"]["remotes"] = [{"type": "streamable-http", "url": "https://mcp.ipvolt.com/mcp"}]
        secret = self.readback()
        secret["server"]["packages"][0]["environmentVariables"][1]["isSecret"] = False
        inactive = self.readback()
        inactive["_meta"]["io.modelcontextprotocol.registry/official"]["status"] = "deprecated"
        stale = self.readback()
        stale["_meta"]["io.modelcontextprotocol.registry/official"]["isLatest"] = False
        for response in (remote, secret, inactive, stale):
            with self.subTest(response=response), self.assertRaises(check.CheckError):
                check.verify_readback(response, self.manifest)

    def test_duplicate_fields_and_invalid_constants_are_rejected(self):
        for raw in (b'{"name":"first","name":"second"}', b'{"value":NaN}'):
            with self.assertRaises(check.CheckError):
                check.parse_json(raw)

    def test_actual_workflow_auth_fragment_never_logs_publisher_output(self):
        workflow = (check.ROOT / ".github/workflows/publish-registry.yml").read_text()
        match = re.search(r'(?ms)^          if ! timeout --kill-after=5s 90s "\$publisher" login github-oidc.*?(?=^      - name:)', workflow)
        self.assertIsNotNone(match)
        # Execute the workflow's exact auth/publication commands with a fake publisher.
        # The timeout shim removes its options; subprocess.run still bounds the test.
        fragment = "set -euo pipefail\ntimeout() { shift; shift; \"$@\"; }\n" + textwrap.dedent(match.group())
        sentinel = "PRIVATE_REGISTRY_TOKEN_SENTINEL_DO_NOT_LOG"
        with tempfile.TemporaryDirectory(prefix="ipvolt-registry-test-") as temporary:
            publisher = Path(temporary) / "publisher"
            publisher.write_text("#!/usr/bin/env python3\nimport os, sys\n"
                                 "print(os.environ['IPVOLT_TEST_SENTINEL'])\n"
                                 "print(os.environ['IPVOLT_TEST_SENTINEL'], file=sys.stderr)\n"
                                 "sys.exit(1 if sys.argv[1] == os.environ['IPVOLT_TEST_FAIL'] else 0)\n")
            publisher.chmod(0o700)
            for failed in ("login", "publish", "none"):
                with self.subTest(failed=failed):
                    output = Path(temporary) / f"output-{failed}"
                    result = subprocess.run(["bash", "-c", fragment], capture_output=True, text=True, timeout=10,
                                            env={**os.environ, "publisher": str(publisher), "GITHUB_OUTPUT": str(output),
                                                 "IPVOLT_TEST_SENTINEL": sentinel, "IPVOLT_TEST_FAIL": failed})
                    self.assertNotIn(sentinel, result.stdout + result.stderr)
                    self.assertEqual(result.returncode, 0 if failed == "none" else 1)
                    self.assertEqual(output.exists(), failed != "login")
                    if output.exists():
                        self.assertEqual(output.read_text(), "attempted=true\n")


if __name__ == "__main__":
    unittest.main()
