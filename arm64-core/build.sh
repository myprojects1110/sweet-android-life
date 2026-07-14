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
if [ ! -d "${QEMU_WASM_REPO}/.git" ]; then
  git clone --depth 1 https://github.com/ktock/qemu-wasm.git "${QEMU_WASM_REPO}"
fi

# 2. Build the emscripten build environment image from upstream's Dockerfile.
docker build -t buildqemu-arm64 - < "${QEMU_WASM_REPO}/Dockerfile"

# 3. Start the build container (detached; no -it so it works in CI).
docker rm -f "${BUILD_CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run --rm -d --name "${BUILD_CONTAINER_NAME}" \
  -v "${QEMU_WASM_REPO}":/qemu/:ro buildqemu-arm64

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

# 5. Build the guest image (BusyBox + Linux for the raspi3ap machine) and
#    package it into the emscripten virtual FS.
TMPDIR="$(mktemp -d)"
mkdir "${TMPDIR}/pack"
docker build --output=type=local,dest="${TMPDIR}/pack" \
  "${QEMU_WASM_REPO}/examples/raspi3ap/image/"
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
