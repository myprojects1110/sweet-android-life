import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import linuxImage from "../assets/linux.iso.asset.json";
import seabios from "../assets/seabios.bin.asset.json";
import vgabios from "../assets/vgabios.bin.asset.json";

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
const BIOS = seabios.url;
const VGA_BIOS = vgabios.url;
// Small bootable Linux ISO, served same-origin from Lovable's CDN (no CORS issues).
const DEFAULT_IMAGE = linuxImage.url;

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

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function EmulatorInner() {
  const screenRef = useRef<HTMLDivElement>(null);
  const serialRef = useRef<HTMLTextAreaElement>(null);
  const emuRef = useRef<V86Instance | null>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "running" | "error"
  >("idle");
  const [arch, setArch] = useState<"x86_64" | "aarch64">("x86_64");
  const [imageUrl, setImageUrl] = useState(DEFAULT_IMAGE);
  const [imageKind, setImageKind] = useState<"cdrom" | "hda">("cdrom");
  // ARM64 (QEMU-Wasm) artifact base URL, e.g. https://your-host/qemu-aarch64/
  // Must contain the emscripten glue (out.js) + .wasm produced by a
  // qemu-wasm (TCG→WASM JIT) build. Left blank until an artifact is hosted.
  const [qemuBase, setQemuBase] = useState("");
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
        appendSerial(
          `[harness] loading ARM64 QEMU-Wasm core from ${base}out.js …\n`,
        );
        w.Module = {
          canvas: screenRef.current?.querySelector("canvas") ?? undefined,
          print: (line: string) => appendSerial(line + "\n"),
          printErr: (line: string) => appendSerial(line + "\n"),
          locateFile: (p: string) => base + p,
          onRuntimeInitialized: () => setStatus("running"),
        };
        await loadScript(base + "out.js");
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
  }, [arch, qemuBase, imageUrl, imageKind, appendSerial]);

  const stop = useCallback(() => {
    emuRef.current?.destroy?.();
    emuRef.current = null;
    setStatus("idle");
  }, []);

  useEffect(() => () => emuRef.current?.destroy?.(), []);

  const sendSerial = useCallback((text: string) => {
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
              <div className="flex-1 min-w-[260px]">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  QEMU-Wasm artifact base URL (CORS-enabled; contains out.js +
                  .wasm)
                </label>
                <input
                  value={qemuBase}
                  onChange={(e) => setQemuBase(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  placeholder="https://your-host/qemu-aarch64/"
                />
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
