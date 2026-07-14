# syntax=docker/dockerfile:1
#
# Builds QEMU-Wasm (aarch64 / ARM64) with the TCG -> WebAssembly JIT backend
# and bundles a bootable ARM64 Linux kernel + rootfs.
#
# Output is collected into /out. Extract with:
#   docker create --name qw qemu-wasm-arm64 && docker cp qw:/out ./out
#
# NOTE: this is a long (multi-hour) compile. Run it in CI or on a Linux host
# with Docker + plenty of RAM/disk. It cannot run in the Lovable sandbox.

ARG EMSDK_VERSION=3.1.74

# ---------------------------------------------------------------------------
# Stage 1: build QEMU (aarch64-softmmu) to WebAssembly via emscripten
# ---------------------------------------------------------------------------
FROM emscripten/emsdk:${EMSDK_VERSION} AS qemu-build

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-pip ninja-build pkg-config flex bison \
      libglib2.0-dev-bin meson \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# ktock/qemu-wasm carries the Wasm TCG (JIT) backend patches.
RUN git clone --depth 1 https://github.com/ktock/qemu-wasm.git .

# glib for wasm is fetched/built by the qemu-wasm build scripts; the repo's
# scripts/ contain the emscripten configure flags. We invoke its documented
# build entrypoint so we track upstream flags rather than hard-coding them.
RUN ./scripts/build-wasm.sh aarch64-softmmu

# ---------------------------------------------------------------------------
# Stage 2: fetch/assemble a bootable ARM64 Linux kernel + rootfs
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS guest

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates cpio gzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /guest
# Minimal aarch64 kernel + rootfs (BusyBox). Replace these two URLs later with
# a Cuttlefish aosp_cf_arm64 boot image + super.img for Milestone 3 (Android 17).
ARG KERNEL_URL=https://ktock.github.io/qemu-wasm-demo/assets/aarch64/Image
ARG ROOTFS_URL=https://ktock.github.io/qemu-wasm-demo/assets/aarch64/rootfs.bin
RUN curl -fsSL "$KERNEL_URL" -o Image \
 && curl -fsSL "$ROOTFS_URL" -o rootfs.bin

# ---------------------------------------------------------------------------
# Stage 3: assemble the publishable artifact
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS out-stage

WORKDIR /out
COPY --from=qemu-build /src/build/out.js       ./out.js
COPY --from=qemu-build /src/build/out.wasm     ./out.wasm
COPY --from=guest      /guest/Image            ./Image
COPY --from=guest      /guest/rootfs.bin       ./rootfs.bin

# Cross-origin isolation for hosts that support custom headers.
RUN printf '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Access-Control-Allow-Origin: *\n' > _headers

# Service-worker fallback for hosts that cannot set headers (e.g. GitHub Pages).
ADD https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/master/coi-serviceworker.min.js ./coi-serviceworker.min.js

# Final image just carries /out; nothing to run.
FROM scratch
COPY --from=out-stage /out /out
