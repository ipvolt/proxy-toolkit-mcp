import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("account_registry_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

OFFICIAL = "io.modelcontextprotocol.registry/official"
TOOLS = sorted([*check.BASE_TOOLS, *check.TRAFFIC_TOOLS, *check.PURCHASE_TOOLS])


class AccountChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = (check.ROOT / check.MANIFEST).read_bytes()
        cls.manifest = check.check_local()
        cls.version = cls.manifest["version"]

    def changed(self, change):
        manifest = json.loads(self.raw)
        change(manifest)
        return json.dumps(manifest).encode()

    def environment(self):
        ref = check.release_ref(self.version)
        return {"REVIEWED_COMMIT": "a" * 40, "GITHUB_SHA": "a" * 40, "GITHUB_WORKFLOW_SHA": "a" * 40,
                "GITHUB_REF": ref, "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REPOSITORY": check.npm.REPOSITORY,
                "GITHUB_WORKFLOW_REF": f"{check.npm.REPOSITORY}/.github/workflows/{check.WORKFLOW}@{ref}"}

    def known(self):
        return {"server": {"name": "io.github.ipvolt/proxy-toolkit", "version": "0.1.1"}, "_meta": {OFFICIAL: {"status": "active"}}}

    def report(self, **change):
        return {"ok": True, "endpoint": check.ENDPOINT, "protocol": "2025-11-25", "serverName": check.SERVER_NAME,
                "serverVersion": self.version, "tools": TOOLS, "toolCalls": 4, **change}

    def completed(self, report, returncode=0, stderr=b""):
        return subprocess.CompletedProcess([], returncode, json.dumps(report).encode(), stderr)

    def test_the_entry_is_a_remote_only_listing_of_the_account_server(self):
        self.assertEqual(self.manifest["name"], "io.github.ipvolt/account")
        self.assertNotIn("packages", self.manifest)
        self.assertNotIn("repository", self.manifest)
        self.assertEqual([remote["url"] for remote in self.manifest["remotes"]], ["https://ipvolt.com/beta/mcp"])
        header = self.manifest["remotes"][0]["headers"][0]
        self.assertEqual((header["name"], header["isRequired"], header["isSecret"]), ("Authorization", False, True))
        # A different entry from the toolkit's, which keeps its own name and guard.
        self.assertNotEqual(self.manifest["name"], check.npm.MCP_NAME)
        self.assertEqual(check.release_ref("1.0.0"), "refs/tags/registry-account-v1.0.0")

    def test_changed_manifest_refused(self):
        def header(manifest):
            return manifest["remotes"][0]["headers"][0]
        changes = {
            "another name": lambda m: m.update(name="io.github.ipvolt/proxy-toolkit"),
            "another title": lambda m: m.update(title="ipvolt"),
            "another website": lambda m: m.update(websiteUrl="https://example.org"),
            "another schema": lambda m: m.update({"$schema": "https://example.org/schema.json"}),
            "a loose version": lambda m: m.update(version="1.0"),
            "a prerelease": lambda m: m.update(version="1.0.0-rc.1"),
            "a leading zero": lambda m: m.update(version="01.0.0"),
            "an empty description": lambda m: m.update(description=""),
            "a long description": lambda m: m.update(description="x" * 101),
            "a package": lambda m: m.update(packages=[]),
            "a repository": lambda m: m.update(repository={"url": "https://github.com/ipvolt/proxy-toolkit-mcp", "source": "github"}),
            "publisher metadata": lambda m: m.update(_meta={}),
            "no remote": lambda m: m.update(remotes=[]),
            "a second remote": lambda m: m["remotes"].append({"type": "sse", "url": "https://ipvolt.com/beta/sse"}),
            "another endpoint": lambda m: m["remotes"][0].update(url="https://mcp.ipvolt.com/mcp"),
            "a plain-HTTP endpoint": lambda m: m["remotes"][0].update(url="http://ipvolt.com/beta/mcp"),
            "another transport": lambda m: m["remotes"][0].update(type="sse"),
            "url variables": lambda m: m["remotes"][0].update(variables={}),
            "no header": lambda m: m["remotes"][0].update(headers=[]),
            "a second header": lambda m: m["remotes"][0]["headers"].append({"name": "X-Extra"}),
            "another header": lambda m: header(m).update(name="X-API-Key"),
            "a required credential": lambda m: header(m).update(isRequired=True),
            "a public credential": lambda m: header(m).update(isSecret=False),
            "a default credential": lambda m: header(m).update(default="Bearer x"),
            "a fixed credential": lambda m: header(m).update(value="Bearer x"),
            "a credential not said to be optional": lambda m: header(m).update(description="Set an ipvolt API key."),
            "a key-shaped placeholder": lambda m: header(m).update(placeholder="Bearer ipvolt_abcdefgh12345678"),
            "a long header description": lambda m: header(m).update(description="Optional. " + "x" * 400),
        }
        for name, change in changes.items():
            with self.subTest(name), self.assertRaises(check.CheckError):
                check.verify_manifest(self.changed(change))
        with self.assertRaises(check.CheckError):
            check.verify_manifest(self.raw.replace(b'"version"', b'"version": "9.9.9", "version"', 1))
        with self.assertRaises(check.CheckError):
            check.verify_manifest(b"[]")

    def test_wording_the_site_does_not_allow_is_refused_in_both_texts(self):
        for word in ("unlimited", "Instant", "guaranteed", "free trial", "OAuth", "ipvolt_abcdefgh1234", "IPV-ABCDE"):
            with self.subTest(word), self.assertRaises(check.CheckError):
                check.verify_manifest(self.changed(lambda m: m.update(description=f"Mobile proxies, {word}")))
            with self.subTest("header " + word), self.assertRaises(check.CheckError):
                check.verify_manifest(self.changed(
                    lambda m: m["remotes"][0]["headers"][0].update(description=f"Optional. {word}")))
        for text in (self.manifest["description"], self.manifest["remotes"][0]["headers"][0]["description"]):
            # Nothing names a supplier or promises a number of devices.
            self.assertNotRegex(text, r"(?i)coronium|proxies\.sx|supplier|\d+ (?:in stock|devices)")

    def test_only_this_versions_tag_and_exact_reviewed_commit_accepted(self):
        check.verify_dispatch(self.environment(), "a" * 40, self.version)
        toolkit_ref = f"refs/tags/registry-v{self.version}"
        for key, value in (("REVIEWED_COMMIT", "a" * 39), ("REVIEWED_COMMIT", "b" * 40), ("GITHUB_SHA", "b" * 40),
                           ("GITHUB_WORKFLOW_SHA", "b" * 40), ("GITHUB_EVENT_NAME", "push"),
                           ("GITHUB_REPOSITORY", "other/proxy-toolkit-mcp"), ("GITHUB_REF", "refs/heads/main"),
                           # The toolkit's tag and workflow publish the toolkit's entry, never this one.
                           ("GITHUB_REF", toolkit_ref),
                           ("GITHUB_REF", check.release_ref("9.9.9")),
                           ("GITHUB_WORKFLOW_REF", f"{check.npm.REPOSITORY}/.github/workflows/publish-registry-release.yml@{check.release_ref(self.version)}"),
                           ("GITHUB_WORKFLOW_REF", f"{check.npm.REPOSITORY}/.github/workflows/{check.WORKFLOW}@refs/heads/main")):
            with self.subTest(key=key, value=value), self.assertRaises(check.CheckError):
                check.verify_dispatch({**self.environment(), key: value}, "a" * 40, self.version)
        with self.assertRaises(check.CheckError):
            check.verify_dispatch(self.environment(), "b" * 40, self.version)

    def test_a_dispatched_checkout_must_be_clean_and_merged(self):
        def git(*arguments):
            calls.append(arguments)
            if arguments[0] == "rev-parse":
                return b"a" * 40 + b"\n"
            if arguments[0] == "status":
                return status
            if arguments[0] == "merge-base" and not merged:
                raise check.CheckError("Frozen Git revision check failed")
            return b""
        for status, merged, accepted in ((b"", True, True), (b" M registry/account/server.json\n", True, False), (b"", False, False)):
            calls = []
            with self.subTest(status=status, merged=merged), patch.object(check.npm, "git", side_effect=git), \
                    patch.dict(check.os.environ, self.environment(), clear=True):
                if accepted:
                    check.check_local(dispatch=True)
                    self.assertIn(("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"), calls)
                else:
                    with self.assertRaises(check.CheckError):
                        check.check_local(dispatch=True)
        # Without a dispatch nothing is asked of Git or the environment.
        with patch.object(check.npm, "git", side_effect=AssertionError("git must not run")):
            check.check_local()

    def test_only_the_fixed_public_endpoints_are_fetched(self):
        opener = MagicMock()
        response = MagicMock()
        response.status = 200
        response.read.return_value = b"{}"
        opener.open.return_value.__enter__.return_value = response
        with patch.object(check.urllib.request, "build_opener", return_value=opener):
            for url in (check.KNOWN_URL, check.registry_url("1.0.0"), check.registry_url("12.34.56")):
                self.assertEqual(check.fetch_json(url), {})
            for url in ("https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ipvolt%2Fproxy-toolkit/versions/0.3.0",
                        "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.other%2Faccount/versions/1.0.0",
                        check.registry_url("1.0.0") + "?x=1", check.registry_url("1.0.0").replace("https://", "http://"),
                        "https://example.org/v0.1/servers/io.github.ipvolt%2Faccount/versions/1.0.0",
                        check.registry_url("latest"), "https://ipvolt.com/beta/mcp"):
                with self.subTest(url), self.assertRaises(check.CheckError):
                    check.fetch_json(url)
        self.assertEqual(opener.open.call_count, 3)

    def test_fetch_follows_no_redirect_uses_no_proxy_and_only_a_404_can_mean_missing(self):
        with patch.object(check.urllib.request, "build_opener") as build:
            opener = build.return_value
            opener.open.side_effect = urllib.error.HTTPError(check.registry_url("1.0.0"), 404, "Not Found", {}, io.BytesIO())
            self.assertIsNone(check.fetch_json(check.registry_url("1.0.0"), allow_missing=True))
            handlers = build.call_args.args
            self.assertTrue(any(isinstance(handler, check.npm.NoRedirect) for handler in handlers))
            self.assertTrue(any(isinstance(handler, urllib.request.ProxyHandler) and handler.proxies == {} for handler in handlers))
            with self.assertRaises(check.CheckError):
                check.fetch_json(check.registry_url("1.0.0"))
            for code in (301, 403, 429, 500):
                opener.open.side_effect = urllib.error.HTTPError(check.registry_url("1.0.0"), code, "x", {}, io.BytesIO())
                with self.subTest(code), self.assertRaises(check.CheckError):
                    check.fetch_json(check.registry_url("1.0.0"), allow_missing=True)
            opener.open.side_effect = urllib.error.URLError("down")
            with self.assertRaises(check.CheckError):
                check.fetch_json(check.registry_url("1.0.0"), allow_missing=True)

    def test_the_registry_must_answer_for_the_known_entry_before_a_404_counts(self):
        answers = {}

        def fetcher(url, allow_missing=False):
            self.assertEqual(allow_missing, url != check.KNOWN_URL)
            return answers[url]
        answers.update({check.KNOWN_URL: self.known(), check.registry_url(self.version): None})
        check.require_unpublished(self.version, fetcher)
        for name, known in (("empty", {}), ("another name", {**self.known(), "server": {"name": "x", "version": "0.1.1"}}),
                            ("another version", {**self.known(), "server": {"name": "io.github.ipvolt/proxy-toolkit", "version": "0.3.0"}}),
                            ("deleted", {**self.known(), "_meta": {OFFICIAL: {"status": "deleted"}}}), ("a list", [])):
            answers[check.KNOWN_URL] = known
            with self.subTest(name), self.assertRaises(check.CheckError):
                check.require_unpublished(self.version, fetcher)
        answers.update({check.KNOWN_URL: self.known(), check.registry_url(self.version): {"server": {}}})
        with self.assertRaisesRegex(check.CheckError, "already exists; inspect read-back before any retry"):
            check.require_unpublished(self.version, fetcher)

    def test_the_remote_check_gets_a_bare_environment_and_must_report_this_server_and_version(self):
        with patch.dict(check.os.environ, {"PATH": "/usr/bin", "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "secret", "HTTPS_PROXY": "http://x"},
                        clear=True), patch.object(check.subprocess, "run", return_value=self.completed(self.report())) as run:
            self.assertEqual(check.check_remote(self.version)["serverVersion"], self.version)
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/bin"})
        self.assertEqual(run.call_args.args[0][1:], [str(check.ROOT / "registry/account/check-remote.mjs")])
        self.assertLessEqual(run.call_args.kwargs["timeout"], 75)
        refused = {
            "not ok": self.completed(self.report(ok=False)),
            "another endpoint": self.completed(self.report(endpoint="https://mcp.ipvolt.com/mcp")),
            "another server": self.completed(self.report(serverName="ipvolt-proxy-toolkit")),
            "another version": self.completed(self.report(serverVersion="1.0.1")),
            "fewer calls": self.completed(self.report(toolCalls=3)),
            "a missing tool": self.completed(self.report(tools=[name for name in TOOLS if name != "rent_proxy"])),
            "an unreviewed tool": self.completed(self.report(tools=[*TOOLS, "delete_account"])),
            "a repeated tool": self.completed(self.report(tools=[*TOOLS, "list_stock"])),
            "tools not a list": self.completed(self.report(tools="list_stock")),
            "one purchase tool without the other": self.completed(self.report(tools=[name for name in TOOLS if name != "get_purchase"])),
            "a failed child": self.completed(self.report(), returncode=1),
            "a noisy child": self.completed(self.report(), stderr=b"warning"),
            "not JSON": subprocess.CompletedProcess([], 0, b"ok", b""),
        }
        for name, result in refused.items():
            with self.subTest(name), patch.object(check.subprocess, "run", return_value=result), self.assertRaises(check.CheckError):
                check.check_remote(self.version)
        with patch.object(check.subprocess, "run", side_effect=subprocess.TimeoutExpired("node", 75)), self.assertRaises(check.CheckError):
            check.check_remote(self.version)
        # Without the traffic tools, or without the two purchase tools, the server is still the reviewed one.
        for tools in (check.BASE_TOOLS, (*check.BASE_TOOLS, *check.TRAFFIC_TOOLS), (*check.BASE_TOOLS, *check.PURCHASE_TOOLS)):
            with patch.object(check.subprocess, "run", return_value=self.completed(self.report(tools=sorted(tools)))):
                check.check_remote(self.version)

    def run_main(self, action, **patches):
        defaults = {"check_local": MagicMock(return_value=self.manifest), "require_unpublished": MagicMock(),
                    "check_remote": MagicMock(return_value=self.report()), "fetch_json": MagicMock(), "verify_readback": MagicMock()}
        defaults.update(patches)
        with patch.multiple(check, **defaults), patch.object(check.sys, "argv", ["check.py", action]), \
                patch("builtins.print") as printed:
            check.main()
        return defaults, json.loads(printed.call_args.args[0])

    def test_only_the_two_publishing_actions_demand_a_dispatch_and_an_unused_version(self):
        for action, dispatch in (("local", False), ("remote", False), ("read-back", False), ("preflight", True), ("prepublish", True)):
            mocks, output = self.run_main(action)
            with self.subTest(action):
                mocks["check_local"].assert_called_once_with(dispatch=dispatch)
                self.assertEqual(mocks["require_unpublished"].called, dispatch)
                self.assertEqual(mocks["check_remote"].called, action in ("remote", "prepublish"))
                self.assertEqual(mocks["verify_readback"].called, action == "read-back")
                self.assertEqual((output["ok"], output["name"], output["registryVersion"]), (True, "io.github.ipvolt/account", self.version))

    def test_a_failed_check_stops_before_the_remote_check_and_a_remote_failure_fails_prepublish(self):
        remote = MagicMock()
        with self.assertRaises(check.CheckError):
            self.run_main("prepublish", require_unpublished=MagicMock(side_effect=check.CheckError("exists")), check_remote=remote)
        remote.assert_not_called()
        with self.assertRaises(check.CheckError):
            self.run_main("prepublish", check_local=MagicMock(side_effect=check.CheckError("dirty")), check_remote=remote)
        remote.assert_not_called()
        with self.assertRaises(check.CheckError):
            self.run_main("prepublish", check_remote=MagicMock(side_effect=check.CheckError("remote")))

    def test_read_back_requires_the_exact_manifest_active_and_latest(self):
        def response(server=None, **official):
            return {"server": server if server is not None else copy.deepcopy(self.manifest),
                    "_meta": {OFFICIAL: {"status": "active", "isLatest": True, **official}}}
        check.verify_readback(response(), self.manifest)
        # The publisher drops false booleans; that is the same entry.
        dropped = copy.deepcopy(self.manifest)
        del dropped["remotes"][0]["headers"][0]["isRequired"]
        check.verify_readback(response(dropped), self.manifest)
        secret_dropped = copy.deepcopy(dropped)
        del secret_dropped["remotes"][0]["headers"][0]["isSecret"]
        other = copy.deepcopy(self.manifest)
        other["description"] = "Something else"
        for name, value in (("a dropped secret flag", response(secret_dropped)), ("another description", response(other)),
                            ("deprecated", response(status="deprecated")), ("not latest", response(isLatest=False)),
                            ("no metadata", {"server": copy.deepcopy(self.manifest)}), ("a list", [])):
            with self.subTest(name), self.assertRaises(check.CheckError):
                check.verify_readback(value, self.manifest)

    def test_the_workflow_publishes_only_this_file_after_the_guard_and_never_retries(self):
        workflow = (check.ROOT / ".github/workflows" / check.WORKFLOW).read_text()
        self.assertIn("if: github.repository == 'ipvolt/proxy-toolkit-mcp'", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotRegex(workflow, r"(?m)^\s*(push|pull_request|schedule|workflow_run):")
        self.assertEqual(workflow.count('"$publisher" publish '), 1)
        self.assertIn('"$publisher" publish registry/account/server.json', workflow)
        self.assertIn('"$publisher" validate registry/account/server.json', workflow)
        # The toolkit's own entry is never published from here.
        self.assertNotRegex(workflow, r'publish server\.json|validate server\.json|registry/release/check\.py')
        order = [workflow.index(step) for step in ("registry/account/check.py preflight", "login github-oidc",
                                                   "registry/account/check.py prepublish", '"$publisher" publish ',
                                                   "registry/account/check.py read-back")]
        self.assertEqual(order, sorted(order))
        self.assertIn("a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc", workflow)
        self.assertIn("group: official-mcp-registry-release", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertEqual(workflow.count("id-token: write"), 1)
        for action in set(__import__("re").findall(r"uses: (\S+)", workflow)):
            self.assertRegex(action, r"@[0-9a-f]{40}$", "actions are pinned to a commit")
        self.assertNotIn("secrets.", workflow)


if __name__ == "__main__":
    unittest.main()
