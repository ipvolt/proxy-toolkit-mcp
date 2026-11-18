import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_registry_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class ReleaseChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = (check.ROOT / "server.json").read_bytes()
        cls.package_raw = (check.ROOT / "package.json").read_bytes()
        cls.manifest = check.check_local()
        cls.version = cls.manifest["version"]

    def environment(self):
        ref = check.release_ref(self.version)
        return {"REVIEWED_COMMIT": "a" * 40, "GITHUB_SHA": "a" * 40, "GITHUB_WORKFLOW_SHA": "a" * 40,
                "GITHUB_REF": ref, "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REPOSITORY": check.npm.REPOSITORY,
                "GITHUB_WORKFLOW_REF": f"{check.npm.REPOSITORY}/.github/workflows/{check.WORKFLOW}@{ref}"}

    def metadata(self):
        return {"name": check.npm.PACKAGE, "version": self.version, "mcpName": check.npm.MCP_NAME,
                "repository": {"type": "git", "url": "git+https://github.com/ipvolt/proxy-toolkit-mcp.git"},
                "dist": {"integrity": "sha512-" + "A" * 86 + "==",
                         "tarball": f"https://registry.npmjs.org/@ipvolt/proxy-toolkit-mcp/-/proxy-toolkit-mcp-{self.version}.tgz",
                         "attestations": {"provenance": {"predicateType": "https://slsa.dev/provenance/v1"}}}}

    def changed(self, **fields):
        return json.dumps({**self.manifest, **fields}).encode()

    def test_root_manifest_names_the_package_version_and_the_hosted_remote(self):
        self.assertEqual(self.manifest["version"], json.loads(self.package_raw)["version"])
        self.assertEqual(self.manifest["packages"][0]["version"], self.version)
        self.assertEqual(self.manifest["remotes"], check.REMOTES)
        self.assertLessEqual(len(self.manifest["description"]), 100)

    def test_changed_manifest_refused(self):
        package = {**self.manifest["packages"][0]}
        for fields in ({"version": "9.9.9"}, {"version": "1.0"}, {"version": "0.1.1"}, {"name": "io.github.other/proxy-toolkit"},
                       {"remotes": []}, {"remotes": [{"type": "streamable-http", "url": "https://invalid.example/mcp"}]},
                       {"websiteUrl": "https://invalid.example"}, {"description": "x" * 101}, {"description": ""},
                       {"repository": {"url": "https://github.com/other/proxy-toolkit-mcp", "source": "github"}},
                       {"packages": []}, {"packages": [package, package]},
                       {"packages": [{**package, "version": "0.1.0"}]},
                       {"packages": [{**package, "identifier": "@other/proxy-toolkit-mcp"}]},
                       {"packages": [{**package, "registryBaseUrl": "https://invalid.example"}]},
                       {"packages": [{**package, "transport": {"type": "sse"}}]}):
            with self.subTest(fields=sorted(fields)), self.assertRaises(check.CheckError):
                check.verify_manifest(self.changed(**fields), self.package_raw)

    def test_frozen_versions_are_never_republished(self):
        for version in check.FROZEN_VERSIONS:
            package = json.dumps({**json.loads(self.package_raw), "version": version}).encode()
            manifest = self.changed(version=version, packages=[{**self.manifest["packages"][0], "version": version}])
            with self.subTest(version=version), self.assertRaises(check.CheckError):
                check.verify_manifest(manifest, package)

    def test_only_this_versions_tag_and_exact_reviewed_commit_accepted(self):
        check.verify_dispatch(self.environment(), "a" * 40, self.version)
        for field, value in (("GITHUB_REF", "refs/tags/registry-hosted-v0.1.1"), ("GITHUB_REF", "refs/heads/main"),
                             ("GITHUB_REF", check.release_ref("9.9.9")), ("GITHUB_SHA", "b" * 40),
                             ("GITHUB_WORKFLOW_SHA", "b" * 40), ("GITHUB_EVENT_NAME", "push"),
                             ("GITHUB_REPOSITORY", "other/proxy-toolkit-mcp"), ("REVIEWED_COMMIT", "$(not-executed)"),
                             ("GITHUB_WORKFLOW_REF", f"{check.npm.REPOSITORY}/.github/workflows/publish-registry-hosted.yml@{check.release_ref(self.version)}")):
            with self.subTest(field=field, value=value), self.assertRaises(check.CheckError):
                check.verify_dispatch({**self.environment(), field: value}, "a" * 40, self.version)
        with self.assertRaises(check.CheckError):
            check.verify_dispatch(self.environment(), "b" * 40, self.version)

    def test_public_npm_metadata_must_be_this_package_and_version(self):
        self.assertTrue(check.verify_npm_metadata(self.metadata(), self.version).startswith("sha512-"))
        for field, value in (("name", "@other/proxy-toolkit-mcp"), ("version", "0.1.0"), ("mcpName", "io.github.other/x"),
                             ("repository", {"type": "git", "url": "https://github.com/other/repo.git"}),
                             ("dist", {**self.metadata()["dist"], "integrity": "sha1-x"}),
                             ("dist", {**self.metadata()["dist"], "tarball": "https://invalid.example/x.tgz"}),
                             ("dist", {key: value for key, value in self.metadata()["dist"].items() if key != "attestations"}),
                             ("dist", {**self.metadata()["dist"], "attestations": {"provenance": {"predicateType": "other"}}})):
            with self.subTest(field=field), self.assertRaises(check.CheckError):
                check.verify_npm_metadata({**self.metadata(), field: value}, self.version)

    def test_only_the_two_fixed_public_endpoints_are_fetched(self):
        for url in ("https://registry.npmjs.org/@other%2fpackage/0.2.0", "http://registry.npmjs.org/@ipvolt%2fproxy-toolkit-mcp/0.2.0",
                    "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.other%2Fx/versions/0.2.0",
                    check.npm_url(self.version) + "/../x", "https://invalid.example/"):
            with self.subTest(url=url), patch.object(check.urllib.request, "build_opener") as opener:
                with self.assertRaises(check.CheckError):
                    check.fetch_json(url)
                opener.assert_not_called()

    def test_an_existing_registry_version_stops_before_the_remote_check_and_any_publication(self):
        answers = {check.npm_url(self.version): self.metadata(), check.registry_url(self.version): {"server": self.manifest}}
        with patch.object(check, "check_local", return_value=self.manifest), \
                patch.object(check, "fetch_json", side_effect=lambda url, allow_missing=False: answers[url]), \
                patch.object(check, "check_remote") as remote, patch("sys.argv", ["check.py", "prepublish"]):
            with self.assertRaises(check.CheckError):
                check.main()
            remote.assert_not_called()

    def test_read_back_requires_the_exact_manifest_active_and_latest(self):
        official = "io.modelcontextprotocol.registry/official"
        good = {"server": self.manifest, "_meta": {official: {"status": "active", "isLatest": True}}}
        check.npm.verify_readback(good, self.manifest)
        for response in ({**good, "server": {**self.manifest, "description": "other"}},
                         {**good, "_meta": {official: {"status": "deleted", "isLatest": True}}},
                         {**good, "_meta": {official: {"status": "active", "isLatest": False}}}):
            with self.assertRaises(check.CheckError):
                check.npm.verify_readback(response, self.manifest)


if __name__ == "__main__":
    unittest.main()
