#!/bin/bash
#
# Builds the AArch64 (ARM64) QEMU-Wasm core used by the Emulator Lab.
#
# This mirrors upstream ktock/qemu-wasm-demo's create-images.sh for the
# aarch64 "raspi3ap" target (the working in-browser ARM64 Linux boot), rather
# than inventing our own kernel/rootfs URLs. It compiles qemu-system-aarch64 to
# WebAssembly (TCG -> WASM JIT, multi-threaded) and packages a BusyBox + Linux
# guest image via emscripten's file_packager.
#
# Output lands in ./out/ ready to publish to a static (cross-origin isolated)
# host. Requires Docker. This is a long (multi-hour) emscripten compile — run it
# in CI or on a Linux box, NOT in the Lovable sandbox.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${HERE}/out"
QEMU_WASM_REPO="${QEMU_WASM_REPO:-${HERE}/qemu-wasm}"
BUILD_CONTAINER_NAME=build-qemu-wasm-arm64

rm -rf "${DEST}"
mkdir -p "${DEST}"

# 1. Get the upstream qemu-wasm source (carries the Wasm TCG JIT patches).
# Do NOT --recurse-submodules: qemu's ROM submodules pull edk2, which in turn
# references github.com/Zeex/subhook (repo removed) and aborts the clone. The
# aarch64 raspi3ap target doesn't need any of those ROMs, and the bundled
# `dtc` meson subproject is fetched by meson at configure time, not via git
# submodules.
if [ ! -d "${QEMU_WASM_REPO}/.git" ]; then
  git clone --depth 1 https://github.com/ktock/qemu-wasm.git "${QEMU_WASM_REPO}"
fi

# 1b. Patch upstream's Dockerfile: zlib.net currently returns a 404 page for
#     zlib-1.3.1 in both root and /fossils/, so `tar xJ` sees HTML and fails
#     with "File format not recognized". Use zlib's official GitHub release
#     asset instead.
sed -i \
  's#https://zlib\.net\(/fossils\)\?/zlib-\$ZLIB_VERSION\.tar\.xz#https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.xz#g' \
  "${QEMU_WASM_REPO}/Dockerfile"

# 2. Build the emscripten build environment image from upstream's Dockerfile.
docker build -t buildqemu-arm64 - < "${QEMU_WASM_REPO}/Dockerfile"

# 3. Start the build container (detached; no -it so it works in CI).
#    Mount the source READ-WRITE: for the aarch64 target QEMU needs libfdt and,
#    when it isn't found on the system, meson builds the bundled `dtc` meson
#    subproject with `git init dtc` inside the source tree. A read-only mount
#    makes that mkdir fail ("cannot mkdir dtc: Read-only file system").
docker rm -f "${BUILD_CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run --rm -d --name "${BUILD_CONTAINER_NAME}" \
  -v "${QEMU_WASM_REPO}":/qemu/ buildqemu-arm64

cleanup() { docker rm -f "${BUILD_CONTAINER_NAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 4. Configure + compile qemu-system-aarch64 to WebAssembly.
EXTRA_CFLAGS="-O3 -g -fno-inline-functions -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=emmalloc --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 "
docker exec "${BUILD_CONTAINER_NAME}" emconfigure /qemu/configure \
  --static --target-list=aarch64-softmmu --cpu=wasm32 --cross-prefix= \
  --without-default-features --enable-system --with-coroutine=fiber \
  --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" \
  --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY"
docker exec "${BUILD_CONTAINER_NAME}" emmake make -j "$(nproc)" qemu-system-aarch64

# 5. Build the guest image (BusyBox initramfs + kernel + DTB for raspi3ap).
#    Upstream's Dockerfile emits kernel8.img, bcm2710-rpi-3-b-plus.dtb, and a
#    tiny BusyBox rootfs.bin. We keep the kernel/DTB and REPLACE rootfs.bin
#    with a real Alpine Linux aarch64 rootfs (Stage 2 toward Android) so the
#    guest has a working userland with apk, a package manager, and room to
#    install more software instead of only a 3.7 MB read-only initramfs.
TMPDIR="$(mktemp -d)"
mkdir "${TMPDIR}/pack"
docker build --output=type=local,dest="${TMPDIR}/pack" \
  "${QEMU_WASM_REPO}/examples/raspi3ap/image/"

# 5b. Build the Alpine aarch64 rootfs ext4 image, overwriting rootfs.bin.
#     Runs inside an alpine:latest container so we have apk, e2fsprogs
#     (mke2fs -d populates an ext4 from a directory with no loop mount / no
#     root on the host), curl and tar available regardless of CI runner.
ALPINE_VERSION="${ALPINE_VERSION:-3.20}"
ALPINE_PATCH="${ALPINE_PATCH:-3.20.3}"
ALPINE_ROOTFS_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/aarch64/alpine-minirootfs-${ALPINE_PATCH}-aarch64.tar.gz"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-192}"

docker run --rm -v "${TMPDIR}/pack":/pack alpine:latest /bin/sh -euxc "
  apk add --no-cache curl tar e2fsprogs
  mkdir -p /rootfs
  curl -fsSL '${ALPINE_ROOTFS_URL}' | tar -xz -C /rootfs

  # Serial console: raspi3ap exposes ttyAMA0. Spawn a getty there so the
  # user gets a login prompt after boot, and skip tty1..tty6 (no VT).
  cat > /rootfs/etc/inittab <<'EOF'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
ttyAMA0::respawn:/sbin/getty -L ttyAMA0 115200 vt100
::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
EOF

  # Root has no password (dev image; the guest is sandboxed in a browser tab).
  sed -i 's|^root:[^:]*:|root::|' /rootfs/etc/shadow

  # Reasonable defaults so networking / dns work if we wire -nic later.
  echo 'nameserver 1.1.1.1' > /rootfs/etc/resolv.conf
  echo 'alpine-arm64' > /rootfs/etc/hostname

  # Build a sparse ext4 image populated from /rootfs. -F to skip the
  # 'not a block device' prompt, -E no_copy_xattrs to avoid host xattr noise.
  truncate -s ${ROOTFS_SIZE_MB}M /pack/rootfs.bin
  mkfs.ext4 -F -L alpine-root -d /rootfs -E no_copy_xattrs /pack/rootfs.bin
"

ls -lh "${TMPDIR}/pack"

docker cp "${TMPDIR}/pack" "${BUILD_CONTAINER_NAME}":/
docker exec "${BUILD_CONTAINER_NAME}" /bin/sh -c \
  "/emsdk/upstream/emscripten/tools/file_packager.py qemu-system-aarch64.data --preload /pack > load.js"


# 6. Collect the publishable artifact set into out/.
docker cp "${BUILD_CONTAINER_NAME}":/build/qemu-system-aarch64 "${DEST}/out.js"
for f in qemu-system-aarch64.wasm qemu-system-aarch64.worker.js qemu-system-aarch64.data load.js ; do
  docker cp "${BUILD_CONTAINER_NAME}":/build/${f} "${DEST}/"
done

# 7. Cross-origin isolation for hosts that honor custom headers.
printf '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Access-Control-Allow-Origin: *\n' > "${DEST}/_headers"

# 8. Service-worker fallback for hosts that cannot set headers (e.g. GH Pages).
curl -fsSL https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/master/coi-serviceworker.min.js \
  -o "${DEST}/coi-serviceworker.min.js"

echo "Done. Artifact in ${DEST}:"
ls -lh "${DEST}"
