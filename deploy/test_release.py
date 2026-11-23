"""Offline filesystem/systemd/Caddy simulations; never contact the VPS."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
import select
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("mcp_deploy", Path(__file__).with_name("release.py"))
deploy = importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name] = deploy
SPEC.loader.exec_module(deploy)


class FakeHost(deploy.Host):
    def __init__(self):
        self.is_running = False
        self.is_enabled = False
        self.calls = []
        self.fail_candidate = False
        self.fail_health = 0
        self.fail_reload = 0
        self.fail_public = 0
        self.after_candidate = None
        self.prior_host = False

    def run(self, args, check=True):
        self.calls.append(args)
        if args[:2] == ["systemctl", "stop"]: self.is_running = False
        if args[:2] == ["systemctl", "restart"]: self.is_running = True
        if args[:2] == ["systemctl", "enable"]: self.is_enabled = True
        if args[:2] == ["systemctl", "disable"]: self.is_enabled = False
        if args == ["systemctl", "reload", "caddy"] and self.fail_reload:
            self.fail_reload -= 1
            raise deploy.DeploymentError("Simulated reload failure")
        return subprocess.CompletedProcess(args, 0, "", "")

    def validate_caddy(self, candidate):
        data = candidate.read_bytes()
        self.calls.append(["validate", str(candidate)])
        if b"SYNTAX_ERROR" in data: raise deploy.DeploymentError("Simulated Caddy syntax failure")
        return {"hosts": [deploy.DOMAIN]} if self.prior_host else {}

    def account(self): self.calls.append(["account"])
    def enabled(self): return self.is_enabled
    def running(self): return self.is_running
    def dns(self, address):
        if address != "192.0.2.8": raise deploy.DeploymentError("Simulated DNS mismatch")
    def health(self, port, manifest):
        self.calls.append(["health", port, manifest["release"]])
        if self.fail_health:
            self.fail_health -= 1
            raise deploy.DeploymentError("Simulated health failure")
    def candidate(self, paths, target, unit, manifest):
        self.calls.append(["candidate", manifest["release"]])
        if self.fail_candidate: raise deploy.DeploymentError("Simulated candidate failure")
        if self.after_candidate: self.after_candidate()
    def public_health(self):
        self.calls.append(["public-health"])
        if self.fail_public:
            self.fail_public -= 1
            raise deploy.DeploymentError("Simulated HTTPS boundary failure")


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ipvolt-mcp-deploy-test-")
        self.root = Path(self.temporary.name).resolve()
        self.paths = deploy.Paths(self.root / "host")
        self.host = FakeHost()
        for relative in ("etc/caddy", "etc/systemd/system", "run/systemd/system", "opt/ipvolt-website/releases/website-base"):
            self.paths.at(relative).mkdir(parents=True)
        self.paths.website.symlink_to(self.paths.at("opt/ipvolt-website/releases/website-base"))
        self.original_caddy = b"{\n    admin 127.0.0.1:2019\n}\nimport sites-enabled/*\n# exact unrelated trailing bytes"
        self.paths.caddy.write_bytes(self.original_caddy)
        self.source = self.root / "source"
        self.source.mkdir()
        for directory in ("dist/transports", "content", "node_modules", "deploy"):
            (self.source / directory).mkdir(parents=True)
        (self.source / "dist/transports/http.js").write_text("// controlled fake runtime\n")
        (self.source / "package.json").write_text(json.dumps({"name": "@ipvolt/proxy-toolkit-mcp", "version": "0.1.0"}))
        (self.source / "package-lock.json").write_text("{}")
        (self.source / "content/catalog.json").write_text(json.dumps({"sourceRelease": "public-content-base"}))
        for name in ("ipvolt-mcp.service", "ipvolt-mcp.env", "ipvolt-mcp.caddy", "check-host-isolation.mjs"):
            shutil.copyfile(Path(__file__).with_name(name), self.source / "deploy" / name)

    def tearDown(self):
        for item in self.root.rglob("*"):
            if item.is_dir() and not item.is_symlink(): item.chmod(0o755)
        self.temporary.cleanup()

    def stage(self, release="first", mcp="none"):
        return deploy.stage(self.paths, self.source, release, "website-base", mcp)

    def activate(self, release="first", mcp="none"):
        manifest = self.stage(release, mcp)
        return deploy.activate(self.paths, self.host, release, manifest["sha256"], "website-base", mcp, "/usr/local/bin/node", "192.0.2.8")

    def test_first_install_preserves_caddy_and_freezes_runtime(self):
        result = self.activate()
        self.assertTrue(self.paths.caddy.read_bytes().startswith(self.original_caddy))
        self.assertEqual(self.paths.current.resolve(), self.paths.releases / "first")
        self.assertTrue(self.host.running())
        self.assertTrue(self.host.enabled())
        self.assertEqual(stat.S_IMODE(self.paths.env.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.paths.releases / "first/package.json").stat().st_mode), 0o444)
        self.assertEqual(json.loads(self.paths.active.read_text())["transaction"], result["transaction"])
        self.assertLess(self.host.calls.index(["candidate", "first"]), self.host.calls.index(["systemctl", "restart", deploy.SERVICE]))

    def test_stale_website_and_mcp_fail_before_staging(self):
        with self.assertRaises(deploy.DeploymentError): deploy.stage(self.paths, self.source, "first", "other-release", "none")
        self.assertFalse(self.paths.releases.exists())
        with self.assertRaises(deploy.DeploymentError): self.stage(mcp="unexpected")

    def test_staged_release_and_reviewed_hash_cannot_be_overwritten(self):
        manifest = self.stage()
        with self.assertRaises(deploy.DeploymentError): self.stage()
        with self.assertRaises(deploy.DeploymentError): deploy.verify_artifact(self.paths, "first", "0" * 64)
        changed = self.paths.releases / "first/package.json"
        changed.chmod(0o644); changed.write_text("{}")
        with self.assertRaises(deploy.DeploymentError): deploy.verify_artifact(self.paths, "first", manifest["sha256"])

    def test_writable_artifact_is_rejected_even_when_bytes_match(self):
        manifest = self.stage()
        (self.paths.releases / "first/package.json").chmod(0o644)
        with self.assertRaisesRegex(deploy.DeploymentError, "immutable permissions"): deploy.verify_artifact(self.paths, "first", manifest["sha256"])

    def test_symlink_and_private_environment_are_not_copied(self):
        outside = self.root / "private-file"; outside.write_text("SENTINEL")
        (self.source / "node_modules/escape").symlink_to(outside)
        with self.assertRaises(deploy.DeploymentError): self.stage()
        self.assertFalse((self.paths.releases / "first").exists())
        (self.source / "node_modules/escape").unlink()
        (self.source / "node_modules/.env").write_text("SENTINEL")
        with self.assertRaises(deploy.DeploymentError): self.stage()

    def test_existing_user_file_and_ambiguous_host_are_preserved(self):
        self.paths.env.write_text("existing operator file")
        with self.assertRaises(deploy.DeploymentError): self.activate()
        self.assertEqual(self.paths.env.read_text(), "existing operator file")
        self.assertEqual(self.paths.caddy.read_bytes(), self.original_caddy)
        self.paths.env.unlink(); self.host.prior_host = True
        with self.assertRaises(deploy.DeploymentError): self.activate("second")
        self.assertFalse(self.paths.current.exists())

    def test_candidate_failure_never_changes_active_files(self):
        self.host.fail_candidate = True
        with self.assertRaises(deploy.DeploymentError): self.activate()
        self.assertEqual(self.paths.caddy.read_bytes(), self.original_caddy)
        self.assertFalse(self.paths.current.exists())
        self.assertFalse(self.paths.env.exists())
        self.assertFalse(self.paths.unit.exists())

    def test_candidate_uses_release_symlink_and_cleans_it_on_health_failure(self):
        manifest = self.stage()
        target = self.paths.releases / "first"
        unit = (target / "deploy/ipvolt-mcp.service").read_text().replace("/opt/ipvolt-mcp/current", str(self.paths.current))
        candidate_unit = self.paths.at("run/systemd/system/ipvolt-mcp-candidate-first.service")
        candidate_link = self.paths.at("run/ipvolt-mcp-candidate-first")
        host = deploy.Host()

        def check_candidate(*_args):
            self.assertTrue(candidate_link.is_symlink())
            self.assertEqual(candidate_link.resolve(), target)
            self.assertIn(f"WorkingDirectory={candidate_link}", candidate_unit.read_text())
            self.assertIn(f"{candidate_link}/dist/transports/http.js", candidate_unit.read_text())
            self.assertFalse(self.paths.current.exists())
            raise deploy.DeploymentError("Controlled candidate health failure")

        with patch.object(host, "run", return_value=subprocess.CompletedProcess([], 0, "", "")), patch.object(host, "health", side_effect=check_candidate):
            with self.assertRaisesRegex(deploy.DeploymentError, "Controlled candidate health failure"):
                host.candidate(self.paths, target, unit, manifest)
        self.assertFalse(candidate_unit.exists())
        self.assertFalse(candidate_link.exists() or candidate_link.is_symlink())
        self.assertFalse(self.paths.current.exists())

    def test_existing_candidate_link_is_preserved(self):
        manifest = self.stage()
        candidate_link = self.paths.at("run/ipvolt-mcp-candidate-first")
        candidate_link.symlink_to(self.root / "missing-operator-target")
        with self.assertRaisesRegex(deploy.DeploymentError, "candidate release link"):
            deploy.Host().candidate(self.paths, self.paths.releases / "first", "", manifest)
        self.assertTrue(candidate_link.is_symlink())
        self.assertEqual(candidate_link.readlink(), self.root / "missing-operator-target")

    def test_validate_runs_candidate_without_dns_or_active_state_mutation(self):
        manifest = self.stage()
        def no_public_action(*_args): raise AssertionError("Inactive validation must not check DNS or public TLS.")
        self.host.dns = no_public_action
        self.host.public_health = no_public_action
        result = deploy.validate_candidate(self.paths, self.host, "first", manifest["sha256"], "website-base", "none", "/usr/local/bin/node")
        self.assertEqual(result, {"release": "first", "artifact": manifest["sha256"], "candidateValidated": True, "activated": False})
        self.assertIn(["account"], self.host.calls)
        self.assertIn(["candidate", "first"], self.host.calls)
        self.assertNotIn(["systemctl", "reload", "caddy"], self.host.calls)
        self.assertNotIn(["systemctl", "restart", deploy.SERVICE], self.host.calls)
        self.assertEqual(self.paths.caddy.read_bytes(), self.original_caddy)
        for path in (self.paths.current, self.paths.unit, self.paths.env, self.paths.active): self.assertFalse(path.exists() or path.is_symlink())
        self.assertFalse(self.host.enabled()); self.assertFalse(self.host.running())

    def test_first_install_health_failure_restores_absence(self):
        self.host.fail_health = 1
        with self.assertRaisesRegex(deploy.DeploymentError, "restored and verified"): self.activate()
        self.assertEqual(self.paths.caddy.read_bytes(), self.original_caddy)
        self.assertFalse(self.paths.current.is_symlink())
        self.assertFalse(self.paths.env.exists()); self.assertFalse(self.paths.unit.exists()); self.assertFalse(self.paths.active.exists())
        self.assertFalse(self.host.enabled()); self.assertFalse(self.host.running())

    def test_failed_caddy_reload_restores_existing_release_and_configuration(self):
        self.activate()
        previous = {name: getattr(self.paths, name).read_bytes() for name in ("caddy", "unit", "env", "active")}
        self.host.fail_reload = 1
        with self.assertRaisesRegex(deploy.DeploymentError, "restored and verified"): self.activate("second", "first")
        for name, data in previous.items(): self.assertEqual(getattr(self.paths, name).read_bytes(), data)
        self.assertEqual(self.paths.current.resolve().name, "first")
        self.assertIn(["health", 3040, "first"], self.host.calls)
        self.assertTrue(self.host.enabled()); self.assertTrue(self.host.running())

    def test_public_tls_boundary_failure_restores_existing_release(self):
        self.activate(); self.host.fail_public = 1
        with self.assertRaisesRegex(deploy.DeploymentError, "restored and verified"): self.activate("second", "first")
        self.assertEqual(self.paths.current.resolve().name, "first")

    def test_manual_rollback_preserves_later_unrelated_caddy_edits(self):
        self.activate(); upgraded = self.activate("second", "first")
        extra = b"\nnew-unrelated.example { respond 204 }\n"
        self.paths.caddy.write_bytes(self.paths.caddy.read_bytes() + extra)
        result = deploy.rollback(self.paths, self.host, upgraded["transaction"], "website-base", "second")
        self.assertEqual(result["restoredRelease"], "first")
        self.assertTrue(self.paths.caddy.read_bytes().endswith(extra))
        self.assertEqual(self.paths.caddy.read_bytes().count(deploy.BEGIN), 1)

    def test_unexpected_current_file_and_managed_edits_refuse_rollback(self):
        self.activate(); upgraded = self.activate("second", "first")
        self.paths.env.write_text("operator edit")
        with self.assertRaises(deploy.DeploymentError): deploy.rollback(self.paths, self.host, upgraded["transaction"], "website-base", "second")
        self.assertEqual(self.paths.env.read_text(), "operator edit")
        self.paths.current.unlink(); self.paths.current.write_text("operator file")
        with self.assertRaises(deploy.DeploymentError): deploy.expected(self.paths, "website-base", "second")

    def test_shared_config_change_during_validation_aborts_cutover(self):
        self.host.after_candidate = lambda: self.paths.caddy.write_bytes(self.original_caddy + b"\n# operator update\n")
        with self.assertRaisesRegex(deploy.DeploymentError, "changed during"): self.activate()
        self.assertTrue(self.paths.caddy.read_bytes().endswith(b"# operator update\n"))
        self.assertFalse(self.paths.current.exists())

    AUTOFIX = "20261113-secfix-202611130000-09ae51"

    def package(self, root, place, version, name=None):
        folder = root / "node_modules" / place; folder.mkdir(parents=True, exist_ok=True)
        (folder / "package.json").write_text(json.dumps({"name": name or place.rsplit("node_modules/", 1)[-1], "version": version}))
        (folder / "index.js").write_text("// " + version + "\n")

    def prepare(self, version="4.0.0", **others):
        shutil.rmtree(self.source / "node_modules"); (self.source / "node_modules").mkdir()
        self.package(self.source, "zod", version)
        for place, other in others.items(): self.package(self.source, place.replace("__", "/"), other)

    def autofix(self, base="first", name=None, version="4.0.1", change=None):
        """What the security autofix does: copy the live release, replace its dependencies, move current, record nothing."""
        target = self.paths.releases / (name or self.AUTOFIX)
        shutil.copytree(self.paths.releases / base, target)
        for item in [target, *target.rglob("*")]: item.chmod(0o755 if item.is_dir() else 0o644)
        package = json.loads((target / "package.json").read_text()); package["dependencies"] = {"zod": version}
        package["overrides"] = {"zod": version}; package["devDependencies"] = {"tsx": "9.0.0"}; package["optionalDependencies"] = {}
        (target / "package.json").write_text(json.dumps(package)); (target / "package-lock.json").write_text(json.dumps({"lock": version}))
        self.package(target, "zod", version); (target / "node_modules/.package-lock.json").write_text("{}")
        if change: change(target)
        for item in [target, *target.rglob("*")]:
            if not item.is_symlink(): item.chmod(0o555 if item.is_dir() else 0o444)
        self.paths.current.unlink(); self.paths.current.symlink_to(target)
        return target.name

    def unlocked(self, path, action):
        parent = path.parent; parent.chmod(0o755)
        if path.exists(): path.chmod(0o644)
        action()
        if path.exists(): path.chmod(0o444)
        parent.chmod(0o555)

    def transaction(self, result): return self.paths.state / "transactions" / (result["transaction"] + ".json")

    def test_update_from_an_autofix_release_is_accepted_and_recorded(self):
        self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1")
        result = self.activate("second", live)
        self.assertEqual(self.paths.current.resolve().name, "second")
        self.assertEqual(json.loads(self.paths.active.read_text())["release"], "second")
        record = json.loads(self.transaction(result).read_text())
        self.assertEqual(record["oldRelease"], live); self.assertRegex(record["oldTree"], r"^[0-9a-f]{64}$")

    def test_autofix_of_an_autofix_release_is_accepted(self):
        self.prepare(); self.activate(); one = self.autofix(); two = self.autofix(base=one, name="20261120-secfix-2", version="4.0.2")
        self.prepare("4.0.2"); self.activate("second", two)
        self.assertEqual(self.paths.current.resolve().name, "second")

    def test_ordinary_update_records_no_tree_and_compares_no_dependencies(self):
        self.prepare("4.0.1"); self.activate()
        for number, version in enumerate(("4.0.0", "3.0.0-beta.1", "odd")):
            with self.subTest(version):
                self.prepare(version); result = self.activate("update" + str(number), "first" if number == 0 else "update" + str(number - 1))
                self.assertIsNone(json.loads(self.transaction(result).read_text())["oldTree"])

    def test_failed_update_returns_to_the_autofix_release_without_its_base(self):
        self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1")
        before = self.paths.active.read_bytes(); self.host.fail_reload = 1
        def alter(): # the base is damaged mid-cutover: the return must not depend on it
            path = self.paths.releases / "first/dist/transports/http.js"; self.unlocked(path, lambda: path.write_text("// altered\n"))
        original = self.host.health
        def health(port, manifest):
            if manifest["release"] == "second": alter()
            return original(port, manifest)
        self.host.health = health
        with self.assertRaisesRegex(deploy.DeploymentError, "restored and verified"): self.activate("second", live)
        self.assertEqual(self.paths.current.resolve().name, live)
        self.assertEqual(self.paths.active.read_bytes(), before); self.assertTrue(self.host.running())
        self.assertIn("4.0.1", (self.paths.current / "node_modules/zod/index.js").read_text())

    def test_manual_rollback_returns_to_the_autofix_release_only_while_unchanged(self):
        for relative in ("node_modules/zod/index.js", "package.json", "dist/transports/http.js", "release-manifest.json"):
            with self.subTest(relative):
                self.tearDown(); self.setUp()
                self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1"); upgraded = self.activate("second", live)
                path = self.paths.releases / live / relative; original = path.read_bytes()
                self.unlocked(path, lambda: path.write_bytes(original + b" "))
                if relative != "release-manifest.json":
                    with self.assertRaisesRegex(deploy.DeploymentError, "changed after it was recorded"):
                        deploy.rollback(self.paths, self.host, upgraded["transaction"], "website-base", "second")
                    self.assertEqual(self.paths.current.resolve().name, "second")
                self.unlocked(path, lambda: path.write_bytes(original))
                shutil.rmtree(self.unfreeze(self.paths.releases / "first"))
                self.assertEqual(deploy.rollback(self.paths, self.host, upgraded["transaction"], "website-base", "second")["restoredRelease"], live)
                self.assertEqual(self.paths.current.resolve().name, live)

    def unfreeze(self, path):
        for item in [path, *path.rglob("*")]:
            if item.is_dir(): item.chmod(0o755)
        return path

    def test_transactions_of_the_older_tool_still_roll_back(self):
        self.activate(); upgraded = self.activate("second", "first"); path = self.transaction(upgraded)
        record = json.loads(path.read_text()); del record["oldTree"]; path.write_text(json.dumps(record))
        self.assertEqual(deploy.rollback(self.paths, self.host, upgraded["transaction"], "website-base", "second")["restoredRelease"], "first")

    def test_rollback_to_an_autofix_release_needs_its_recorded_tree(self):
        self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1"); upgraded = self.activate("second", live)
        path = self.transaction(upgraded); record = json.loads(path.read_text())
        for value in (None, "0" * 64):
            with self.subTest(value):
                record["oldTree"] = value; path.write_text(json.dumps(record))
                with self.assertRaises(deploy.DeploymentError): deploy.rollback(self.paths, self.host, upgraded["transaction"], "website-base", "second")
                self.assertEqual(self.paths.current.resolve().name, "second")

    def test_autofix_release_that_changed_more_than_dependencies_is_refused(self):
        def metadata(key, value):
            def change(target):
                data = json.loads((target / "package.json").read_text()); data[key] = value
                (target / "package.json").write_text(json.dumps(data))
            return change
        def write(relative, text="// new\n"):
            def change(target): (target / relative).parent.mkdir(parents=True, exist_ok=True); (target / relative).write_text(text)
            return change
        cases = {
            "code": write("dist/transports/http.js"), "content": write("content/catalog.json", "{}"), "added": write("dist/extra.js"),
            "removed": lambda t: (t / "deploy/check-host-isolation.mjs").unlink(),
            "lookalike": write("node_modules_extra.js"), "nested modules": write("dist/node_modules/x/index.js"),
            "nested package": write("dist/package.json", "{}"), "nested lock": write("dist/package-lock.json", "{}"),
            "manifest": write("release-manifest.json", "{}"), "link": lambda t: (t / "node_modules/link").symlink_to("/etc/hosts"),
            **{key: metadata(key, "x") for key in ("name", "version", "type", "main", "exports", "imports", "scripts", "bin", "files")},
        }
        reasons = {**{key: "package metadata" for key in ("name", "version", "type", "main", "exports", "imports", "scripts", "bin", "files")}, "link": "ownership or immutable"}
        self.prepare(); self.activate(); self.prepare("4.0.1"); base = self.paths.active.read_bytes()
        for number, (name, change) in enumerate(cases.items()):
            with self.subTest(name):
                live = self.autofix(name="20261113-secfix-case" + str(number), change=change)
                with self.assertRaisesRegex(deploy.DeploymentError, reasons.get(name, "more than its dependencies")): self.activate("update" + str(number), live)
                self.assertEqual(self.paths.current.resolve().name, live); self.assertEqual(self.paths.active.read_bytes(), base)

    def test_current_that_is_not_an_autofix_release_is_refused(self):
        self.prepare(); self.activate(); self.prepare("4.0.1")
        for name in ("20261113-other-1", "secfix-1", "20261113-secfixed", "third"):
            with self.subTest(name):
                live = self.autofix(name=name)
                with self.assertRaisesRegex(deploy.DeploymentError, "neither the recorded release"): self.activate("update-" + name, live)

    def test_autofix_permissions(self):
        self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1"); root = self.paths.releases / live
        cases = {"file": (root / "node_modules/zod/index.js", 0o644), "directory": (root / "dist", 0o755), "root": (root, 0o755), "own executable": (root / "dist/transports/http.js", 0o555)}
        for number, (name, (path, mode)) in enumerate(cases.items()):
            with self.subTest(name):
                before = stat.S_IMODE(path.stat().st_mode); path.chmod(mode)
                with self.assertRaisesRegex(deploy.DeploymentError, "immutable permissions"): self.activate("bad" + str(number), live)
                path.chmod(before)
        (root / "node_modules/zod/index.js").chmod(0o555)  # a dependency's own command stays executable
        self.activate("second", live); self.assertEqual(self.paths.current.resolve().name, "second")

    def test_running_releases_are_verified_before_and_after_validation(self):
        def damage(relative):
            path = self.paths.releases / relative; self.unlocked(path, lambda: path.write_text("// altered\n"))
        self.prepare(); self.activate(); damage("first/dist/transports/http.js")
        with self.assertRaisesRegex(deploy.DeploymentError, "reviewed hash"): self.activate("second", "first")
        self.tearDown(); self.setUp(); self.prepare(); self.activate()
        self.host.after_candidate = lambda: damage("first/dist/transports/http.js")
        with self.assertRaisesRegex(deploy.DeploymentError, "reviewed hash"): self.activate("second", "first")
        self.assertEqual(self.paths.current.resolve().name, "first")
        self.tearDown(); self.setUp(); self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1"); damage("first/dist/transports/http.js")
        with self.assertRaisesRegex(deploy.DeploymentError, "reviewed hash"): self.activate("second", live)
        self.tearDown(); self.setUp(); self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1")
        self.host.after_candidate = lambda: damage(live + "/node_modules/zod/index.js")
        with self.assertRaisesRegex(deploy.DeploymentError, "changed after it was recorded"): self.activate("second", live)
        self.assertEqual(self.paths.current.resolve().name, live)

    def test_managed_files_changed_outside_the_workflow_are_refused(self):
        for name in ("unit", "env", "caddy"):
            with self.subTest(name):
                self.tearDown(); self.setUp(); self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1")
                path = getattr(self.paths, name); data = path.read_bytes()
                path.write_bytes(data.replace(b"mcp.ipvolt.com {", b"mcp.ipvolt.com  {", 1) if name == "caddy" else data + b"# operator\n")
                self.assertNotEqual(path.read_bytes(), data)
                with self.assertRaisesRegex(deploy.DeploymentError, "outside this release workflow"): self.activate("second", live)

    def test_update_may_not_bring_back_older_installed_dependencies(self):
        self.prepare(); self.activate(); live = self.autofix(version="4.0.10")
        refused = {"older": dict(version="4.0.9"), "much older": dict(version="3.9.9"), "prerelease": dict(version="4.0.10-beta.1"), "unrecognized": dict(version="latest"),
                   "nested copy": dict(version="4.0.10", a="1.0.0", a__node_modules__zod="4.0.1"), "scoped nested copy": {"version": "4.0.10", "@s__a": "1.0.0", "@s__a__node_modules__zod": "4.0.1"}}
        for number, (name, versions) in enumerate(refused.items()):
            with self.subTest(name):
                self.prepare(**versions)
                with self.assertRaisesRegex(deploy.DeploymentError, "unrecognized version of zod"): self.activate("bad" + str(number), live)
        self.prepare("4.0.10"); (self.source / "node_modules/alias").mkdir()
        (self.source / "node_modules/alias/package.json").write_text(json.dumps({"name": "zod", "version": "4.0.1"}))
        with self.assertRaisesRegex(deploy.DeploymentError, "unrecognized version of zod"): self.activate("alias", live)
        for number, version in enumerate(("4.0.10+build.1", "4.0.11", "5.0.0-rc.1", "4.0.10")):
            with self.subTest(version):
                self.prepare(version); self.assertIsNotNone(deploy.prepare_candidate(self.paths, self.host, "ok" + str(number), self.stage("ok" + str(number), live)["sha256"], "website-base", live, "/usr/local/bin/node"))
        self.prepare("4.0.10"); shutil.rmtree(self.source / "node_modules/zod"); self.package(self.source, "other", "1.0.0")  # a removed package is no older copy
        self.activate("removed", live); self.assertEqual(self.paths.current.resolve().name, "removed")

    def test_scoped_dependencies_are_compared_too(self):
        self.prepare(**{"@s__a": "1.0.0"}); self.activate()
        live = self.autofix(change=lambda target: self.package(target, "@s/a", "2.0.0")); self.prepare("4.0.1", **{"@s__a": "1.9.9"})
        with self.assertRaisesRegex(deploy.DeploymentError, "unrecognized version of @s/a"): self.activate("second", live)

    def test_unreadable_installed_packages_are_refused(self):
        self.prepare(); self.activate(); live = self.autofix(change=lambda t: shutil.rmtree(t / "node_modules/zod")); self.prepare("4.0.1")
        with self.assertRaisesRegex(deploy.DeploymentError, "could not be read"): self.activate("second", live)
        self.tearDown(); self.setUp(); self.prepare(); self.activate(); live = self.autofix(); self.prepare("4.0.1")
        (self.source / "node_modules/zod/package.json").write_text(json.dumps({"name": "zod"}))
        with self.assertRaisesRegex(deploy.DeploymentError, "no name or version"): self.activate("second", live)

    def test_guard_is_mandatory_and_reexec_has_no_bypass(self):
        with patch.object(deploy, "GUARD", str(self.root / "missing-guard")):
            with self.assertRaises(deploy.DeploymentError): deploy.ensure_guard()
        guard = self.root / "guard"; guard.write_text("fixture")
        with patch.object(deploy, "GUARD", str(guard)), patch.object(deploy.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)), patch.object(deploy.os, "execv", side_effect=RuntimeError("reexec")) as execute:
            with self.assertRaisesRegex(RuntimeError, "reexec"): deploy.ensure_guard()
            arguments = execute.call_args.args[1]
            self.assertEqual(arguments[:2], [str(guard), "--"])
            self.assertIn(str(Path(deploy.__file__).resolve()), arguments)

    def test_unit_and_proxy_express_the_required_boundary(self):
        unit = Path(__file__).with_name("ipvolt-mcp.service").read_text()
        for setting in ("User=ipvolt-mcp", "Group=ipvolt-mcp", "ProtectSystem=strict", "ProtectHome=yes", "IPAddressDeny=any", "IPAddressAllow=localhost", "SystemCallFilter=~connect @mount", "SocketBindAllow=ipv4:tcp:3040", "LimitCORE=0"):
            self.assertIn(setting, unit)
        caddy = Path(__file__).with_name("ipvolt-mcp.caddy").read_text()
        self.assertIn("header_up X-IPVolt-Peer {http.request.remote.host}", caddy)
        self.assertIn("@public_mcp path /mcp /egress", caddy)
        self.assertNotIn("/healthz", caddy)
        self.assertIn("log_skip", caddy)
        # Site level (four spaces), not inside a handle block, and only once.
        hsts = [line for line in caddy.splitlines() if "Strict-Transport-Security" in line]
        self.assertEqual(hsts, ['    header Strict-Transport-Security "max-age=86400"'])
        # The crawl policy: one group that admits every crawler, with Content Signals, and nothing disallowed.
        robots = caddy.split("handle /robots.txt {", 1)[1].split("ROBOTS 200", 1)[0]
        rules = [line.strip() for line in robots.splitlines()[2:] if line.strip() and not line.strip().startswith("#")]
        self.assertEqual(rules, ["User-agent: *", "Content-Signal: search=yes, ai-input=yes, ai-train=yes", "Allow: /"])

    def test_bounded_json_and_sse_discovery(self):
        response = {"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}
        raw = json.dumps(response).encode()
        self.assertEqual(deploy.decode_rpc(raw, "application/json; charset=utf-8"), response)
        self.assertEqual(deploy.decode_rpc(b": keepalive\r\n\r\nevent: message\r\ndata: " + raw + b"\r\n\r\n", "text/event-stream"), response)
        for invalid, media_type in ((b"a" * 100001, "application/json"), (raw, "text/plain"), (b"data: {}\n\n", "text/event-stream"), (b"data: " + raw + b"\n\ndata: " + raw + b"\n\n", "text/event-stream")):
            with self.assertRaises(deploy.DeploymentError): deploy.decode_rpc(invalid, media_type)

    @unittest.skipUnless(os.environ.get("IPVOLT_DEPLOY_NODE"), "Set IPVOLT_DEPLOY_NODE to run the real Node 24 HTTP-service health check.")
    def test_health_against_actual_node_http_service(self):
        repository = Path(__file__).resolve().parents[1]
        script = """import {createHttpService} from './src/transports/http.ts';
const service=createHttpService({trustProxy:true});
service.server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:service.server.address().port})));
process.once('SIGTERM',()=>void service.close().then(()=>process.exit(0)));
"""
        child = subprocess.Popen([os.environ["IPVOLT_DEPLOY_NODE"], "--import", "tsx", "--input-type=module", "--eval", script], cwd=repository, env={"PATH": os.environ.get("PATH", "")}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], "Real HTTP service did not announce readiness.")
            ready = json.loads(child.stdout.readline())
            package = json.loads((repository / "package.json").read_text())
            catalog = json.loads((repository / "content/catalog.json").read_text())
            deploy.Host().health(ready["port"], {"version": package["version"], "sourceRelease": catalog["sourceRelease"]})
        finally:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
            child.stdout.close(); child.stderr.close()


if __name__ == "__main__": unittest.main()
