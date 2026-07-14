import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          Multi-year research track
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
          Android in the browser
        </h1>
        <p className="mt-4 max-w-2xl text-base text-muted-foreground">
          The goal: run an unmodified AOSP (Android 17) image entirely inside a
          browser tab — a software-emulated ARM64 CPU, virtio devices bridged to
          browser APIs, and non-Google APKs running on top. It starts with one
          thing: booting a real OS on a WASM CPU in a tab.
        </p>

        <div className="mt-8">
          <Link
            to="/emulator"
            className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open Milestone 1 — Emulator Lab →
          </Link>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              t: "CPU",
              d: "TCG→WASM JIT translates ARM64 blocks to native via the browser JIT.",
            },
            {
              t: "Devices",
              d: "virtio bridged to WebGPU, OPFS, events and a network proxy.",
            },
            {
              t: "Android",
              d: "Cuttlefish aosp_cf_arm64 boots unmodified on top.",
            },
          ].map((c) => (
            <div
              key={c.t}
              className="rounded-lg border border-border bg-card p-4"
            >
              <p className="text-sm font-semibold">{c.t}</p>
              <p className="mt-1 text-xs text-muted-foreground">{c.d}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
