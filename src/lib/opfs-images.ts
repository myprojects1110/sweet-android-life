// Streaming download + OPFS cache for Cuttlefish images.
//
// A "manifest.json" (hosted alongside the images) drives the fetch:
//   {
//     "build_id": "15660610",
//     "files": [{ "name": "boot.img", "size": 67108864, "sha256": "..." }, ...]
//   }
//
// For each file we look up an OPFS-cached copy. If it's missing / wrong size
// / wrong sha256 we (re)download it in ~4 MiB chunks, verifying sha256 as we
// go. Files live under OPFS at   /cuttlefish/<build_id>/<name>   so a new
// build id automatically invalidates the old cache.

export type ManifestFile = {
  name: string;
  size: number;
  sha256: string;
};

export type Manifest = {
  build_id: string;
  branch?: string;
  target?: string;
  generated_at?: number;
  files: ManifestFile[];
};

export type Progress = {
  file: string;
  received: number;
  total: number;
  phase: "check" | "download" | "verify" | "ready" | "cached";
};

const CHUNK = 4 * 1024 * 1024;

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const nav = navigator as unknown as {
    storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  };
  if (!nav.storage?.getDirectory) {
    throw new Error("OPFS unavailable (navigator.storage.getDirectory missing).");
  }
  return nav.storage.getDirectory();
}

async function getDir(
  path: string[],
  create = true,
): Promise<FileSystemDirectoryHandle> {
  let dir = await opfsRoot();
  for (const seg of path) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256Of(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  // Feed the whole file into SubtleCrypto via a stream to avoid a big ArrayBuffer.
  // SubtleCrypto has no streaming API, so we chunk and accumulate via digest of
  // a concatenated buffer — for our largest file (~1.7 GiB) this fits in
  // typical desktop RAM. If it becomes a problem we can switch to a JS sha256.
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(digest);
}

async function fileMatches(
  handle: FileSystemFileHandle,
  expected: ManifestFile,
): Promise<boolean> {
  const file = await handle.getFile();
  if (file.size !== expected.size) return false;
  try {
    const got = await sha256Of(handle);
    return got.toLowerCase() === expected.sha256.toLowerCase();
  } catch {
    return false;
  }
}

async function streamDownload(
  url: string,
  handle: FileSystemFileHandle,
  expected: ManifestFile,
  onProgress: (p: Progress) => void,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok || !res.body) {
      throw new Error(`Fetch ${url} failed (${res.status})`);
    }
    const reader = res.body.getReader();
    let received = 0;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (!pendingBytes) return;
      const merged = new Uint8Array(pendingBytes);
      let off = 0;
      for (const c of pending) {
        merged.set(c, off);
        off += c.length;
      }
      pending = [];
      pendingBytes = 0;
      await writable.write(merged);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.length;
      received += value.length;
      if (pendingBytes >= CHUNK) await flush();
      onProgress({
        file: expected.name,
        received,
        total: expected.size,
        phase: "download",
      });
    }
    await flush();
    await writable.close();
  } catch (e) {
    try {
      await writable.abort();
    } catch {
      /* ignore */
    }
    throw e;
  }
  onProgress({
    file: expected.name,
    received: expected.size,
    total: expected.size,
    phase: "verify",
  });
  const ok = await fileMatches(handle, expected);
  if (!ok) {
    throw new Error(`sha256 mismatch after download for ${expected.name}`);
  }
}

export async function fetchManifest(manifestUrl: string): Promise<Manifest> {
  const res = await fetch(manifestUrl, { mode: "cors", cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`manifest fetch failed (${res.status}) for ${manifestUrl}`);
  }
  return (await res.json()) as Manifest;
}

export type CachedImage = {
  file: ManifestFile;
  handle: FileSystemFileHandle;
};

// Ensure every file in the manifest is present + verified in OPFS at
//   /cuttlefish/<build_id>/<name>
// The `baseUrl` is the directory the image files live at (typically the
// manifest URL with the trailing "manifest.json" stripped).
export async function ensureImages(
  manifest: Manifest,
  baseUrl: string,
  onProgress: (p: Progress) => void,
): Promise<CachedImage[]> {
  const dir = await getDir(["cuttlefish", manifest.build_id]);
  const out: CachedImage[] = [];
  const base = baseUrl.replace(/\/?$/, "/");
  for (const f of manifest.files) {
    onProgress({ file: f.name, received: 0, total: f.size, phase: "check" });
    let handle: FileSystemFileHandle;
    try {
      handle = await dir.getFileHandle(f.name, { create: false });
      if (await fileMatches(handle, f)) {
        onProgress({
          file: f.name,
          received: f.size,
          total: f.size,
          phase: "cached",
        });
        out.push({ file: f, handle });
        continue;
      }
    } catch {
      /* not present — fall through to download */
    }
    handle = await dir.getFileHandle(f.name, { create: true });
    await streamDownload(base + f.name, handle, f, onProgress);
    onProgress({ file: f.name, received: f.size, total: f.size, phase: "ready" });
    out.push({ file: f, handle });
  }
  return out;
}

// Read an OPFS-cached image into a Uint8Array suitable for
// Emscripten FS.writeFile / FS.createDataFile. This buffers the whole file
// in JS heap — fine for kernel/initramfs/vbmeta; risky for multi-GB super.img.
export async function readCached(image: CachedImage): Promise<Uint8Array> {
  const f = await image.handle.getFile();
  return new Uint8Array(await f.arrayBuffer());
}
