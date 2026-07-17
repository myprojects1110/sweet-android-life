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

# ---- Logging helpers -------------------------------------------------------
# Every phase is wrapped in a GitHub Actions log group + timing block so a
# failing CI run shows exactly which phase died and how long each took,
# instead of a wall of undifferentiated output.
log()  { printf '\n\033[1;36m[build %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\n\033[1;33m[build %s WARN]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
phase() {
  local name="$1"; shift
  echo "::group::${name}"
  local t0=$SECONDS
  log "▶ ${name}"
  "$@"
  local dt=$((SECONDS - t0))
  log "✓ ${name} (${dt}s)"
  echo "::endgroup::"
}
trap 'rc=$?; warn "build.sh FAILED at line ${LINENO} (exit ${rc})"; exit $rc' ERR

log "host: $(uname -a)"
log "cwd:  $(pwd)"
log "disk: $(df -h . | tail -1)"
log "cpus: $(nproc)"
log "mem:  $(free -h 2>/dev/null | awk '/Mem:/ {print $2 " total, " $7 " available"}' || echo 'n/a')"
log "docker: $(docker --version 2>&1 || echo 'MISSING')"

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${HERE}/out"
QEMU_WASM_REPO="${QEMU_WASM_REPO:-${HERE}/qemu-wasm}"
BUILD_CONTAINER_NAME=build-qemu-wasm-arm64


rm -rf "${DEST}"
mkdir -p "${DEST}"

# ---------------------------------------------------------------------------
# Phase 1: fetch upstream qemu-wasm source
# ---------------------------------------------------------------------------
phase "1/8 clone qemu-wasm" bash -c '
  if [ ! -d "'"${QEMU_WASM_REPO}"'/.git" ]; then
    log() { printf "\033[1;36m[clone]\033[0m %s\n" "$*"; }
    log "cloning ktock/qemu-wasm (shallow, no submodules)…"
    git clone --depth 1 https://github.com/ktock/qemu-wasm.git "'"${QEMU_WASM_REPO}"'"
  else
    printf "\033[1;36m[clone]\033[0m repo already present, reusing.\n"
  fi
  du -sh "'"${QEMU_WASM_REPO}"'" | sed "s/^/[clone] size: /"
'

# ---------------------------------------------------------------------------
# Phase 2: patch upstream Dockerfile (zlib.net 404 workaround)
# ---------------------------------------------------------------------------
phase "2/8 patch Dockerfile (zlib mirror)" bash -c '
  sed -i \
    "s#https://zlib\.net\(/fossils\)\?/zlib-\$ZLIB_VERSION\.tar\.xz#https://github.com/madler/zlib/releases/download/v\$ZLIB_VERSION/zlib-\$ZLIB_VERSION.tar.xz#g" \
    "'"${QEMU_WASM_REPO}"'/Dockerfile"
  grep -n zlib "'"${QEMU_WASM_REPO}"'/Dockerfile" || true
'

# ---------------------------------------------------------------------------
# Phase 3: build emscripten toolchain image
# ---------------------------------------------------------------------------
phase "3/8 docker build buildqemu-arm64" \
  docker build --progress=plain -t buildqemu-arm64 - < "${QEMU_WASM_REPO}/Dockerfile"

# ---------------------------------------------------------------------------
# Phase 4: start build container
# ---------------------------------------------------------------------------
phase "4/8 start build container" bash -c '
  docker rm -f "'"${BUILD_CONTAINER_NAME}"'" >/dev/null 2>&1 || true
  docker run --rm -d --name "'"${BUILD_CONTAINER_NAME}"'" \
    -v "'"${QEMU_WASM_REPO}"'":/qemu/ buildqemu-arm64
  docker ps --filter name="'"${BUILD_CONTAINER_NAME}"'"
'

cleanup() { docker rm -f "${BUILD_CONTAINER_NAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Phase 5: configure + compile qemu-system-aarch64 → WebAssembly (longest step)
# ---------------------------------------------------------------------------
EXTRA_CFLAGS="-O3 -g -fno-inline-functions -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=emmalloc --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 "

phase "5a/8 emconfigure qemu-system-aarch64" \
  docker exec "${BUILD_CONTAINER_NAME}" emconfigure /qemu/configure \
    --static --target-list=aarch64-softmmu --cpu=wasm32 --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=fiber \
    --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" \
    --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY"

phase "5b/8 emmake qemu-system-aarch64 (long, ~20 min)" \
  docker exec "${BUILD_CONTAINER_NAME}" emmake make -j "$(nproc)" qemu-system-aarch64

log "qemu wasm artifact sizes:"
docker exec "${BUILD_CONTAINER_NAME}" /bin/sh -c \
  'ls -lh /build/qemu-system-aarch64* 2>&1 | sed "s/^/  /"'

# ---------------------------------------------------------------------------
# Phase 6: build guest kernel + DTB (upstream raspi3ap recipe)
# ---------------------------------------------------------------------------
TMPDIR="$(mktemp -d)"
mkdir "${TMPDIR}/pack"
phase "6/8 docker build kernel+dtb (raspi3ap)" \
  docker build --progress=plain --output=type=local,dest="${TMPDIR}/pack" \
    "${QEMU_WASM_REPO}/examples/raspi3ap/image/"
log "kernel/dtb produced:"; ls -lh "${TMPDIR}/pack" | sed 's/^/  /'

# ---------------------------------------------------------------------------
# Phase 7: build Alpine aarch64 rootfs (Stage 2 toward Android)
# ---------------------------------------------------------------------------
ALPINE_VERSION="${ALPINE_VERSION:-3.20}"
ALPINE_PATCH="${ALPINE_PATCH:-3.20.3}"
ALPINE_ROOTFS_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/aarch64/alpine-minirootfs-${ALPINE_PATCH}-aarch64.tar.gz"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-512}"  # QEMU raspi3ap SD size MUST be a power of 2 MiB
#                                        # 512 MiB leaves headroom for JDK + android-tools
ANDROID_PKGS="${ANDROID_PKGS:-bash coreutils util-linux openrc android-tools openjdk17-jre-headless}"

log "rootfs config: alpine=${ALPINE_PATCH} size=${ROOTFS_SIZE_MB}MiB pkgs='${ANDROID_PKGS}'"

phase "7/8 build alpine rootfs.bin (ext4, prepopulated with Android tools)" \
docker run --rm -v "${TMPDIR}/pack":/pack alpine:latest /bin/sh -euxc "
  echo '::group::apk add build helpers'
  apk add --no-cache curl tar e2fsprogs
  echo '::endgroup::'

  echo '::group::download alpine minirootfs'
  mkdir -p /rootfs
  curl -fsSL '${ALPINE_ROOTFS_URL}' | tar -xz -C /rootfs
  du -sh /rootfs | sed 's/^/[rootfs] base size: /'
  echo '::endgroup::'

  echo '::group::apk add guest packages (${ANDROID_PKGS})'
  # Populate the guest with a package cache + a starter Android/JVM toolchain
  # so the browser boot lands ready to run 'adb', 'getprop' shims, and a JRE.
  # apk with --root works against the extracted rootfs; no chroot / binfmt needed.
  cp /etc/apk/repositories /rootfs/etc/apk/repositories
  apk --root /rootfs --initdb add --no-cache alpine-keys
  apk --root /rootfs --no-cache add ${ANDROID_PKGS} || {
    echo '[rootfs] WARN: some Android packages unavailable, continuing with what installed'
  }
  du -sh /rootfs | sed 's/^/[rootfs] size after packages: /'
  echo '::endgroup::'

  echo '::group::write /etc/inittab, hostname, resolv.conf'
  # Minimal init: mount pseudo-fs (skipping devtmpfs — kernel auto-mounts it),
  # then spawn a passwordless root shell on ttyAMA0.
  cat > /rootfs/etc/inittab <<'EOF'
::sysinit:/bin/mount -t proc proc /proc
::sysinit:/bin/mount -t sysfs sysfs /sys
::sysinit:/bin/mount -t tmpfs tmpfs /tmp
::sysinit:/bin/mount -t tmpfs tmpfs /run
::sysinit:/bin/hostname -F /etc/hostname
::sysinit:/bin/dmesg -n 1
::sysinit:/bin/sh -c 'echo; echo \"=== Alpine aarch64 ready (Stage 2 toward Android) ===\"; echo \"Try: adb --version | java -version | apk add <pkg>\"; echo'
ttyAMA0::respawn:/sbin/getty -n -l /bin/sh -L ttyAMA0 115200 vt100
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
EOF
  echo ttyAMA0 >> /rootfs/etc/securetty
  sed -i 's|^root:[^:]*:|root::|' /rootfs/etc/shadow
  echo 'nameserver 1.1.1.1' > /rootfs/etc/resolv.conf
  echo 'alpine-arm64' > /rootfs/etc/hostname
  # /etc/profile banner
  echo 'export PS1=\"[android-lab \\w]# \"' >> /rootfs/etc/profile
  echo '::endgroup::'

  echo '::group::mkfs.ext4 rootfs.bin (${ROOTFS_SIZE_MB} MiB)'
  truncate -s ${ROOTFS_SIZE_MB}M /pack/rootfs.bin
  mkfs.ext4 -F -L alpine-root -d /rootfs -E no_copy_xattrs /pack/rootfs.bin
  ls -lh /pack/rootfs.bin
  echo '::endgroup::'
"

log "pack/ contents that will be preloaded into the guest:"
ls -lh "${TMPDIR}/pack" | sed 's/^/  /'

# ---------------------------------------------------------------------------
# Phase 8: package guest image + copy artifacts
# ---------------------------------------------------------------------------
phase "8a/8 file_packager → qemu-system-aarch64.data" bash -c '
  docker cp "'"${TMPDIR}"'/pack" "'"${BUILD_CONTAINER_NAME}"'":/
  docker exec "'"${BUILD_CONTAINER_NAME}"'" /bin/sh -c \
    "/emsdk/upstream/emscripten/tools/file_packager.py qemu-system-aarch64.data --preload /pack > load.js"
  docker exec "'"${BUILD_CONTAINER_NAME}"'" ls -lh /build/qemu-system-aarch64.data /build/load.js
'

phase "8b/8 copy artifacts to out/" bash -c '
  docker cp "'"${BUILD_CONTAINER_NAME}"'":/build/qemu-system-aarch64 "'"${DEST}"'/out.js"
  for f in qemu-system-aarch64.wasm qemu-system-aarch64.worker.js qemu-system-aarch64.data load.js ; do
    docker cp "'"${BUILD_CONTAINER_NAME}"'":/build/${f} "'"${DEST}"'/"
  done
  printf "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Access-Control-Allow-Origin: *\n" > "'"${DEST}"'/_headers"
  curl -fsSL https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/master/coi-serviceworker.min.js \
    -o "'"${DEST}"'/coi-serviceworker.min.js"
'

log "===================== BUILD SUMMARY ====================="
log "Artifacts in ${DEST}:"
ls -lh "${DEST}" | sed 's/^/  /'
log "Total wall time: ${SECONDS}s"
log "========================================================="

