import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hosted_registry_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class HostedChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest, cls.package, cls.source = check.check_local()

    def environment(self):
        return {"REVIEWED_COMMIT": "a" * 40, "GITHUB_SHA": "a" * 40, "GITHUB_WORKFLOW_SHA": "a" * 40,
                "GITHUB_REF": check.RELEASE_REF, "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REPOSITORY": check.npm.REPOSITORY,
                "GITHUB_WORKFLOW_REF": f"{check.npm.REPOSITORY}/.github/workflows/publish-registry-hosted.yml@{check.RELEASE_REF}"}

    def previous(self):
        return {"server": check.npm.parse_json((check.ROOT / "registry/npm/server.json").read_bytes()),
                "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active", "isLatest": False}}}

    def test_new_registry_version_preserves_published_npm(self):
        self.assertEqual(self.manifest["version"], "0.1.1")
        self.assertEqual(self.manifest["packages"][0]["version"], "0.1.0")
        self.assertEqual(self.manifest["remotes"], [{"type": "streamable-http", "url": "https://mcp.ipvolt.com/mcp"}])
        self.assertEqual(self.manifest["packages"], json.loads(self.source)["packages"])

    def test_changed_registry_manifest_refused(self):
        for field, value in (("version", "0.1.0"), ("remotes", []), ("websiteUrl", "https://invalid.example")):
            with self.subTest(field=field), self.assertRaises(check.CheckError):
                check.verify_manifest(json.dumps({**self.manifest, field: value}).encode(), self.source)

    def test_only_hosted_tag_and_exact_reviewed_commit_accepted(self):
        check.verify_dispatch(self.environment(), "a" * 40)
        for field, value in (("GITHUB_REF", "refs/tags/registry-npm-v0.1.0"), ("GITHUB_REF", "refs/heads/main"),
                             ("GITHUB_SHA", "b" * 40), ("GITHUB_WORKFLOW_SHA", "b" * 40),
                             ("GITHUB_EVENT_NAME", "push"), ("REVIEWED_COMMIT", "$(not-executed)")):
            with self.subTest(field=field), self.assertRaises(check.CheckError):
                check.verify_dispatch({**self.environment(), field: value}, "a" * 40)

    def test_existing_version_remains_active_even_after_it_is_no_longer_latest(self):
        check.verify_previous(self.previous())
        for replacement in ({"version": "0.1.1"}, {"remotes": [{"url": "https://invalid.example"}]}):
            previous = self.previous()
            previous["server"].update(replacement)
            with self.assertRaises(check.CheckError):
                check.verify_previous(previous)

    def test_existing_new_version_prevents_remote_check_and_republication(self):
        with patch.object(check, "check_local", return_value=(self.manifest, self.package, self.source)), \
             patch.object(check.npm, "check_public_npm"), patch.object(check.npm, "fetch", return_value=json.dumps(self.previous()).encode()), \
             patch.object(check, "fetch_version", return_value={"server": self.manifest}), \
             patch.object(check, "check_remote") as remote, patch.object(check.sys, "argv", ["check.py", "prepublish"]):
            with self.assertRaisesRegex(check.CheckError, "already exists"):
                check.main()
            remote.assert_not_called()

    def test_remote_subprocess_receives_no_tokens_proxy_or_debug_environment(self):
        with patch.dict(os.environ, {"ACTIONS_ID_TOKEN_REQUEST_TOKEN": "PRIVATE_SENTINEL", "IPVOLT_PROXY_URL": "PRIVATE_SENTINEL",
                                     "NODE_OPTIONS": "--trace-tls", "IPVOLT_REGISTRY_NODE": "/controlled/node"}), \
             patch.object(check.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b'{"ok":true,"toolCalls":8}', b'')) as run:
            self.assertTrue(check.check_remote()["ok"])
            self.assertEqual(set(run.call_args.kwargs["env"]), {"PATH"})
            self.assertEqual(run.call_args.args[0][0], "/controlled/node")

    def test_remote_failure_output_is_not_reflected(self):
        failed = subprocess.CompletedProcess([], 1, b"PRIVATE_SENTINEL", b"PRIVATE_SENTINEL")
        with patch.object(check.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(check.CheckError, "^Public remote verification failed$"):
                check.check_remote()

    def test_combined_readback_requires_exact_active_latest_metadata(self):
        response = {"server": copy.deepcopy(self.manifest), "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active", "isLatest": True}}}
        check.npm.verify_readback(response, self.manifest)
        response["server"]["packages"][0]["version"] = "0.1.1"
        with self.assertRaises(check.CheckError):
            check.npm.verify_readback(response, self.manifest)

    def test_workflow_guard_runs_after_auth_and_blocks_publish_without_private_output(self):
        workflow = (check.ROOT / ".github/workflows/publish-registry-hosted.yml").read_text()
        match = re.search(r'(?ms)^          if ! timeout --kill-after=5s 90s "\$publisher" login github-oidc.*?(?=^      - name:)', workflow)
        self.assertIsNotNone(match)
        fragment = 'set -euo pipefail\ntimeout() { shift; shift; "$@"; }\npython3() { return "$IPVOLT_TEST_GUARD"; }\n' + textwrap.dedent(match.group())
        with tempfile.TemporaryDirectory(prefix="ipvolt-hosted-registry-test-") as temporary:
            publisher = Path(temporary) / "publisher"
            publisher.write_text("#!/usr/bin/env python3\nimport os, sys\nprint('PRIVATE_SENTINEL')\nprint('PRIVATE_SENTINEL', file=sys.stderr)\nsys.exit(1 if sys.argv[1] == os.environ['IPVOLT_TEST_FAIL'] else 0)\n")
            publisher.chmod(0o700)
            for failed, guard in (("login", "0"), ("none", "1"), ("publish", "0"), ("none", "0")):
                with self.subTest(failed=failed, guard=guard):
                    output = Path(temporary) / f"output-{failed}-{guard}"
                    result = subprocess.run(["bash", "-c", fragment], capture_output=True, text=True, timeout=10,
                                            env={**os.environ, "publisher": str(publisher), "GITHUB_OUTPUT": str(output),
                                                 "IPVOLT_TEST_FAIL": failed, "IPVOLT_TEST_GUARD": guard})
                    self.assertNotIn("PRIVATE_SENTINEL", result.stdout + result.stderr)
                    self.assertEqual(result.returncode, 0 if failed == "none" and guard == "0" else 1)
                    self.assertEqual(output.exists(), failed != "login" and guard == "0")


if __name__ == "__main__":
    unittest.main()
