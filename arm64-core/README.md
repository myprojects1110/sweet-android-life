# QEMU-Wasm ARM64 core

This directory builds the **aarch64 (ARM64) CPU core** used by the Emulator Lab
(`/emulator` → `aarch64` tab). It compiles [`ktock/qemu-wasm`](https://github.com/ktock/qemu-wasm)
(QEMU with a **TCG → WebAssembly JIT** backend) to WebAssembly, bundles a
bootable ARM64 Linux kernel + rootfs, and publishes the result to a static host.

> The build is a multi-hour emscripten + Docker compile. It **cannot** run in
> the Lovable chat sandbox — run it in CI (GitHub Actions config included) or on
> any Linux box with Docker, then host the output.

## What the build produces (`out/`)

```
out/
  out.js         # emscripten glue loaded by the Emulator Lab
  out.wasm       # QEMU compiled to WebAssembly (TCG→WASM JIT)
  Image          # ARM64 Linux kernel
  rootfs.bin     # root filesystem
  coi-serviceworker.min.js  # injects COOP/COEP on hosts that can't set headers
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

The assets must also be reachable **CORS-enabled** from the Lovable app origin
(the service worker / `_headers` already send `Access-Control-Allow-Origin: *`
for same-site; for a different origin, ensure the host adds it).

## Local build

```bash
cd arm64-core
docker build -t qemu-wasm-arm64 .
# extract the built artifact
docker create --name qw qemu-wasm-arm64
docker cp qw:/out ./out
docker rm qw
# serve locally with isolation headers, then point the Lab at it
python3 serve.py   # http://localhost:8000/  (sends COOP/COEP)
```

Then in the app: open `/emulator`, pick **aarch64**, paste the base URL
(e.g. `http://localhost:8000/`), press **Boot**.

## CI

`.github/workflows/qemu-wasm-arm64.yml` runs the same build and deploys `out/`
to GitHub Pages. After it runs, paste the Pages URL into the aarch64 core field.
