# QEMU-Wasm ARM64 core

This directory builds the **aarch64 (ARM64) CPU core** used by the Emulator Lab
(`/emulator` → `aarch64` tab). It compiles [`ktock/qemu-wasm`](https://github.com/ktock/qemu-wasm)
(QEMU with a **TCG → WebAssembly JIT** backend, multi-threaded) to WebAssembly
and packages a bootable ARM64 Linux guest, then publishes the result to a static
host.

The build **exactly mirrors upstream's tested flow** — `build.sh` reproduces
`ktock/qemu-wasm-demo`'s `create-images.sh` for the AArch64 `raspi3ap` target
(the working in-browser ARM64 Linux boot). We do **not** invent kernel/rootfs
URLs; the guest image is built from `qemu-wasm/examples/raspi3ap/image/`.

> The build is a multi-hour emscripten + Docker compile. It **cannot** run in
> the Lovable chat sandbox — run it in CI (GitHub Actions config included) or on
> any Linux box with Docker, then host the output.

## What the build produces (`out/`)

```
out/
  out.js                     # emscripten glue (qemu-system-aarch64) loaded by the Lab
  qemu-system-aarch64.wasm   # QEMU compiled to WebAssembly (TCG→WASM JIT)
  qemu-system-aarch64.worker.js
  qemu-system-aarch64.data   # packaged guest image (BusyBox + Linux)
  load.js                    # file_packager loader for the .data image
  _headers                   # COOP/COEP for hosts that honor custom headers
  coi-serviceworker.min.js   # header fallback for hosts that can't (GitHub Pages)
```

## Cross-origin isolation (required)

QEMU-Wasm uses threads (`SharedArrayBuffer`), so the page serving `out.js`
**must be cross-origin isolated**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- Hosts that support custom headers (Cloudflare Pages via `_headers`, Netlify,
  nginx): set them directly — a `_headers` file is emitted into `out/`.
- Hosts that don't (GitHub Pages): the emitted `coi-serviceworker.min.js`
  registers a service worker that re-serves the page with those headers.

## Local build

```bash
cd arm64-core
./build.sh              # clones qemu-wasm, compiles, packages -> ./out
python3 serve.py        # http://localhost:8000/  (sends COOP/COEP)
```

Then in the app: open `/emulator`, pick **aarch64**, paste the base URL
(e.g. `http://localhost:8000/`), press **Boot**.

## CI

`.github/workflows/qemu-wasm-arm64.yml` runs the same `build.sh` and deploys
`out/` to GitHub Pages. After it runs, paste the Pages URL into the aarch64
core field.
