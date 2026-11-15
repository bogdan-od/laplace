#!/usr/bin/env python3
"""Downloads the sources listed by `make show-info`, checking sha256 against the Buildroot .hash files.

Usage: fetch.py <show-info.json> <Buildroot directory> <dl directory>
The only step that needs the network: curl. No downloaded file is unpacked or run here;
`make source` does that afterwards.
"""
import hashlib
import json
import pathlib
import subprocess
import sys

CHUNK = 1 << 20


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(CHUNK):
            digest.update(block)
    return digest.hexdigest()


def expected_hashes(br_dir):
    """File name -> set of allowed sha256 from all .hash files of the tree."""
    table = {}
    for hash_file in br_dir.rglob("*.hash"):
        for line in hash_file.read_text(errors="replace").splitlines():
            fields = line.split()
            if len(fields) == 3 and fields[0] == "sha256":
                table.setdefault(fields[2], set()).add(fields[1])
    return table


def candidate_urls(uris, source):
    for uri in uris:
        base = uri.split("+", 1)[1] if "+" in uri.split("://", 1)[0] else uri
        yield base.rstrip("/") + "/" + source


def download(url, target):
    tmp = target.with_suffix(target.suffix + ".part")
    result = subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", str(tmp), url])
    if result.returncode != 0:
        tmp.unlink(missing_ok=True)
        return False
    tmp.rename(target)
    return True


def main(json_path, br_dir, dl_dir):
    hashes = expected_hashes(pathlib.Path(br_dir))
    failed = []
    for package, info in json.load(open(json_path)).items():
        for item in info.get("downloads", []):
            source = item["source"]
            directory = pathlib.Path(dl_dir) / package.removeprefix("host-")
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / source
            allowed = hashes.get(source)
            if not allowed:
                failed.append(f"{source}: no hash in the Buildroot tree")
                continue
            for url in candidate_urls(item["uris"], source):
                if not target.exists() and not download(url, target):
                    print(f"failed: {url}", file=sys.stderr)
                    continue
                if sha256_of(target) in allowed:
                    print(f"ok  {url}")
                    break
                print(f"HASH MISMATCH: {url}", file=sys.stderr)
                target.unlink()
            else:
                failed.append(f"{source}: no mirror gave a file with the right hash")
    if failed:
        print("\n".join(failed), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
