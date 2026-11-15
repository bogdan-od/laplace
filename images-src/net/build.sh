#!/bin/bash
# Builds the "net" image for v86. Usage: build.sh <step>
#   download       download the Buildroot archive and check its sha256 (needs network)
#   unpack         unpack the archive, create the defconfig with paths substituted
#   list-sources   write the list of sources to output/show-info.json; then:
#                  ./fetch.py output/show-info.json buildroot-<version> dl  (the only step with network)
#   verify-sources make source: check that all sources are present and their hashes match
#   kernel-config  generate linux.defconfig from linux.fragment (needs the kernel sources)
#   build          build the kernel with the root filesystem (no network)
#   rebuild-kernel rebuild after a change to linux.fragment (kernel-config, then this step)
#   install        copy bzImage to images/net-bzimage.bin
# Build directory: $BUILD_DIR (default <project root>/.build/net).
set -euo pipefail

BR_VERSION=2026.08.1
BR_SHA256=34fb7bea8a213ffde39cc02e61703391560f26e0850f03138c722d0b09880f2b
KERNEL_VERSION=6.12.112
JOBS=${JOBS:-8}
# ccache from the system gcc wrapper writes to ~/.cache; it is not needed here
export CCACHE_DISABLE=1

SRC=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SRC/../.." && pwd)
BUILD_DIR=${BUILD_DIR:-$ROOT/.build/net}
BR_DIR=$BUILD_DIR/buildroot-$BR_VERSION
OUT=$BUILD_DIR/output
TARBALL=$BUILD_DIR/buildroot-$BR_VERSION.tar.xz

br_make() { nice -n 19 make -C "$BR_DIR" O="$OUT" "$@"; }

download() {
    mkdir -p "$BUILD_DIR"
    [ -f "$TARBALL" ] || curl -fsSL -o "$TARBALL" "https://buildroot.org/downloads/buildroot-$BR_VERSION.tar.xz"
    echo "$BR_SHA256  $TARBALL" | sha256sum -c -
}

unpack() {
    echo "$BR_SHA256  $TARBALL" | sha256sum -c -
    [ -d "$BR_DIR" ] || tar -C "$BUILD_DIR" -xf "$TARBALL"
    mkdir -p "$OUT"
    sed -e "s|@SRC@|$SRC|g" -e "s|@BUILD_DIR@|$BUILD_DIR|g" "$SRC/net_defconfig" > "$OUT/net_defconfig"
    [ -f "$SRC/linux.defconfig" ] || : > "$SRC/linux.defconfig"
    br_make BR2_DEFCONFIG="$OUT/net_defconfig" defconfig
}

# Only fetch.py needs the network (curl + sha256); it runs as a separate step.
list_sources() { br_make --no-print-directory show-info > "$OUT/show-info.json"; }

verify_sources() { br_make source; }

kernel_config() {
    # A separate unpack: the tree Buildroot builds in is not "clean" for an out-of-tree kconfig afterwards.
    local kdir=$OUT/kconfig-src kout=$OUT/kconfig
    if [ ! -d "$kdir" ]; then
        mkdir -p "$kdir"
        tar -C "$kdir" --strip-components=1 -xf "$BUILD_DIR/dl/linux/linux-$KERNEL_VERSION.tar.xz"
    fi
    rm -rf "$kout"; mkdir -p "$kout"
    local make_kernel=(make -C "$kdir" O="$kout" ARCH=i386)
    KCONFIG_ALLCONFIG="$SRC/linux.fragment" "${make_kernel[@]}" allnoconfig
    "${make_kernel[@]}" savedefconfig
    cp "$kout/defconfig" "$SRC/linux.defconfig"
    check_kernel_config "$kout/.config"
}

# allnoconfig silently drops options whose dependencies are not met: check that every option of the fragment is set.
check_kernel_config() {
    local missing=0 line
    while IFS= read -r line; do
        case "$line" in CONFIG_*=*) ;; *) continue ;; esac
        grep -qxF "$line" "$1" || { echo "kernel: option dropped: $line"; missing=1; }
    done < "$SRC/linux.fragment"
    return $missing
}

build() { br_make -j"$JOBS"; }

rebuild_kernel() { br_make linux-reconfigure && build; }

install_image() {
    mkdir -p "$ROOT/images"
    cp "$OUT/images/bzImage" "$ROOT/images/net-bzimage.bin"
    ls -l "$ROOT/images/net-bzimage.bin"
}

case "${1:-}" in
    download) download ;;
    unpack) unpack ;;
    list-sources) list_sources ;;
    verify-sources) verify_sources ;;
    kernel-config) kernel_config ;;
    build) build ;;
    rebuild-kernel) rebuild_kernel ;;
    install) install_image ;;
    *) sed -n '2,13p' "$0"; exit 2 ;;
esac
