import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import linuxImage from "../assets/linux.iso.asset.json";
import seabios from "../assets/seabios.bin.asset.json";
import vgabios from "../assets/vgabios.bin.asset.json";
import {
  ensureImages,
  fetchManifest,
  readCached,
  type Progress,
} from "../lib/opfs-images";
import { getOpfsBlockClient } from "../lib/opfs-block-bridge";
import { makeOpfsBlockFS, installOpfsBlockFsRef } from "../lib/opfs-block-fs";

// Cuttlefish files that must NEVER be loaded into MEMFS — mount via OPFS
// block FS instead. Anything larger than a few MiB belongs here.
const BLOCK_MOUNTED = new Set(["super.img", "userdata.img"]);

export const Route = createFileRoute("/emulator")({
  head: () => ({
    meta: [
      { title: "Browser Emulator Lab — Milestone 1" },
      {
        name: "description",
        content:
          "In-browser software-emulated CPU boot harness: display, serial console and input loop. Foundation for ARM64 / Android emulation.",
      },
      { property: "og:title", content: "Browser Emulator Lab — Milestone 1" },
      {
        property: "og:description",
        content:
          "Boot a full OS inside a browser tab with a WASM software CPU. The device/display/input skeleton for the AOSP-in-browser research track.",
      },
    ],
  }),
  component: EmulatorPage,
});

const V86_SCRIPT = "https://cdn.jsdelivr.net/npm/v86@0.5.424/build/libv86.js";
const V86_WASM = "https://cdn.jsdelivr.net/npm/v86@0.5.424/build/v86.wasm";
const COI_SCRIPT = "/coi-serviceworker.min.js";
const DEFAULT_QEMU_BASE = "https://myprojects1110.github.io/sweet-android-life/";
const BIOS = seabios.url;
const VGA_BIOS = vgabios.url;
// Small bootable Linux ISO, served same-origin from Lovable's CDN (no CORS issues).
const DEFAULT_IMAGE = linuxImage.url;
const DEFAULT_ANDROID_MANIFEST =
  "https://huggingface.co/datasets/ervjn455/android-17-wasm-images/resolve/main/manifest.json";

declare global {
  interface Window {
    V86?: new (options: Record<string, unknown>) => V86Instance;
  }
}

type V86Instance = {
  add_listener: (event: string, cb: (data: unknown) => void) => void;
  destroy?: () => void;
  serial0_send?: (data: string) => void;
  keyboard_send_scancodes?: (codes: number[]) => void;
};

type Listener<T> = (value: T) => void;

type PseudoPty = {
  readonly readable: boolean;
  readonly writable: boolean;
  read: (length?: number) => number[];
  write: (arg: string | number[]) => void;
  ioctl: (req: "TCGETS" | "TCSETS" | "TIOCGWINSZ", arg?: unknown) => unknown;
  onReadable: (listener: Listener<void>) => { dispose: () => void };
  onSignal: (listener: Listener<"SIGINT" | "SIGQUIT" | "SIGTSTP" | "SIGWINCH">) => {
    dispose: () => void;
  };
  pushInput: (text: string) => void;
  dispose: () => void;
};

type EmscriptenModuleConfig = Record<string, unknown> & {
  pty?: PseudoPty;
  TTY?: { stream_ops?: { poll?: unknown } };
};

function createEmitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    register(listener: Listener<T>) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire(value: T) {
      listeners.forEach((listener) => listener(value));
    },
    clear() {
      listeners.clear();
    },
  };
}

function createTextAreaPty(appendOutput: (text: string) => void): PseudoPty {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const inputQueue: number[] = [];
  const readable = createEmitter<void>();
  const signals = createEmitter<"SIGINT" | "SIGQUIT" | "SIGTSTP" | "SIGWINCH">();
  let termios = {
    iflag: 0,
    oflag: 1,
    cflag: 0,
    lflag: 0,
    cc: Array.from({ length: 32 }, () => 0),
    clone() {
      return { ...this, cc: [...this.cc], clone: this.clone };
    },
  };

  return {
    get readable() {
      return inputQueue.length > 0;
    },
    get writable() {
      return true;
    },
    read(length = inputQueue.length) {
      return inputQueue.splice(0, Math.max(0, length));
    },
    write(arg) {
      const bytes = typeof arg === "string" ? encoder.encode(arg) : new Uint8Array(arg);
      appendOutput(decoder.decode(bytes, { stream: true }));
    },
    ioctl(req, arg) {
      if (req === "TCGETS") return termios.clone();
      if (req === "TCSETS" && arg && typeof arg === "object") {
        const next = arg as { iflag?: number; oflag?: number; cflag?: number; lflag?: number; cc?: number[] };
        termios = {
          iflag: next.iflag ?? termios.iflag,
          oflag: next.oflag ?? termios.oflag,
          cflag: next.cflag ?? termios.cflag,
          lflag: next.lflag ?? termios.lflag,
          cc: next.cc ? [...next.cc] : termios.cc,
          clone: termios.clone,
        };
        return undefined;
      }
      if (req === "TIOCGWINSZ") return [80, 24];
      return undefined;
    },
    onReadable: readable.register,
    onSignal: signals.register,
    pushInput(text) {
      inputQueue.push(...encoder.encode(text));
      readable.fire(undefined);
    },
    dispose() {
      readable.clear();
      signals.clear();
      inputQueue.length = 0;
    },
  };
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function installCrossOriginIsolationServiceWorker() {
  if (window.crossOriginIsolated || !("serviceWorker" in navigator)) return;
  await loadScript(COI_SCRIPT);
}

function EmulatorInner() {
  const screenRef = useRef<HTMLDivElement>(null);
  const serialRef = useRef<HTMLTextAreaElement>(null);
  const emuRef = useRef<V86Instance | null>(null);
  const arm64PtyRef = useRef<PseudoPty | null>(null);
  const arm64WorkerUrlRef = useRef<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "running" | "error"
  >("idle");
  const [arch, setArch] = useState<"x86_64" | "aarch64">("x86_64");
  const [imageUrl, setImageUrl] = useState(DEFAULT_IMAGE);
  const [imageKind, setImageKind] = useState<"cdrom" | "hda">("cdrom");
  // ARM64 (QEMU-Wasm) artifact base URL, e.g. https://your-host/qemu-aarch64/
  // Must contain the emscripten glue (out.js) + .wasm produced by a
  // qemu-wasm (TCG→WASM JIT) build. Left blank until an artifact is hosted.
  const [qemuBase, setQemuBase] = useState(DEFAULT_QEMU_BASE);
  // ARM64 boot profile:
  //   raspi3ap  — the working Alpine boot bundled into the QEMU-Wasm .data image
  //   virt      — modern virt board with virtio-{blk,net,gpu,input}, for AOSP
  //               Cuttlefish (aosp_cf_arm64_phone). Needs external image hosting.
  const [armProfile, setArmProfile] = useState<"raspi3ap" | "virt">("raspi3ap");
  const [androidManifestUrl, setAndroidManifestUrl] = useState(
    DEFAULT_ANDROID_MANIFEST,
  );
  const [serial, setSerial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ frames: 0 });

  const appendSerial = useCallback((chunk: string) => {
    setSerial((prev) => {
      const next = (prev + chunk).slice(-20000);
      return next;
    });
  }, []);

  useEffect(() => {
    const el = serialRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [serial]);

  useEffect(() => {
    installCrossOriginIsolationServiceWorker().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  const boot = useCallback(async () => {
    setError(null);
    setSerial("");
    setStatus("loading");
    try {
      // v86's bundle references Node globals; provide them in the browser.
      const w = window as unknown as {
        global: Window;
        setImmediate?: (fn: (...a: unknown[]) => void, ...a: unknown[]) => number;
        clearImmediate?: (id: number) => void;
        Module?: Record<string, unknown>;
      };
      w.global = window;
      if (typeof w.setImmediate !== "function") {
        w.setImmediate = (fn, ...a) =>
          window.setTimeout(fn, 0, ...a) as unknown as number;
        w.clearImmediate = (id) => window.clearTimeout(id);
      }

      if (arch === "aarch64") {
        // ARM64 core: QEMU-Wasm (TCG→WASM JIT). Requires a self-hosted,
        // CORS-enabled artifact (emscripten glue + .wasm) built via the
        // qemu-wasm toolchain — see the ARM64 panel for build steps.
        const base = qemuBase.trim().replace(/\/?$/, "/");
        if (!base) {
          throw new Error(
            "Set the QEMU-Wasm artifact base URL to boot the ARM64 core.",
          );
        }
        if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
          await installCrossOriginIsolationServiceWorker();
          appendSerial(
            "[harness] enabling cross-origin isolation (COOP/COEP) — reloading page…\n",
          );
          // The COI service worker triggers a reload itself on first install,
          // but force one here in case it's already registered from a prior visit
          // and the headers just aren't applied to this navigation yet.
          setTimeout(() => window.location.reload(), 300);
          return;
        }
        arm64PtyRef.current?.dispose();
        const pty = createTextAreaPty(appendSerial);
        arm64PtyRef.current = pty;
        if (arm64WorkerUrlRef.current) {
          URL.revokeObjectURL(arm64WorkerUrlRef.current);
          arm64WorkerUrlRef.current = null;
        }
        const workerResponse = await fetch(base + "qemu-system-aarch64.worker.js", {
          mode: "cors",
        });
        if (!workerResponse.ok) {
          throw new Error(
            `Failed to load QEMU-Wasm worker (${workerResponse.status}) from ${base}`,
          );
        }
        const workerUrl = URL.createObjectURL(
          new Blob([await workerResponse.text()], { type: "text/javascript" }),
        );
        arm64WorkerUrlRef.current = workerUrl;
        appendSerial(
          `[harness] loading ARM64 QEMU-Wasm package from ${base}load.js …\n`,
        );
        const qemuArgs =
          armProfile === "virt"
            ? [
                // Stage 3: modern virt board for AOSP Cuttlefish (Android 17).
                // Images stream from HF → OPFS → MEMFS at /pack/<name>, and
                // boot.img / vendor_boot.img are unpacked at boot time into
                // /pack/_kernel and /pack/_ramdisk (see preRun below).
                "-machine", "virt,gic-version=3",
                "-cpu", "cortex-a53",
                "-smp", "2",
                "-m", "2048",
                "-kernel", "/pack/_kernel",
                "-initrd", "/pack/_ramdisk",
                "-drive", "file=/blk/super.img,format=raw,if=none,id=super,readonly=on",
                "-device", "virtio-blk-pci,drive=super",
                "-drive", "file=/blk/userdata.img,format=raw,if=none,id=data,readonly=on",
                "-device", "virtio-blk-pci,drive=data",
                "-device", "virtio-gpu-pci",
                "-device", "virtio-tablet-pci",
                "-device", "virtio-keyboard-pci",
                "-netdev", "user,id=n0",
                "-device", "virtio-net-pci,netdev=n0",
                "-append",
                "console=ttyAMA0 androidboot.hardware=cutf_cvm androidboot.selinux=permissive rw",
                "-nographic",
                "-accel", "tcg,tb-size=500",
              ]
            : [
                // Stage 2 (working): raspi3ap + Alpine rootfs baked into .data
                "-nic", "none",
                "-M", "raspi3ap",
                "-nographic",
                "-m", "512M",
                "-accel", "tcg,tb-size=500",
                "-smp", "4",
                "-dtb", "/pack/bcm2710-rpi-3-b-plus.dtb",
                "-kernel", "/pack/kernel8.img",
                "-drive", "file=/pack/rootfs.bin,format=raw,if=sd",
                "-append",
                "earlycon=pl011,0x3f201000 console=ttyAMA0,115200 loglevel=6 initcall_blacklist=bcm2835_pm_driver_init root=/dev/mmcblk0 rootfstype=ext4 rootwait no_console_suspend",
              ];
        let cachedAndroidImages: Awaited<ReturnType<typeof ensureImages>> = [];
        let androidBuildId = "";
        if (armProfile === "virt") {
          if (!androidManifestUrl.trim()) {
            throw new Error("virt profile needs an Android manifest URL.");
          }
          appendSerial(
            `[harness] fetching manifest ${androidManifestUrl} …\n`,
          );
          const manifest = await fetchManifest(androidManifestUrl);
          androidBuildId = manifest.build_id;
          appendSerial(
            `[harness] manifest build_id=${manifest.build_id} target=${manifest.target ?? "?"} files=${manifest.files.length}\n`,
          );
          const baseImages = androidManifestUrl.replace(/manifest\.json(?:\?.*)?$/, "");
          let lastLog = 0;
          const onProgress = (p: Progress) => {
            if (p.phase === "cached") {
              appendSerial(`[opfs] ✓ cached ${p.file} (${p.total} bytes)\n`);
              return;
            }
            if (p.phase === "ready") {
              appendSerial(`[opfs] ✓ downloaded ${p.file}\n`);
              return;
            }
            if (p.phase === "verify") {
              appendSerial(`[opfs] verifying sha256 for ${p.file} …\n`);
              return;
            }
            if (p.phase === "check") {
              appendSerial(`[opfs] checking ${p.file} …\n`);
              lastLog = 0;
              return;
            }
            const now = performance.now();
            if (now - lastLog > 500) {
              lastLog = now;
              const pct = p.total ? ((p.received / p.total) * 100).toFixed(1) : "?";
              appendSerial(
                `[opfs]   ${p.file}: ${(p.received / (1024 * 1024)).toFixed(1)} / ${(p.total / (1024 * 1024)).toFixed(1)} MiB (${pct}%)\n`,
              );
            }
          };
          cachedAndroidImages = await ensureImages(manifest, baseImages, onProgress);
          appendSerial(
            `[harness] all ${cachedAndroidImages.length} images ready in OPFS.\n`,
          );
        }

        type EmscriptenFS = {
          mkdirTree: (path: string) => void;
          writeFile: (path: string, data: Uint8Array) => void;
          mount: (fs: unknown, opts: unknown, mountpoint: string) => void;
          isDir: (mode: number) => boolean;
          isFile: (mode: number) => boolean;
          createNode: unknown;
          ErrnoError: unknown;
        };

        // Pre-open the OPFS block bridge on the main thread; the client
        // object (which only touches the SAB) is safely usable from the
        // pthread that eventually calls into our custom FS.
        let blockClient: Awaited<ReturnType<typeof getOpfsBlockClient>> | null = null;
        const blockEntries: { name: string; opfsPath: string }[] = [];
        if (cachedAndroidImages.length) {
          try {
            blockClient = await getOpfsBlockClient();
            appendSerial(`[opfs-block] worker ready (SAB ${blockClient.sab.byteLength} bytes)\n`);
          } catch (e) {
            appendSerial(
              `[opfs-block] failed to init: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
        }

        const resolveFS = (mod: unknown): EmscriptenFS => {
          const m = (mod ?? {}) as Record<string, unknown>;
          const g = globalThis as Record<string, unknown>;
          const fs =
            (m.FS as EmscriptenFS | undefined) ??
            (g.FS as EmscriptenFS | undefined) ??
            ((): EmscriptenFS | undefined => {
              // Fallback: some Emscripten builds only expose FS_* helpers on Module.
              const mk = m.FS_mkdirTree as ((p: string) => void) | undefined;
              const wf = m.FS_createDataFile as
                | ((parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean, canOwn: boolean) => void)
                | undefined;
              if (!mk || !wf) return undefined;
              return {
                mkdirTree: mk,
                writeFile: (path: string, data: Uint8Array) => {
                  const i = path.lastIndexOf("/");
                  const parent = path.slice(0, i) || "/";
                  const name = path.slice(i + 1);
                  mk(parent);
                  wf(parent, name, data, true, true, true);
                },
                mount: () => {
                  throw new Error("FS.mount unavailable (FS not exported)");
                },
                isDir: () => false,
                isFile: () => false,
                createNode: undefined,
                ErrnoError: undefined,
              } as EmscriptenFS;
            })();
          if (!fs) {
            const keys = Object.keys(m).filter((k) => k.startsWith("FS")).slice(0, 20);
            throw new Error(
              `Emscripten FS not exposed on Module. FS-ish keys: ${keys.join(", ") || "(none)"}`,
            );
          }
          return fs;
        };

        const preRun: Array<(mod: unknown) => void | Promise<void>> = [];
        if (cachedAndroidImages.length) {
          preRun.push(async (rawMod) => {
            const mod = { FS: resolveFS(rawMod) } as { FS: EmscriptenFS };
            mod.FS.mkdirTree("/pack");
            mod.FS.mkdirTree("/blk");
            const byName = new Map<string, typeof cachedAndroidImages[number]>();
            for (const img of cachedAndroidImages) byName.set(img.file.name, img);
            for (const img of cachedAndroidImages) {
              if (BLOCK_MOUNTED.has(img.file.name) && blockClient) {
                // Path inside OPFS matches opfs-images.ts layout.
                const opfsPath = `cuttlefish/${androidBuildId}/${img.file.name}`;
                blockEntries.push({ name: img.file.name, opfsPath });
                appendSerial(
                  `[fs] mounting /blk/${img.file.name} via OPFS block FS (${img.file.size} bytes, zero MEMFS)\n`,
                );
                continue;
              }
              appendSerial(`[fs] mounting /pack/${img.file.name} (${img.file.size} bytes)\n`);
              const bytes = await readCached(img);
              mod.FS.writeFile("/pack/" + img.file.name, bytes);
            }

            if (blockClient && blockEntries.length) {
              installOpfsBlockFsRef({
                createNode: mod.FS.createNode as never,
                isDir: mod.FS.isDir,
                isFile: mod.FS.isFile,
                ErrnoError: mod.FS.ErrnoError as never,
              });
              try {
                mod.FS.mount(makeOpfsBlockFS(blockClient), { entries: blockEntries }, "/blk");
                appendSerial(
                  `[opfs-block] mounted at /blk with ${blockEntries.length} file(s)\n`,
                );
              } catch (e) {
                appendSerial(
                  `[opfs-block] FS.mount failed: ${e instanceof Error ? e.message : String(e)}\n` +
                    `[opfs-block] The QEMU-Wasm Emscripten build may proxy FS ops to the main thread,\n` +
                    `[opfs-block] where Atomics.wait throws. A rebuilt QEMU with a custom block driver\n` +
                    `[opfs-block] hitting SyncAccessHandle from the QEMU pthread is required to fix this.\n`,
                );
              }
            }

            // Unpack boot.img → kernel + generic ramdisk, vendor_boot.img →
            // vendor ramdisk. Feed the concatenated cpio(.gz) blob to -initrd.
            const boot = byName.get("boot.img");
            const vboot = byName.get("vendor_boot.img");
            if (boot) {
              const { parseBootImage, parseVendorBootImage, combineRamdisks } =
                await import("../lib/android-boot");
              const bootParts = parseBootImage(await readCached(boot));
              appendSerial(
                `[boot] boot.img v${bootParts.headerVersion}: kernel=${bootParts.kernel.length} ramdisk=${bootParts.ramdisk.length}\n`,
              );
              mod.FS.writeFile("/pack/_kernel", bootParts.kernel);
              let ramdisk = bootParts.ramdisk;
              if (vboot) {
                const vp = parseVendorBootImage(await readCached(vboot));
                appendSerial(
                  `[boot] vendor_boot.img v${vp.headerVersion}: vendor_ramdisk=${vp.vendorRamdisk.length} dtb=${vp.dtb.length} bootconfig=${vp.bootconfig.length}\n`,
                );
                ramdisk = combineRamdisks(vp.vendorRamdisk, ramdisk);
                if (vp.dtb.length) mod.FS.writeFile("/pack/_dtb", vp.dtb);
                if (vp.bootconfig.length)
                  mod.FS.writeFile("/pack/_bootconfig", vp.bootconfig);
              }
              mod.FS.writeFile("/pack/_ramdisk", ramdisk);
              appendSerial(
                `[boot] wrote /pack/_kernel (${bootParts.kernel.length}) and /pack/_ramdisk (${ramdisk.length})\n`,
              );
            }
          });
        }

        const moduleConfig: EmscriptenModuleConfig = {
          arguments: qemuArgs,
          mainScriptUrlOrBlob: base + "out.js",
          pty,
          preRun,
          print: (line: string) => appendSerial(line + "\n"),
          printErr: (line: string) => appendSerial(line + "\n"),
          locateFile: (p: string) =>
            p === "qemu-system-aarch64.worker.js" ? workerUrl : base + p,
          onRuntimeInitialized: () => setStatus("running"),
        };
        w.Module = moduleConfig;
        await loadScript(base + "load.js");
        appendSerial(
          `[harness] loading ARM64 QEMU-Wasm core from ${base}out.js …\n`,
        );
        const qemuModule = (await import(/* @vite-ignore */ `${base}out.js`)) as {
          default?: (moduleArg: EmscriptenModuleConfig) => Promise<EmscriptenModuleConfig>;
        };
        if (typeof qemuModule.default !== "function") {
          throw new Error("QEMU-Wasm core did not export an Emscripten initializer.");
        }
        const instance = await qemuModule.default(moduleConfig);
        const oldPoll = instance.TTY?.stream_ops?.poll;
        if (typeof oldPoll === "function" && instance.TTY?.stream_ops) {
          instance.TTY.stream_ops.poll = function patchedPoll(stream: unknown, timeout: unknown) {
            if (!pty.readable) {
              return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
            }
            return oldPoll.call(this, stream, timeout);
          };
        }
        setStatus("running");
        return;
      }

      // x86_64 core: v86.
      await loadScript(V86_SCRIPT);
      const V86 = window.V86;
      if (!V86) throw new Error("v86 failed to initialize");

      const options: Record<string, unknown> = {
        wasm_path: V86_WASM,
        bios: { url: BIOS },
        vga_bios: { url: VGA_BIOS },
        screen_container: screenRef.current,
        autostart: true,
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        disable_speaker: true,
      };
      options[imageKind] = { url: imageUrl };

      const emu = new V86(options);
      emuRef.current = emu;

      emu.add_listener("serial0-output-byte", (byte) => {
        appendSerial(String.fromCharCode(byte as number));
      });
      emu.add_listener("emulator-started", () => setStatus("running"));
      emu.add_listener("screen-put-char", () => {
        setStats((s) => ({ frames: s.frames + 1 }));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [arch, qemuBase, imageUrl, imageKind, armProfile, androidManifestUrl, appendSerial]);

  const stop = useCallback(() => {
    emuRef.current?.destroy?.();
    emuRef.current = null;
    arm64PtyRef.current?.dispose();
    arm64PtyRef.current = null;
    if (arm64WorkerUrlRef.current) {
      URL.revokeObjectURL(arm64WorkerUrlRef.current);
      arm64WorkerUrlRef.current = null;
    }
    setStatus("idle");
  }, []);

  useEffect(
    () => () => {
      emuRef.current?.destroy?.();
      arm64PtyRef.current?.dispose();
      if (arm64WorkerUrlRef.current) URL.revokeObjectURL(arm64WorkerUrlRef.current);
    },
    [],
  );

  const sendSerial = useCallback((text: string) => {
    arm64PtyRef.current?.pushInput(text);
    emuRef.current?.serial0_send?.(text);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="mb-8">
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
            Research track · Milestone 1–2 · multi-core
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            In-browser Emulator Lab
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            A full OS booting inside a browser tab on a software-emulated CPU
            (WASM). Two pluggable cores share one device / display / serial /
            input layer: <span className="text-foreground">x86_64 (v86)</span>,
            working today, and{" "}
            <span className="text-foreground">aarch64 (QEMU-Wasm, TCG→WASM JIT)</span>{" "}
            — the ARM64 path toward Android 17.
          </p>
        </header>

        <div className="mb-6 rounded-lg border border-border bg-card p-4">
          <div className="mb-4 flex flex-wrap gap-2">
            {(["x86_64", "aarch64"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setArch(a)}
                className={`rounded-md border px-3 py-1.5 text-xs font-mono transition-colors ${
                  arch === a
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-accent"
                }`}
              >
                {a}
                {a === "x86_64" ? " ✓" : " ⚙"}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {arch === "x86_64" ? (
              <>
                <div className="flex-1 min-w-[260px]">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    OS image URL (must be CORS-enabled)
                  </label>
                  <input
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    placeholder="https://…/linux.iso"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Attach as
                  </label>
                  <select
                    value={imageKind}
                    onChange={(e) =>
                      setImageKind(e.target.value as "cdrom" | "hda")
                    }
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="cdrom">CD-ROM (.iso)</option>
                    <option value="hda">Hard disk (.img)</option>
                  </select>
                </div>
              </>
            ) : (
              <div className="flex w-full flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {(["raspi3ap", "virt"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setArmProfile(p)}
                      className={`rounded-md border px-3 py-1.5 text-xs font-mono transition-colors ${
                        armProfile === p
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-background hover:bg-accent"
                      }`}
                    >
                      {p === "raspi3ap" ? "raspi3ap · Alpine ✓" : "virt · Android 17 ⚙"}
                    </button>
                  ))}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    QEMU-Wasm artifact base URL (CORS-enabled; out.js + .wasm)
                  </label>
                  <input
                    value={qemuBase}
                    onChange={(e) => setQemuBase(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    placeholder="https://your-host/qemu-aarch64/"
                  />
                </div>
                {armProfile === "virt" && (
                  <div className="grid gap-2 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-3">
                    <p className="text-xs text-amber-500">
                      Cuttlefish manifest URL. Images are streamed once from
                      Hugging Face into OPFS, sha256-verified, then mounted
                      into the guest FS on every boot.
                    </p>
                    <input
                      value={androidManifestUrl}
                      onChange={(e) => setAndroidManifestUrl(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
                      placeholder="https://…/manifest.json"
                    />
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={boot}
                disabled={
                  status === "loading" ||
                  status === "running" ||
                  (arch === "aarch64" && !qemuBase.trim())
                }
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {status === "loading" ? "Booting…" : "Boot"}
              </button>
              <button
                onClick={stop}
                disabled={status === "idle"}
                className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                Stop
              </button>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs font-mono text-muted-foreground">
            <span>
              status:{" "}
              <span
                className={
                  status === "running"
                    ? "text-green-500"
                    : status === "error"
                      ? "text-red-500"
                      : ""
                }
              >
                {status}
              </span>
            </span>
            <span>screen writes: {stats.frames}</span>
          </div>
          {error && (
            <p className="mt-2 text-xs text-red-500 font-mono">{error}</p>
          )}
        </div>

        {arch === "aarch64" && (
          <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-5">
            <h2 className="text-sm font-semibold text-amber-500">
              ARM64 core — build the QEMU-Wasm artifact first
            </h2>
            <p className="mt-2 text-xs text-muted-foreground">
              The aarch64 core uses{" "}
              <span className="font-mono">qemu-wasm</span> (QEMU with a TCG→WASM
              JIT backend). Its binary is a multi-hour emscripten build, so it
              can&apos;t be compiled in this chat — build it once in CI, host the
              output (CORS-enabled), and paste the base URL above. It already
              boots aarch64 Linux in a browser today:
            </p>
            <a
              href="https://ktock.github.io/qemu-wasm-demo/raspi3ap.html"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs font-medium text-primary underline"
            >
              ▸ Live proof: AArch64 Raspberry Pi booting in-browser (QEMU-Wasm)
            </a>
            <pre className="mt-3 overflow-x-auto rounded-md bg-black p-3 text-[11px] leading-relaxed text-green-400">
{`# Build QEMU-Wasm (aarch64) — run in CI / a Linux box with Docker
git clone https://github.com/ktock/qemu-wasm
cd qemu-wasm
# builds emscripten glue (out.js) + qemu wasm with the Wasm TCG JIT backend
docker build --output=./out -f Dockerfile .
# host ./out (out.js, *.wasm, kernel + rootfs) behind a CORS-enabled URL,
# then paste that base URL into the field above and press Boot.`}
            </pre>
            <p className="mt-3 text-xs text-muted-foreground">
              Cross-origin isolation note: QEMU-Wasm uses threads
              (SharedArrayBuffer), so the host must send{" "}
              <span className="font-mono">
                COOP: same-origin
              </span>{" "}
              +{" "}
              <span className="font-mono">COEP: require-corp</span> headers.
            </p>
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-black p-2">
            <p className="mb-2 px-1 text-xs font-mono text-muted-foreground">
              VGA display (virtio-gpu → canvas)
            </p>
            {/* v86 injects a <canvas> and a text screen here */}
            <div
              ref={screenRef}
              className="min-h-[320px] overflow-hidden text-[#0f0]"
              style={{ fontFamily: "monospace", whiteSpace: "pre" }}
            >
              <div />
              <canvas />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-2">
            <p className="mb-2 px-1 text-xs font-mono text-muted-foreground">
              Serial console (ttyS0)
            </p>
            <textarea
              ref={serialRef}
              readOnly
              value={serial}
              className="h-[320px] w-full resize-none rounded-md bg-black p-2 text-xs font-mono text-green-400"
            />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = (
                  e.currentTarget.elements.namedItem(
                    "cmd",
                  ) as HTMLInputElement
                ).value;
                sendSerial(input + "\n");
                (e.currentTarget as HTMLFormElement).reset();
              }}
              className="mt-2 flex gap-2"
            >
              <input
                name="cmd"
                placeholder="type a command, Enter to send…"
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              />
              <button className="rounded-md bg-secondary px-3 py-2 text-xs font-medium">
                Send
              </button>
            </form>
          </div>
        </div>

        <section className="mt-10 rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Roadmap to Android 17</h2>
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>
              <span className="font-mono text-foreground">1 ▸</span> Software CPU
              boots an OS in-tab — <span className="text-green-500">this page</span>.
            </li>
            <li>
              <span className="font-mono text-foreground">2 ▸</span> Swap x86
              core for an ARM64 QEMU-WASM (TCG→WASM JIT) backend.
            </li>
            <li>
              <span className="font-mono text-foreground">3 ▸</span> virtio
              device layer: blk→OPFS, net→proxy, input→events, gpu→WebGPU.
            </li>
            <li>
              <span className="font-mono text-foreground">4 ▸</span> Boot
              Cuttlefish <span className="font-mono">aosp_cf_arm64</span> Android
              17 system image.
            </li>
            <li>
              <span className="font-mono text-foreground">5 ▸</span> Optimize:
              persistent block cache, WASM threads / SMP, WebGPU passthrough.
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}

function EmulatorPage() {
  return (
    <ClientOnly
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
          Loading emulator…
        </div>
      }
    >
      <EmulatorInner />
    </ClientOnly>
  );
}
