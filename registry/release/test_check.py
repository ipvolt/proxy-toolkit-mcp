import base64
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("release_registry_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

OFFICIAL = "io.modelcontextprotocol.registry/official"
COMMIT = "c" * 40


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

    def integrity(self):
        return "sha512-" + base64.b64encode(bytes(range(64))).decode()

    def metadata(self):
        return {"name": check.npm.PACKAGE, "version": self.version, "mcpName": check.npm.MCP_NAME,
                "repository": {"type": "git", "url": "git+https://github.com/ipvolt/proxy-toolkit-mcp.git"},
                "dist": {"integrity": self.integrity(),
                         "tarball": f"https://registry.npmjs.org/@ipvolt/proxy-toolkit-mcp/-/proxy-toolkit-mcp-{self.version}.tgz",
                         "attestations": {"provenance": {"predicateType": check.PROVENANCE_TYPE}}}}

    def statement(self, **changes):
        value = {"predicateType": check.PROVENANCE_TYPE,
                 "subject": [{"name": f"pkg:npm/%40ipvolt/proxy-toolkit-mcp@{self.version}", "digest": {"sha512": bytes(range(64)).hex()}}],
                 "predicate": {"buildDefinition": {
                     "externalParameters": {"workflow": {"ref": f"refs/tags/v{self.version}", "repository": check.SOURCE_REPOSITORY,
                                                         "path": check.NPM_WORKFLOW}},
                     "resolvedDependencies": [{"uri": f"git+{check.SOURCE_REPOSITORY}@refs/tags/v{self.version}",
                                               "digest": {"gitCommit": COMMIT}}]}}}
        build = value["predicate"]["buildDefinition"]
        for key, change in changes.items():
            if key == "workflow":
                build["externalParameters"]["workflow"].update(change)
            elif key == "resolved":
                build["resolvedDependencies"] = change
            else:
                value[key] = change
        return value

    def attestations(self, *statements):
        entries = [{"predicateType": "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", "bundle": {}}]
        for statement in statements or (self.statement(),):
            payload = base64.b64encode(json.dumps(statement).encode()).decode()
            entries.append({"predicateType": check.PROVENANCE_TYPE, "bundle": {"dsseEnvelope": {"payload": payload}}})
        return {"attestations": entries}

    def published(self, version=None, **official):
        version = version or check.KNOWN_PUBLISHED_VERSION
        return {"server": {**self.manifest, "version": version}, "_meta": {OFFICIAL: {"status": "active", "isLatest": True, **official}}}

    def answers(self, **changes):
        value = {check.npm_url(self.version): self.metadata(), check.attestations_url(self.version): self.attestations(),
                 check.registry_url(check.KNOWN_PUBLISHED_VERSION): self.published(), check.registry_url(self.version): None}
        value.update(changes)
        return value

    def run_main(self, action, answers=None, remote=None):
        """Runs main() offline. Returns (check_local mock, remote mock, order of calls)."""
        answers = self.answers() if answers is None else answers
        order = []

        def fetch(url, allow_missing=False):
            order.append(url)
            result = answers[url]
            if result is None and not allow_missing:
                raise check.CheckError("missing")
            return result

        def remote_check():
            order.append("remote")
            return remote or {"ok": True, "toolCalls": 8}

        with patch.object(check, "check_local", return_value=self.manifest) as local, \
                patch.object(check, "fetch_json", side_effect=fetch), \
                patch.object(check, "source_commit", return_value=COMMIT), \
                patch.object(check, "check_remote", side_effect=remote_check) as remote_mock, \
                patch("sys.argv", ["check.py", action]), patch("sys.stdout", new_callable=io.StringIO):
            check.main()
        return local, remote_mock, order

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

    def test_a_dispatched_checkout_must_be_clean_descend_from_the_source_tag_and_be_merged(self):
        def git_for(status=b"", fail=None):
            calls = []

            def git(*arguments):
                calls.append(arguments)
                if fail and arguments[:len(fail)] == fail:
                    raise check.CheckError("Frozen Git revision check failed")
                if arguments[0] == "rev-parse":
                    return (COMMIT if arguments[-1].startswith("refs/tags/") else "a" * 40).encode() + b"\n"
                return status if arguments[0] == "status" else b""
            return git, calls

        git, calls = git_for()
        with patch.object(check.npm, "git", side_effect=git), patch.dict(check.os.environ, self.environment(), clear=True):
            self.assertEqual(check.check_local(dispatch=True)["version"], self.version)
        self.assertIn(("rev-parse", "--verify", f"refs/tags/v{self.version}^{{commit}}"), calls)
        self.assertIn(("merge-base", "--is-ancestor", COMMIT, "HEAD"), calls)
        self.assertIn(("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"), calls)
        for name, arguments in (("modified checkout", {"status": b" M server.json\n"}),
                                ("source tag missing", {"fail": ("rev-parse", "--verify")}),
                                ("not a descendant of the source tag", {"fail": ("merge-base", "--is-ancestor", COMMIT)}),
                                ("not merged", {"fail": ("merge-base", "--is-ancestor", "HEAD")})):
            git, _calls = git_for(**arguments)
            with self.subTest(name=name), patch.object(check.npm, "git", side_effect=git), \
                    patch.dict(check.os.environ, self.environment(), clear=True), self.assertRaises(check.CheckError):
                check.check_local(dispatch=True)
        # Without a dispatch, nothing about Git or the environment is consulted.
        with patch.object(check.npm, "git", side_effect=AssertionError("git must not run")):
            check.check_local()

    def test_public_npm_metadata_must_be_this_package_and_version(self):
        self.assertEqual(check.verify_npm_metadata(self.metadata(), self.version), self.integrity())
        for field, value in (("name", "@other/proxy-toolkit-mcp"), ("version", "0.1.0"), ("mcpName", "io.github.other/x"),
                             ("repository", {"type": "git", "url": "https://github.com/other/repo.git"}),
                             ("dist", {**self.metadata()["dist"], "integrity": "sha1-x"}),
                             ("dist", {**self.metadata()["dist"], "tarball": "https://invalid.example/x.tgz"}),
                             ("dist", {key: value for key, value in self.metadata()["dist"].items() if key != "attestations"}),
                             ("dist", {**self.metadata()["dist"], "attestations": {"provenance": {"predicateType": "other"}}})):
            with self.subTest(field=field), self.assertRaises(check.CheckError):
                check.verify_npm_metadata({**self.metadata(), field: value}, self.version)

    def test_provenance_must_name_this_archive_repository_workflow_tag_and_commit(self):
        check.verify_provenance(self.attestations(), self.version, self.integrity(), COMMIT)
        bad = (("another commit", self.attestations(), "d" * 40),
               ("another repository", self.attestations(self.statement(workflow={"repository": "https://github.com/other/fork"})), COMMIT),
               ("another workflow", self.attestations(self.statement(workflow={"path": ".github/workflows/other.yml"})), COMMIT),
               ("another ref", self.attestations(self.statement(workflow={"ref": "refs/heads/main"})), COMMIT),
               ("another archive", self.attestations(self.statement(subject=[{"name": f"pkg:npm/%40ipvolt/proxy-toolkit-mcp@{self.version}", "digest": {"sha512": "00" * 64}}])), COMMIT),
               ("another package", self.attestations(self.statement(subject=[{"name": "pkg:npm/%40other/x@1.0.0", "digest": {"sha512": bytes(range(64)).hex()}}])), COMMIT),
               ("two dependencies", self.attestations(self.statement(resolved=[{"uri": "x", "digest": {"gitCommit": COMMIT}}] * 2)), COMMIT),
               ("another type inside", self.attestations(self.statement(predicateType="other")), COMMIT),
               ("two statements", self.attestations(self.statement(), self.statement()), COMMIT),
               ("no statement", {"attestations": []}, COMMIT),
               ("unreadable payload", {"attestations": [{"predicateType": check.PROVENANCE_TYPE, "bundle": {"dsseEnvelope": {"payload": "%%%"}}}]}, COMMIT),
               ("no bundle", {"attestations": [{"predicateType": check.PROVENANCE_TYPE}]}, COMMIT),
               ("not an object", [], COMMIT))
        for name, response, commit in bad:
            with self.subTest(name=name), self.assertRaises(check.CheckError):
                check.verify_provenance(response, self.version, self.integrity(), commit)
        with self.assertRaises(check.CheckError):
            check.verify_provenance(self.attestations(), self.version, "sha512-%%%", COMMIT)

    def test_only_the_fixed_public_endpoints_are_fetched(self):
        for url in ("https://registry.npmjs.org/@other%2fpackage/0.2.0", "http://registry.npmjs.org/@ipvolt%2fproxy-toolkit-mcp/0.2.0",
                    "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.other%2Fx/versions/0.2.0",
                    "https://registry.npmjs.org/-/npm/v1/attestations/@other%2fpackage@0.2.0",
                    check.npm_url(self.version) + "/../x", check.npm_url(self.version) + "?x=1", "https://invalid.example/"):
            with self.subTest(url=url), patch.object(check.urllib.request, "build_opener") as opener:
                with self.assertRaises(check.CheckError):
                    check.fetch_json(url)
                opener.assert_not_called()
        # The three addresses this guard builds are accepted, whatever the version.
        for version in (self.version, "0.1.1", "10.20.30"):
            for url in (check.npm_url(version), check.attestations_url(version), check.registry_url(version)):
                response = MagicMock(status=200)
                response.read.return_value = b'{"ok": true}'
                opener = MagicMock()
                opener.open.return_value.__enter__.return_value = response
                with self.subTest(url=url), patch.object(check.urllib.request, "build_opener", return_value=opener):
                    self.assertEqual(check.fetch_json(url), {"ok": True})

    def test_fetch_follows_no_redirect_uses_no_proxy_and_only_a_404_can_mean_missing(self):
        url = check.registry_url(self.version)

        def opener_raising(error):
            opener = MagicMock()
            opener.open.side_effect = error
            return opener

        def http(code):
            return urllib.error.HTTPError(url, code, "x", {}, None)

        with patch.object(check.urllib.request, "build_opener", return_value=opener_raising(http(404))) as build:
            self.assertIsNone(check.fetch_json(url, allow_missing=True))
            handlers = build.call_args.args
            self.assertTrue(any(isinstance(handler, check.npm.NoRedirect) for handler in handlers))
            self.assertTrue(any(isinstance(handler, urllib.request.ProxyHandler) and handler.proxies == {} for handler in handlers))
            with self.assertRaises(check.CheckError):
                check.fetch_json(url)
        for error in (http(500), http(403), http(302), urllib.error.URLError("down"), TimeoutError()):
            with self.subTest(error=repr(error)), patch.object(check.urllib.request, "build_opener", return_value=opener_raising(error)), \
                    self.assertRaises(check.CheckError):
                check.fetch_json(url, allow_missing=True)
        for status, body in ((204, b"{}"), (200, b"x" * 1048577), (200, b"not json")):
            response = MagicMock(status=status)
            response.read.return_value = body
            opener = MagicMock()
            opener.open.return_value.__enter__.return_value = response
            with self.subTest(status=status, size=len(body)), patch.object(check.urllib.request, "build_opener", return_value=opener), \
                    self.assertRaises(check.CheckError):
                check.fetch_json(url)

    def test_the_remote_check_gets_a_bare_environment_and_must_report_eight_calls_silently(self):
        def completed(returncode=0, stdout=b'{"ok": true, "toolCalls": 8}', stderr=b""):
            return subprocess.CompletedProcess([], returncode, stdout, stderr)

        with patch.dict(check.os.environ, {"PATH": "/bin", "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "secret", "NODE_OPTIONS": "--x"}, clear=True), \
                patch.object(check.subprocess, "run", return_value=completed()) as run:
            self.assertEqual(check.check_remote()["toolCalls"], 8)
            self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/bin"})
            self.assertEqual(run.call_args.args[0][1], str(check.ROOT / "registry/hosted/check-remote.mjs"))
        for result in (completed(returncode=1), completed(stderr=b"warning"), completed(stdout=b'{"ok": true, "toolCalls": 7}'),
                       completed(stdout=b'{"ok": false, "toolCalls": 8}'), completed(stdout=b"")):
            with self.subTest(result=result), patch.object(check.subprocess, "run", return_value=result), \
                    self.assertRaises(check.CheckError):
                check.check_remote()
        with patch.object(check.subprocess, "run", side_effect=subprocess.TimeoutExpired("node", 75)), self.assertRaises(check.CheckError):
            check.check_remote()

    def test_only_the_two_publishing_actions_demand_a_dispatch(self):
        for action, dispatch in (("local", False), ("public-npm", False), ("remote", False), ("preflight", True), ("prepublish", True)):
            local, _remote, _order = self.run_main(action)
            with self.subTest(action=action):
                local.assert_called_once_with(dispatch=dispatch)
        local, _remote, _order = self.run_main("read-back", self.answers(**{check.registry_url(self.version): self.published(self.version)}))
        local.assert_called_once_with(dispatch=False)

    def test_prepublish_checks_npm_provenance_the_known_version_the_unused_version_then_the_remote(self):
        _local, remote, order = self.run_main("prepublish")
        self.assertEqual(order, [check.npm_url(self.version), check.attestations_url(self.version),
                                 check.registry_url(check.KNOWN_PUBLISHED_VERSION), check.registry_url(self.version), "remote"])
        remote.assert_called_once_with()
        _local, remote, order = self.run_main("preflight")
        self.assertEqual(order[-1], check.registry_url(self.version))
        remote.assert_not_called()

    def test_a_failed_check_stops_before_the_remote_check(self):
        cases = {"the version is already published": {check.registry_url(self.version): self.published(self.version)},
                 "the known version is missing": {check.registry_url(check.KNOWN_PUBLISHED_VERSION): None},
                 "the known version is not active": {check.registry_url(check.KNOWN_PUBLISHED_VERSION): self.published(status="deleted")},
                 "the known version is another one": {check.registry_url(check.KNOWN_PUBLISHED_VERSION): self.published("0.1.0")},
                 "npm has another version": {check.npm_url(self.version): {**self.metadata(), "version": "0.1.0"}},
                 "the provenance names another commit": {check.attestations_url(self.version): self.attestations(self.statement(resolved=[{"uri": f"git+{check.SOURCE_REPOSITORY}@refs/tags/v{self.version}", "digest": {"gitCommit": "d" * 40}}]))}}
        for name, change in cases.items():
            order = []
            with self.subTest(name=name), self.assertRaises(check.CheckError):
                try:
                    _local, _remote, order = self.run_main("prepublish", self.answers(**change))
                finally:
                    self.assertNotIn("remote", order)

    def test_a_remote_failure_fails_prepublish(self):
        with patch.object(check, "check_local", return_value=self.manifest), \
                patch.object(check, "fetch_json", side_effect=lambda url, allow_missing=False: self.answers()[url]), \
                patch.object(check, "source_commit", return_value=COMMIT), \
                patch.object(check, "check_remote", side_effect=check.CheckError("Public remote verification failed")), \
                patch("sys.argv", ["check.py", "prepublish"]), self.assertRaises(check.CheckError):
            check.main()

    def test_read_back_requires_the_exact_manifest_active_and_latest(self):
        good = self.published(self.version)
        self.run_main("read-back", self.answers(**{check.registry_url(self.version): good}))
        for name, response in (("other metadata", {**good, "server": {**self.manifest, "description": "other"}}),
                               ("not active", self.published(self.version, status="deleted")),
                               ("not latest", self.published(self.version, isLatest=False)),
                               ("missing", None)):
            with self.subTest(name=name), self.assertRaises(check.CheckError):
                self.run_main("read-back", self.answers(**{check.registry_url(self.version): response}))


if __name__ == "__main__":
    unittest.main()
