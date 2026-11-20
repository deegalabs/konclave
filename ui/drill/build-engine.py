"""Build one export-drill engine from the selected checkout's pinned public inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib


def digest(path):
    with path.open("rb") as data:
        return hashlib.file_digest(data, "sha256").hexdigest()


def output(args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", choices=["zcash-sign", "zcash-devtool"])
    parser.add_argument("directory", type=Path, help="new build directory outside the checkout")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    dest = args.directory.resolve()
    if dest.is_relative_to(repo):
        parser.error("choose a build directory outside the checkout")
    os.umask(0o077)
    dest.mkdir(mode=0o700)
    versions = repo / "engine/versions.lock"
    with versions.open("rb") as f:
        sources = tomllib.load(f)["source"]
    devtool = args.engine == "zcash-devtool"
    pin = sources["zcash-devtool-stable" if devtool else "frost-tools"]
    source = dest / "source"
    subprocess.run(["git", "clone", "--quiet", "--no-checkout", pin["repo"], str(source)], check=True)
    rev = output(["git", "rev-parse", "--verify", pin["rev"] + "^{commit}"], source)
    if not rev.startswith(pin["rev"]):
        raise SystemExit("resolved source does not match the pinned commit")
    subprocess.run(["git", "checkout", "--quiet", "--detach", rev], cwd=source, check=True)
    lock = source / "Cargo.lock"
    original = hashlib.sha256(subprocess.check_output(["git", "show", "HEAD:Cargo.lock"], cwd=source)).hexdigest()
    if digest(lock) != original:
        raise SystemExit("checked-out Cargo.lock differs from the committed blob")
    record = {"engine": args.engine, "konclave_commit": output(["git", "rev-parse", "HEAD"], repo),
              "versions_lock_sha256": digest(versions), "source": pin["repo"], "commit": rev,
              "upstream_lock_sha256": original}
    if devtool:
        patch, replacement = (repo / pin[k] for k in ("patch", "lockfile"))
        if digest(patch) != pin["patch_sha256"] or digest(replacement) != pin["lockfile_sha256"]:
            raise SystemExit("devtool patch or replacement Cargo.lock checksum mismatch")
        subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(patch)], cwd=source, check=True)
        shutil.copyfile(replacement, lock)
        record["patch_sha256"] = pin["patch_sha256"]
    expected = pin["lockfile_sha256"] if devtool else original
    if digest(lock) != expected:
        raise SystemExit("effective Cargo.lock checksum mismatch")

    # The stable devtool build record specifies 1.99.0. Use the same explicit release
    # for frost-tools, whose committed rust-toolchain.toml specifies stable.
    toolchain = "+1.99.0"
    rustc = output(["rustc", toolchain, "-vV"], source)
    record.update(lock_sha256=expected, rustc=rustc, cargo=output(["cargo", toolchain, "-V"], source),
                  target=next(line[6:] for line in rustc.splitlines() if line.startswith("host: ")))
    command = ["cargo", toolchain, "build", "--release", "--locked", "--bin", args.engine]
    target = dest / "target"
    subprocess.run(command, cwd=source, env={**os.environ, "CARGO_TARGET_DIR": str(target)}, check=True)
    if digest(lock) != expected:
        raise SystemExit("Cargo.lock changed during the build")
    binary = Path("target/release") / args.engine
    record.update(command=command, binary=str(binary), binary_sha256=digest(dest / binary))
    (dest / "provenance.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    (dest / "SHA256SUMS").write_text(f"{record['binary_sha256']}  {binary}\n", encoding="utf-8")
    print(f"{args.engine} built from {rev}, SHA-256 {record['binary_sha256']}")


if __name__ == "__main__":
    main()
