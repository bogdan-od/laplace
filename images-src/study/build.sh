#!/bin/bash
# Builds the "study" image (Alpine for teaching) for v86. Usage: build.sh <step>
#   image    podman build (network: Docker Hub for the base manifest, dl-cdn.alpinelinux.org for packages)
#   export   podman create + export to $BUILD_DIR/study-rootfs.tar
#   flatten  fs2json.py + copy-to-sha256.py -> images/study-fs.json and study-rootfs-flat
#            (plain python over the tar, no network)
# Directory for the tar: $BUILD_DIR (default <project root>/.build/study).
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SRC/../.." && pwd)
BUILD_DIR=${BUILD_DIR:-$ROOT/.build/study}
TOOLS=$ROOT/v86det/tools
IMAGES=$ROOT/images
IMAGE_NAME=localhost/i386/study-v86
CONTAINER_NAME=study-v86
TAR=$BUILD_DIR/study-rootfs.tar

image() { podman build "$SRC" --platform linux/386 --rm --tag "$IMAGE_NAME"; }

export_tar() {
    mkdir -p "$BUILD_DIR"
    podman rm "$CONTAINER_NAME" 2>/dev/null || true
    podman create --platform linux/386 -t -i --name "$CONTAINER_NAME" "$IMAGE_NAME"
    podman export "$CONTAINER_NAME" -o "$TAR"
    podman rm "$CONTAINER_NAME"
    # https://github.com/iximiuz/docker-to-linux/issues/19#issuecomment-1242809707
    tar -f "$TAR" --delete ".dockerenv" || true
    ls -l "$TAR"
}

flatten() {
    mkdir -p "$IMAGES"
    "$TOOLS/fs2json.py" --zstd --out "$IMAGES/study-fs.json" "$TAR"
    rm -rf "$IMAGES/study-rootfs-flat"
    mkdir -p "$IMAGES/study-rootfs-flat"
    "$TOOLS/copy-to-sha256.py" --zstd "$TAR" "$IMAGES/study-rootfs-flat"
    du -sh "$IMAGES/study-rootfs-flat"
}

case "${1:-}" in
    image) image ;;
    export) export_tar ;;
    flatten) flatten ;;
    *) sed -n '2,8p' "$0"; exit 2 ;;
esac
