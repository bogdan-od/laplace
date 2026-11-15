# Building the images yourself

`npm run images` downloads prebuilt archives from the GitHub release `images-v1` (see `images.json`) and unpacks them into `images/`. You only need this document if you want to rebuild the files, for example after changing the emulator, the kernel or the package list.

What `images/` holds:

| File | Made by |
|------|---------|
| `v86.wasm` | `v86det/` (below) |
| `seabios.bin`, `vgabios.bin` | BIOS images shipped with v86 |
| `buildroot-bzimage68.bin` | Buildroot kernel with the root file system embedded |
| `net-bzimage.bin` | `images-src/net/` |
| `alpine-fs.json`, `alpine-rootfs-flat/` | Alpine through `v86det/tools/docker/alpine/` |
| `study-fs.json`, `study-rootfs-flat/` | `images-src/study/` |
| `*-boot.snap` | `app/test/engine.node.mjs boot` |

## The emulator: `v86.wasm`

`v86det/` is upstream v86 at commit `315b2b0` with the patches from `images-src/v86/patches/` applied (SSE and x87 NaN results, `rdtsc`, shared UART interrupt line, UART input state, sparse 9p file ids, 9p `qid.type`, ordered loading of `initrd` and `bzimage`, NE2000 multicast, extra Alpine packages). To rebuild the sources from upstream:

```
git clone https://github.com/copy/v86 && cd v86
git checkout 315b2b0
git am /path/to/laplace/images-src/v86/patches/*.patch
```

`v86det/` in this repository is that result, plus a `Cargo.lock` that upstream does not track.

Needs Rust with the `wasm32-unknown-unknown` target, `clang`, `make` and `node`:

```
cd v86det
rm -f build/v86.wasm build/wasm32-unknown-unknown/release/v86.wasm
STRIP_DEBUG=true make build/v86.wasm
cp build/v86.wasm ../images/v86.wasm
```

After a new `v86.wasm`, rebuild the boot snapshots (below): journals recorded with different NaN behavior of SSE operations will not replay.

The same emulator is published on npm as `v86@0.5.473`; the `v86` development dependency is used by `bench/speed.mjs` for comparison with the stock build and by `images-src/net/guest-run.mjs`.

## The `net` image

A small Buildroot Linux for the network lessons: BusyBox with `nc` and `httpd`, iproute2 (VLAN), iptables (filter and NAT), dnsmasq, tcpdump, dropbear, BIRD. Kernel 6.12 for 32-bit x86, everything built in, no modules, and the root file system embedded in `bzImage`. See `linux.fragment` and `busybox.fragment` for the options.

```
cd images-src/net
./build.sh download         # Buildroot archive and its sha256 (network)
./build.sh unpack
./build.sh list-sources
python3 -I fetch.py ../../.build/net/output/show-info.json ../../.build/net/buildroot-2026.08.1 ../../.build/net/dl   # network
./build.sh verify-sources   # offline: everything is present, hashes match
./build.sh build            # about 10 minutes on 12 cores
./build.sh install          # copies the kernel to images/net-bzimage.bin
node guest-run.mjs ../../images/net-bzimage.bin --nic 'uname -r'
```

The build directory `.build/net` needs about 6 GB; set `BUILD_DIR` to move it. Only `download` and `fetch.py` use the network; `fetch.py` checks every file against the `.hash` files of the Buildroot tree. `guest-run.mjs` boots the image under Node and prints command output; with `--nic` it also checks that the guest answers an ARP request.

Services (dnsmasq and others) do not start by themselves: there are no init scripts, which keeps background processes out of the journals.

## The `study` image

Alpine 3.21.0 i386 with development tools and manual pages (`bash`, `coreutils`, `vim`, `g++`, `git`, `man-pages`, `mandoc` and the `*-doc` packages), root file system over 9p. Needs `podman` and network access.

```
cd images-src/study
./build.sh image     # podman build
./build.sh export    # podman create + export to .build/study/study-rootfs.tar
./build.sh flatten   # fs2json.py + copy-to-sha256.py -> images/study-fs.json, images/study-rootfs-flat/
```

## The `alpine` image

The plain Alpine profile is built by the upstream script, which writes next to the sources:

```
cd v86det/tools/docker/alpine && ./build.sh
mv ../../../images/alpine-fs.json ../../../images/alpine-rootfs-flat ../../../../images/
```

## The `buildroot` image

`buildroot-bzimage68.bin` is the Buildroot kernel with an embedded root file system used by the upstream v86 demos. It is not built here; take it from the v86 project or from the `buildroot` archive of the release.

## Boot snapshots

A boot snapshot is made by the Node core: it boots the system cold, starts the guest agent and the teacher shell, and saves the state at the prompt.

```
node app/test/engine.node.mjs boot buildroot images/buildroot-boot.snap
node app/test/engine.node.mjs boot net       images/net-boot.snap
node app/test/engine.node.mjs boot alpine    images/alpine-boot.snap    # several minutes of guest time
node app/test/engine.node.mjs boot study     images/study-boot.snap
```

## The reseed helper

`images-src/reseed/reseed.S` is a 456-byte static i386 binary that reseeds the guest random generator at the start of each session (`ioctl RNDRESEEDCRNG` on `/dev/urandom`). Its base64 form is `RESEED_ELF` in `app/profiles.mjs`. To rebuild:

```
as --32 reseed.S -o reseed.o && ld -m elf_i386 -N -s --build-id=none -o reseed reseed.o && base64 -w0 reseed
```

## Publishing the archives

`node scripts/pack-images.mjs [output-dir]` packs `images/` into `common`, `buildroot`, `net`, `alpine` and `study` archives (sorted entries, zero timestamps, so the result is reproducible) and rewrites `images.json` with sizes and sha256. Upload the archives to the GitHub release named in `images.json`. To test the download without publishing, point `npm run images` at a directory or a URL:

```
LAPLACE_IMAGES_URL=/path/to/archives npm run images
```
