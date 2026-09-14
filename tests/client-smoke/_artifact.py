"""Bind real-client evidence to the installed runtime and, optionally, its archive."""
import hashlib
from pathlib import Path
import tarfile


def artifact_evidence(root: Path, archive: Path | None):
    files = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for directory in ("dist", "content") for path in (root / directory).rglob("*") if path.is_file()}
    archive_hash = None
    if archive:
        archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        with tarfile.open(archive, "r:gz") as packed:
            packed_files = {member.name.removeprefix("package/"): hashlib.sha256(packed.extractfile(member).read()).hexdigest() for member in packed.getmembers() if member.isfile() and member.name.startswith(("package/dist/", "package/content/"))}
        assert files == packed_files, "Installed runtime/content differs from the supplied release archive"
    return {"archiveSha256": archive_hash, "artifactFiles": files}
