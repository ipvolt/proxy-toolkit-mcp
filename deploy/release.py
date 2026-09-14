#!/usr/bin/env python3
"""Guarded deployment of a prebuilt, independently reviewed MCP artifact.

Production paths are fixed. Tests inject an isolated Paths root and fake Host;
the CLI has no unguarded or simulation mode and never invokes npm as root.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import grp
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

GUARD = "/usr/local/sbin/ipvolt-deploy-guard"
SERVICE = "ipvolt-mcp.service"
DOMAIN = "mcp.ipvolt.com"
BEGIN = b"\n# BEGIN IPVOLT MCP MANAGED\n"
END = b"# END IPVOLT MCP MANAGED\n"
ALLOWLIST = ("dist", "content", "node_modules", "package.json", "package-lock.json", "LICENSE", "CONTENT-LICENSE.md", "README.md", "server.json", "deploy")
TOOLS = {"search_proxy_docs", "get_proxy_doc", "generate_proxy_config", "diagnose_proxy_error"}


class DeploymentError(Exception):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,79}", value):
        raise DeploymentError("Release identifiers must be 1–80 letters, digits or hyphens.")
    return value


@dataclass(frozen=True)
class Paths:
    root: Path = Path("/")

    def at(self, relative: str) -> Path:
        return self.root / relative

    @property
    def releases(self): return self.at("opt/ipvolt-mcp/releases")
    @property
    def current(self): return self.at("opt/ipvolt-mcp/current")
    @property
    def website(self): return self.at("opt/ipvolt-website/current")
    @property
    def caddy(self): return self.at("etc/caddy/Caddyfile")
    @property
    def unit(self): return self.at("etc/systemd/system/ipvolt-mcp.service")
    @property
    def env(self): return self.at("etc/ipvolt-mcp.env")
    @property
    def state(self): return self.at("var/lib/ipvolt-mcp-deploy")
    @property
    def active(self): return self.state / "active.json"


def require_directory(path: Path, mode=0o755):
    missing = []
    cursor = path
    while not cursor.exists():
        if cursor.is_symlink(): raise DeploymentError("Unexpected dangling directory symlink.")
        missing.append(cursor)
        cursor = cursor.parent
    if cursor.is_symlink() or not cursor.is_dir(): raise DeploymentError("Unexpected directory owner/type.")
    for item in reversed(missing): item.mkdir(mode=mode)
    if path.is_symlink() or not path.is_dir() or path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022:
        raise DeploymentError("Deployment directories must be owned by the operator and not group/world writable.")


def regular(path: Path) -> bytes | None:
    if any(parent.is_symlink() for parent in path.parents): raise DeploymentError("Unexpected symlink in a managed file's parent path.")
    if not path.exists() and not path.is_symlink(): return None
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise DeploymentError("Unexpected managed file owner, type or permissions; preserve and reconcile it.")
    return path.read_bytes()


def atomic_file(path: Path, data: bytes | None, mode=0o644, owner=None):
    if path.is_symlink(): raise DeploymentError("Refusing to replace a managed file symlink.")
    if data is None:
        path.unlink(missing_ok=True)
        return
    if owner is None and path.exists(): owner = (path.stat().st_uid, path.stat().st_gid)
    descriptor, temporary = tempfile.mkstemp(prefix=".ipvolt-mcp-", dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data); output.flush(); os.fsync(output.fileno())
        temporary.chmod(mode)
        if owner is not None and owner != (temporary.stat().st_uid, temporary.stat().st_gid): os.chown(temporary, *owner)
        os.replace(temporary, path)
    finally: temporary.unlink(missing_ok=True)


def current_release(path: Path, release_root: Path, allow_none=False) -> str | None:
    if not path.exists() and not path.is_symlink():
        if allow_none: return None
        raise DeploymentError("Expected current release is absent.")
    if not path.is_symlink(): raise DeploymentError("Current release must be a symlink, not a user file.")
    target = path.resolve(strict=True)
    if target.parent != release_root.resolve() or not target.is_dir():
        raise DeploymentError("Current release points outside the approved release directory.")
    return identifier(target.name)


def expected(paths: Paths, website: str, mcp: str):
    if current_release(paths.website, paths.at("opt/ipvolt-website/releases")) != identifier(website):
        raise DeploymentError("Website current changed. Reconcile the reviewed release before retrying.")
    actual = current_release(paths.current, paths.releases, True)
    if actual != (None if mcp == "none" else identifier(mcp)):
        raise DeploymentError("MCP current changed. Reconcile the reviewed release before retrying.")


def split_block(data: bytes):
    if data.count(BEGIN) != data.count(END) or data.count(BEGIN) > 1:
        raise DeploymentError("Ambiguous managed Caddy block; preserve and reconcile it.")
    if not data.count(BEGIN):
        if b"BEGIN IPVOLT MCP MANAGED" in data or b"END IPVOLT MCP MANAGED" in data:
            raise DeploymentError("Malformed managed Caddy block.")
        return data, b"", b""
    start = data.index(BEGIN); end = data.index(END, start) + len(END)
    return data[:start], data[start:end], data[end:]


def replace_block(data: bytes, block: bytes):
    before, _old, after = split_block(data)
    return before + block + after


def snapshot(path: Path):
    data = regular(path)
    return None if data is None else {"data": base64.b64encode(data).decode(), "mode": stat.S_IMODE(path.stat().st_mode), "uid": path.stat().st_uid, "gid": path.stat().st_gid}


def restore_file(path: Path, value):
    atomic_file(path, None if value is None else base64.b64decode(value["data"]), 0o644 if value is None else value["mode"], None if value is None else (value["uid"], value["gid"]))


def artifact_files(path: Path):
    result = {}
    for item in sorted(path.rglob("*")):
        if item.is_symlink(): raise DeploymentError("Artifacts may not contain symlinks or linked external files.")
        if item.is_file():
            relative = item.relative_to(path).as_posix()
            if relative == "release-manifest.json": continue
            if item.name in (".env", ".npmrc") or item.name.startswith(".env.") or item.suffix == ".pyc" or ".git" in item.parts or "__pycache__" in item.parts:
                raise DeploymentError("Unexpected private/development file in runtime artifact.")
            result[relative] = digest(item.read_bytes())
        elif not item.is_dir(): raise DeploymentError("Artifacts may contain only regular files/directories.")
    return result


def artifact_digest(files):
    return digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode())


def stage(paths: Paths, source: Path, release: str, website: str, mcp: str):
    identifier(release); expected(paths, website, mcp)
    source = source.resolve(strict=True)
    for required in ("dist/transports/http.js", "content/catalog.json", "node_modules", "package.json", "deploy/ipvolt-mcp.service", "deploy/ipvolt-mcp.env", "deploy/ipvolt-mcp.caddy", "deploy/check-host-isolation.mjs"):
        if not (source / required).exists(): raise DeploymentError("The source is not a complete prebuilt runtime artifact.")
    require_directory(paths.releases)
    target = paths.releases / release
    if target.exists() or target.is_symlink(): raise DeploymentError("Release already exists; immutable releases are never overwritten.")
    temporary = Path(tempfile.mkdtemp(prefix=".staging-", dir=paths.releases))
    try:
        # Check before copy so a source symlink can never pull private external data.
        for name in ALLOWLIST:
            item = source / name
            if item.exists() or item.is_symlink():
                if item.is_symlink(): raise DeploymentError("Artifact roots cannot be symlinks.")
                if item.is_dir(): artifact_files(item); shutil.copytree(item, temporary / name)
                else: shutil.copy2(item, temporary / name)
        files = artifact_files(temporary)
        package = json.loads((temporary / "package.json").read_text())
        catalog = json.loads((temporary / "content/catalog.json").read_text())
        if package.get("name") != "@ipvolt/proxy-toolkit-mcp" or not re.fullmatch(r"\d+\.\d+\.\d+", package.get("version", "")):
            raise DeploymentError("Unexpected package identity/version.")
        manifest = {"release": release, "version": package["version"], "sourceRelease": identifier(catalog["sourceRelease"]), "files": files, "sha256": artifact_digest(files)}
        (temporary / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        for item in temporary.rglob("*"): item.chmod(0o555 if item.is_dir() else 0o444)
        expected(paths, website, mcp)
        os.rename(temporary, target)
        target.chmod(0o555)
        return manifest
    finally:
        if temporary.exists():
            temporary.chmod(0o755)
            for item in temporary.rglob("*"):
                if item.is_dir(): item.chmod(0o755)
            shutil.rmtree(temporary)


def verify_artifact(paths: Paths, release: str, required_hash: str):
    target = paths.releases / identifier(release)
    if target.is_symlink() or not target.is_dir(): raise DeploymentError("Staged release is absent or not an immutable directory.")
    for item in [target, *target.rglob("*")]:
        if item.is_symlink() or item.stat().st_uid != os.geteuid() or stat.S_IMODE(item.stat().st_mode) != (0o555 if item.is_dir() else 0o444):
            raise DeploymentError("Staged artifact ownership or immutable permissions changed.")
    manifest = json.loads((target / "release-manifest.json").read_text())
    files = artifact_files(target)
    if manifest.get("release") != release or manifest.get("files") != files or manifest.get("sha256") != artifact_digest(files) or manifest["sha256"] != required_hash:
        raise DeploymentError("Staged artifact differs from the reviewed hash.")
    return target, manifest


class Host:
    def run(self, args, check=True):
        result = subprocess.run(args, capture_output=True, text=True, env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
        if check and result.returncode: raise DeploymentError("A deployment validation/service command failed; no request/configuration data was logged.")
        return result

    def validate_caddy(self, candidate: Path):
        self.run(["caddy", "validate", "--config", str(candidate), "--adapter", "caddyfile"])
        return json.loads(self.run(["caddy", "adapt", "--config", str(candidate), "--adapter", "caddyfile"]).stdout)

    def account(self):
        try: account = pwd.getpwnam("ipvolt-mcp")
        except KeyError:
            self.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "ipvolt-mcp"])
            account = pwd.getpwnam("ipvolt-mcp")
        if not 0 < account.pw_uid < 1000 or account.pw_dir != "/nonexistent" or account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin") or grp.getgrgid(account.pw_gid).gr_name != "ipvolt-mcp" or os.getgrouplist("ipvolt-mcp", account.pw_gid) != [account.pw_gid]:
            raise DeploymentError("Existing service account has unexpected privileges/settings; preserve and reconcile it.")

    def enabled(self): return self.run(["systemctl", "is-enabled", SERVICE], False).returncode == 0
    def running(self): return self.run(["systemctl", "is-active", SERVICE], False).returncode == 0

    def unit_boundary(self, name, path):
        info = self.run(["systemctl", "show", name, "--property=FragmentPath", "--property=DropInPaths"], False).stdout
        fields = dict(line.split("=", 1) for line in info.splitlines() if "=" in line)
        if fields.get("DropInPaths") or fields.get("FragmentPath") not in (None, "", str(path)):
            raise DeploymentError("Unexpected systemd unit/drop-in overrides require review before MCP deployment.")

    def dns(self, address):
        if not address or {item[4][0] for item in socket.getaddrinfo(DOMAIN, 443, type=socket.SOCK_STREAM)} != {address}:
            raise DeploymentError("Public MCP DNS does not match the explicitly reviewed address.")

    def health(self, port, manifest):
        for _ in range(30):
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                connection.request("GET", "/healthz"); response = connection.getresponse()
                data = json.loads(response.read(4096)); connection.close()
                if response.status == 200 and data.get("ok") is True and data.get("name") == "ipvolt-proxy-toolkit" and data.get("version") == manifest["version"] and data.get("sourceRelease") == manifest["sourceRelease"]:
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                    connection.request("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", "X-IPVolt-Peer": "127.0.0.1"})
                    response = connection.getresponse(); data = decode_rpc(response.read(100001), response.getheader("Content-Type", "")); connection.close()
                    if response.status == 200 and {tool["name"] for tool in data.get("result", {}).get("tools", [])} == TOOLS: return
            except (OSError, ValueError, KeyError, DeploymentError): pass
            time.sleep(0.2)
        raise DeploymentError("MCP health/version/tool-catalog validation failed.")

    def candidate(self, paths, target, unit, manifest):
        listener = socket.socket(); listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]; listener.close()
        name = f"ipvolt-mcp-candidate-{manifest['release']}.service"
        candidate_unit = paths.at("run/systemd/system") / name
        if candidate_unit.exists() or candidate_unit.is_symlink(): raise DeploymentError("Unexpected candidate unit already exists.")
        content = unit.replace(str(paths.current), str(target)).replace("/etc/ipvolt-mcp.env", "-unused")
        content = content.replace("EnvironmentFile=-unused", "Environment=NODE_ENV=production\nEnvironment=IPVOLT_MCP_TRUST_PROXY=1\nEnvironment=IPVOLT_MCP_PUBLIC_URL=https://mcp.ipvolt.com/mcp\nEnvironment=IPVOLT_MCP_ALLOWED_ORIGINS=https://mcp.ipvolt.com,https://ipvolt.com\nEnvironment=IPVOLT_MCP_PORT=" + str(port)).replace("ipv4:tcp:3040", f"ipv4:tcp:{port}")
        try:
            atomic_file(candidate_unit, content.encode())
            self.run(["systemd-analyze", "verify", str(candidate_unit)])
            self.run(["systemctl", "daemon-reload"]); self.unit_boundary(name, candidate_unit); self.run(["systemctl", "start", name])
            self.health(port, manifest)
        finally:
            self.run(["systemctl", "stop", name], False)
            candidate_unit.unlink(missing_ok=True)
            self.run(["systemctl", "daemon-reload"])

    def public_health(self):
        for _ in range(30):
            result = self.run(["curl", "--disable", "--silent", "--fail", "--max-time", "2", "--resolve", f"{DOMAIN}:443:127.0.0.1", "--header", "X-IPVolt-Peer: 203.0.113.99", "--header", "X-Forwarded-For: 203.0.113.99", f"https://{DOMAIN}/egress?nonce=" + "0" * 32], False)
            try:
                if result.returncode == 0 and json.loads(result.stdout) == {"ip": "127.0.0.1", "nonce": "0" * 32}:
                    hidden = self.run(["curl", "--disable", "--silent", "--max-time", "2", "--resolve", f"{DOMAIN}:443:127.0.0.1", "--output", "/dev/null", "--write-out", "%{http_code}", f"https://{DOMAIN}/healthz"], False)
                    if hidden.returncode == 0 and hidden.stdout == "404": return
            except ValueError: pass
            time.sleep(0.5)
        raise DeploymentError("TLS/Caddy peer-overwrite or private-health boundary validation failed.")


def caddy_candidate(paths, content: bytes, host: Host):
    descriptor, name = tempfile.mkstemp(prefix=".Caddyfile.mcp-", dir=paths.caddy.parent)
    candidate = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as output: output.write(content)
        host.validate_caddy(candidate)
    finally: candidate.unlink(missing_ok=True)


def decode_rpc(raw: bytes, content_type: str):
    if len(raw) > 100000: raise DeploymentError("MCP discovery response exceeds its bound.")
    text = raw.decode("utf-8", errors="strict")
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type == "application/json": return json.loads(text)
    if media_type != "text/event-stream": raise DeploymentError("Unexpected MCP discovery media type.")
    messages = []
    for event in text.replace("\r\n", "\n").split("\n\n"):
        lines = [line[5:].lstrip(" ") for line in event.split("\n") if line.startswith("data:")]
        if lines:
            value = json.loads("\n".join(lines))
            if isinstance(value, dict) and value.get("id") == 1: messages.append(value)
    if len(messages) != 1: raise DeploymentError("MCP discovery must return exactly one matching response.")
    return messages[0]


def prepare_candidate(paths: Paths, host: Host, release: str, artifact: str, website: str, mcp: str, node: str, address: str | None = None):
    expected(paths, website, mcp)
    host.unit_boundary(SERVICE, paths.unit)
    target, manifest = verify_artifact(paths, release, artifact)
    caddy = regular(paths.caddy)
    if caddy is None: raise DeploymentError("An existing complete Caddyfile is required; do not initialize shared Caddy from the MCP fragment.")
    active = regular(paths.active)
    old = json.loads(active) if active else None
    initial_unit, initial_env = regular(paths.unit), regular(paths.env)
    before, old_block, after = split_block(caddy)
    if mcp == "none":
        if old or old_block or regular(paths.unit) is not None or regular(paths.env) is not None or host.running() or host.enabled():
            raise DeploymentError("Unexpected existing MCP state; initial installation will not overwrite it.")
    elif not old or old.get("release") != mcp or digest(old_block) != old["caddyBlockSha256"] or digest(regular(paths.unit) or b"") != old["unitSha256"] or digest(regular(paths.env) or b"") != old["envSha256"]:
        raise DeploymentError("Managed MCP files changed outside this release workflow; preserve and reconcile them.")
    if old: verify_artifact(paths, mcp, old["artifact"])
    base_config = host.validate_caddy(paths.caddy)
    if not old_block and (DOMAIN in json.dumps(base_config) or "*.ipvolt.com" in json.dumps(base_config)):
        raise DeploymentError("Existing Caddy already handles the MCP hostname; manual reconciliation is required.")
    block = b"\n" + (target / "deploy/ipvolt-mcp.caddy").read_bytes()
    split_block(block)
    new_caddy = before + block + after
    unit = (target / "deploy/ipvolt-mcp.service").read_text().replace("/usr/local/bin/node", node)
    env = (target / "deploy/ipvolt-mcp.env").read_bytes()
    caddy_candidate(paths, new_caddy, host)
    if address is not None: host.dns(address)
    host.account(); host.candidate(paths, target, unit, manifest)
    expected(paths, website, mcp); verify_artifact(paths, release, artifact)
    if regular(paths.caddy) != caddy or regular(paths.active) != active or regular(paths.unit) != initial_unit or regular(paths.env) != initial_env:
        raise DeploymentError("Shared configuration changed during candidate validation.")
    return target, manifest, caddy, active, block, unit, env, new_caddy


def validate_candidate(paths: Paths, host: Host, release: str, artifact: str, website: str, mcp: str, node: str):
    prepare_candidate(paths, host, release, artifact, website, mcp, node)
    return {"release": release, "artifact": artifact, "candidateValidated": True, "activated": False}


def activate(paths: Paths, host: Host, release: str, artifact: str, website: str, mcp: str, node: str, address: str):
    target, manifest, caddy, active, block, unit, env, new_caddy = prepare_candidate(paths, host, release, artifact, website, mcp, node, address)
    require_directory(paths.state, 0o700); require_directory(paths.state / "transactions", 0o700)
    transaction_id = identifier("mcp-" + release[:50] + "-" + str(time.time_ns()))
    transaction = paths.state / "transactions" / (transaction_id + ".json")
    if transaction.exists(): raise DeploymentError("Transaction already exists; retry with a distinct release identifier.")
    record = {"id": transaction_id, "release": release, "oldRelease": None if mcp == "none" else mcp, "oldFiles": {"caddy": snapshot(paths.caddy), "unit": snapshot(paths.unit), "env": snapshot(paths.env), "active": snapshot(paths.active)}, "wasEnabled": host.enabled(), "wasRunning": host.running(), "newBlockSha256": digest(block), "newUnitSha256": digest(unit.encode()), "newEnvSha256": digest(env), "artifact": artifact}
    atomic_file(transaction, (json.dumps(record, indent=2) + "\n").encode(), 0o600)
    try:
        atomic_file(paths.unit, unit.encode()); atomic_file(paths.env, env, 0o600)
        atomic_link(paths.current, target)
        host.run(["systemctl", "daemon-reload"]); host.run(["systemctl", "enable", SERVICE]); host.run(["systemctl", "restart", SERVICE])
        host.health(3040, manifest)
        atomic_file(paths.caddy, new_caddy, stat.S_IMODE(paths.caddy.stat().st_mode))
        host.run(["systemctl", "reload", "caddy"]); host.public_health()
        state = {"release": release, "artifact": artifact, "transaction": transaction_id, "caddyBlockSha256": digest(block), "unitSha256": digest(unit.encode()), "envSha256": digest(env)}
        atomic_file(paths.active, (json.dumps(state, indent=2) + "\n").encode(), 0o600)
    except Exception as error:
        try: restore(paths, host, record, automatic=True)
        except Exception as rollback_error:
            raise DeploymentError("Cutover and rollback verification failed. Stop further releases and investigate the private transaction record before retrying.") from rollback_error
        raise DeploymentError("Cutover failed; prior Caddy/unit/environment/release and service state were restored and verified.") from error
    return {"release": release, "transaction": transaction_id, "artifact": artifact}


def atomic_link(path: Path, target: Path | None):
    if path.exists() and not path.is_symlink(): raise DeploymentError("Current is an unexpected user file.")
    temporary = path.with_name(".current-ipvolt-mcp-" + str(os.getpid()))
    if temporary.exists() or temporary.is_symlink(): raise DeploymentError("Unexpected temporary current link.")
    try:
        if target is None: path.unlink(missing_ok=True)
        else: temporary.symlink_to(target); os.replace(temporary, path)
    finally: temporary.unlink(missing_ok=True)


def restore(paths: Paths, host: Host, record, automatic=False):
    files = record["oldFiles"]
    for name, new_hash in (("unit", "newUnitSha256"), ("env", "newEnvSha256")):
        old_data = b"" if files[name] is None else base64.b64decode(files[name]["data"])
        if digest(regular(getattr(paths, name)) or b"") not in (record[new_hash], digest(old_data)):
            raise DeploymentError("Managed configuration changed during rollback; preserve the operator edit.")
    old_manifest = None
    if record["oldRelease"]:
        if not files["active"]: raise DeploymentError("Missing prior deployment state.")
        old_active = json.loads(base64.b64decode(files["active"]["data"]))
        _target, old_manifest = verify_artifact(paths, record["oldRelease"], old_active["artifact"])
    live = regular(paths.caddy)
    if live is None: raise DeploymentError("Shared Caddy disappeared during rollback.")
    _before, live_block, _after = split_block(live)
    old_caddy = base64.b64decode(files["caddy"]["data"])
    old_block = split_block(old_caddy)[1]
    if live_block and digest(live_block) not in (record["newBlockSha256"], digest(old_block)):
        raise DeploymentError("Managed Caddy block changed during rollback.")
    # Manual rollback preserves unrelated Caddy edits made after this transaction.
    restored_caddy = replace_block(live, old_block)
    caddy_candidate(paths, restored_caddy, host)
    host.run(["systemctl", "stop", SERVICE], False)
    if not record["wasEnabled"]: host.run(["systemctl", "disable", SERVICE], False)
    restore_file(paths.unit, files["unit"]); restore_file(paths.env, files["env"])
    atomic_link(paths.current, None if record["oldRelease"] is None else paths.releases / record["oldRelease"])
    restore_file(paths.active, files["active"])
    atomic_file(paths.caddy, restored_caddy, files["caddy"]["mode"], (files["caddy"]["uid"], files["caddy"]["gid"]))
    host.run(["systemctl", "daemon-reload"])
    if record["wasEnabled"]: host.run(["systemctl", "enable", SERVICE])
    if record["wasRunning"]:
        if not record["oldRelease"]: raise DeploymentError("Invalid prior service state in transaction.")
        host.run(["systemctl", "restart", SERVICE]); host.health(3040, old_manifest)
    elif host.running(): raise DeploymentError("MCP service failed to stop during rollback.")
    host.run(["systemctl", "reload", "caddy"])
    if record["oldRelease"] and record["wasRunning"]: host.public_health()


def rollback(paths: Paths, host: Host, transaction: str, website: str, mcp: str):
    expected(paths, website, mcp)
    record = json.loads(regular(paths.state / "transactions" / (identifier(transaction) + ".json")) or b"{}")
    active = json.loads(regular(paths.active) or b"{}")
    if record.get("release") != mcp or active.get("transaction") != transaction or digest(regular(paths.unit) or b"") != record.get("newUnitSha256") or digest(regular(paths.env) or b"") != record.get("newEnvSha256"):
        raise DeploymentError("Rollback no longer matches the active managed revision.")
    restore(paths, host, record)
    return {"restoredRelease": record["oldRelease"], "transaction": transaction}


def ensure_guard():
    try: inherited = int(os.environ.get("IPVOLT_DEPLOY_LOCK_FD", "-1"))
    except ValueError: inherited = -1
    if not Path(GUARD).is_file(): raise DeploymentError("Install the reviewed shared ipvolt-deploy-guard first.")
    check = subprocess.run([GUARD, "--check"], pass_fds=(inherited,) if inherited >= 3 else (), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if check.returncode: os.execv(GUARD, [GUARD, "--", sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("stage", "validate", "activate", "rollback"))
    parser.add_argument("--expected-website", required=True)
    parser.add_argument("--expected-mcp", required=True, help="Reviewed current release, or literal none for a first installation.")
    parser.add_argument("--release"); parser.add_argument("--source", type=Path); parser.add_argument("--artifact-sha256")
    parser.add_argument("--transaction"); parser.add_argument("--expected-dns-address")
    parser.add_argument("--node", default="/usr/local/bin/node")
    args = parser.parse_args()
    if os.geteuid() != 0: raise DeploymentError("The guarded host entrypoint must run as root.")
    ensure_guard(); paths = Paths(); host = Host()
    if args.action == "stage":
        if not args.source or not args.release: raise DeploymentError("stage requires source and a unique release.")
        result = stage(paths, args.source, args.release, args.expected_website, args.expected_mcp)
        print(json.dumps({"event": "staged", "release": result["release"], "artifactSha256": result["sha256"]}))
    elif args.action in ("validate", "activate"):
        if not args.release or not args.artifact_sha256 or not re.fullmatch(r"[a-f0-9]{64}", args.artifact_sha256): raise DeploymentError("validate/activate require release and the reviewed artifact hash.")
        if args.action == "activate" and not args.expected_dns_address: raise DeploymentError("activate also requires the expected DNS address.")
        node = Path(args.node)
        if not node.is_absolute() or not node.is_file() or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(node)) or node.stat().st_uid != 0 or node.stat().st_mode & 0o022: raise DeploymentError("Node must be an absolute, root-owned, non-writable executable path.")
        resolved_node = node.resolve(strict=True)
        if not str(resolved_node).startswith(("/usr/", "/opt/")) or any(parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022 for parent in resolved_node.parents):
            raise DeploymentError("Node's resolved parent directories must be root-owned and not group/world writable.")
        if not host.run([str(node), "--version"]).stdout.startswith("v24."): raise DeploymentError("Use the reviewed Node 24 runtime.")
        if args.action == "validate":
            result = validate_candidate(paths, host, args.release, args.artifact_sha256, args.expected_website, args.expected_mcp, str(node))
            print(json.dumps({"event": "validated", **result}))
        else:
            result = activate(paths, host, args.release, args.artifact_sha256, args.expected_website, args.expected_mcp, str(node), args.expected_dns_address)
            print(json.dumps({"event": "activated", **result}))
    else:
        if not args.transaction: raise DeploymentError("rollback requires the recorded transaction identifier.")
        print(json.dumps({"event": "rolled_back", **rollback(paths, host, args.transaction, args.expected_website, args.expected_mcp)}))


if __name__ == "__main__":
    try: main()
    except (DeploymentError, OSError, ValueError, KeyError) as error:
        print(str(error) if isinstance(error, DeploymentError) else "Deployment failed; inspect the reviewed artifact and private transaction state.", file=sys.stderr)
        sys.exit(1)
