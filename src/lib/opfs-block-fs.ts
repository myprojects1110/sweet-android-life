// Emscripten custom filesystem that pipes read()/llseek() for a set of
// mounted files through the OPFS block bridge. Files are mounted read-only;
// QEMU only needs to read super.img/vbmeta/etc. and userdata/misc stay
// read-only for a first cut (Cuttlefish will complain about read-only
// userdata but won't crash on it — write support comes next).
//
// Register with:
//   FS.mkdirTree("/blk");
//   FS.mount(makeOpfsBlockFS(client), { entries: [{ name: "super.img", opfsPath: "cuttlefish/15660610/super.img" }] }, "/blk");
//
// Then QEMU can `-drive file=/blk/super.img,format=raw` without ever
// loading the 1.7 GiB file into wasm memory.

import type { OpfsBlockClient } from "./opfs-block-bridge";

type MountEntry = { name: string; opfsPath: string };
type MountOpts = { entries: MountEntry[] };

// Emscripten FS types are dynamic; we describe the surface we use.
type FSNode = {
  id?: number;
  mode: number;
  timestamp: number;
  parent: FSNode;
  mount: { opts: MountOpts };
  node_ops: unknown;
  stream_ops: unknown;
  name?: string;
  contents?: {
    handleId: number;
    size: number;
    opfsPath: string;
  };
};

type FS = {
  createNode: (
    parent: FSNode,
    name: string,
    mode: number,
    dev?: number,
  ) => FSNode;
  isDir: (mode: number) => boolean;
  isFile: (mode: number) => boolean;
  ErrnoError: new (errno: number) => Error;
};

export function makeOpfsBlockFS(client: OpfsBlockClient) {
  // Kept for reference — Linux mode bits.
  const S_IFDIR = 0o040000;
  const S_IFREG = 0o100000;

  const openedByPath = new Map<string, { handleId: number; size: number }>();

  function ensureOpen(opfsPath: string) {
    let cached = openedByPath.get(opfsPath);
    if (cached) return cached;
    const handleId = client.open(opfsPath);
    const size = client.size(handleId);
    cached = { handleId, size };
    openedByPath.set(opfsPath, cached);
    return cached;
  }

  return {
    mount(mount: { opts: MountOpts; FS?: FS }) {
      // Emscripten passes the FS module on Module.FS; we grab it from the
      // globally-registered Module through `this` at mount-time via the
      // parent node lookup. Simpler: capture FS from a helper installed on
      // the module (done in emulator.tsx when we call FS.mount).
      const FS = mountFsRef;
      if (!FS) throw new Error("opfs-block-fs: FS ref not installed");
      const root = FS.createNode(null as unknown as FSNode, "/", S_IFDIR | 0o777, 0);
      const nodeOps = {
        getattr(node: FSNode) {
          const size = node.contents?.size ?? 0;
          const isDir = FS.isDir(node.mode);
          return {
            dev: 1,
            ino: node.id ?? 0,
            mode: node.mode,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: isDir ? 4096 : size,
            atime: new Date(node.timestamp),
            mtime: new Date(node.timestamp),
            ctime: new Date(node.timestamp),
            blksize: 4096,
            blocks: Math.ceil(size / 4096),
          };
        },
        setattr() { /* read-only */ },
        lookup() { throw new FS.ErrnoError(44 /* ENOENT */); },
        readdir(node: FSNode) {
          const names = [".", ".."];
          for (const e of node.mount.opts.entries) names.push(e.name);
          return names;
        },
      };
      const streamOps = {
        read(stream: { node: FSNode }, buffer: Uint8Array, offset: number, length: number, position: number) {
          const c = stream.node.contents!;
          const view = buffer.subarray(offset, offset + length);
          return client.read(c.handleId, position, view);
        },
        write() {
          throw new FS.ErrnoError(63 /* EROFS */);
        },
        llseek(stream: { node: FSNode; position: number }, offset: number, whence: number) {
          let pos = offset;
          if (whence === 1) pos += stream.position;
          else if (whence === 2) pos += stream.node.contents!.size;
          if (pos < 0) throw new FS.ErrnoError(28 /* EINVAL */);
          return pos;
        },
      };
      // Attach node_ops / stream_ops onto every child node we create.
      root.node_ops = nodeOps;
      root.stream_ops = streamOps;
      for (const entry of mount.opts.entries) {
        const opened = ensureOpen(entry.opfsPath);
        const child = FS.createNode(root, entry.name, S_IFREG | 0o444, 0);
        child.contents = {
          handleId: opened.handleId,
          size: opened.size,
          opfsPath: entry.opfsPath,
        };
        child.node_ops = nodeOps;
        child.stream_ops = streamOps;
      }
      return root;
    },
  };
}

// Emscripten's FS.mount doesn't pass the FS module to the filesystem's
// mount() callback. We stash a reference here from the caller before
// invoking FS.mount().
let mountFsRef: FS | null = null;
export function installOpfsBlockFsRef(fs: FS) {
  mountFsRef = fs;
}
