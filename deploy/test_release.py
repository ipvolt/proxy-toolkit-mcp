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
