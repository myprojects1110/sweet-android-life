// OPFS block worker — services synchronous read/size requests from any
// thread that shares its SharedArrayBuffer control block.
//
// The caller writes an operation into the SAB header, sets state=REQ,
// notifies, then Atomics.wait()s on state until we flip it to DONE.
// FileSystemSyncAccessHandle is only available inside a DedicatedWorker,
// which is why this file must run as a worker.
//
// SAB layout (Int32Array view, indices):
//   0  state     0=IDLE  1=REQ  2=DONE  3=ERR
//   1  op        1=open  2=read  3=size  4=close
//   2  handleId  in/out
//   3  offsetLo  low 32 bits of file offset (u32)
//   4  offsetHi  high 32 bits (u32)  — pack u53 offsets
//   5  length    bytes requested / returned
//   6  errnoOut  negative errno on failure
//   7  reserved
// Payload region: bytes starting at offset PAYLOAD_OFFSET (Int32 index 512 →
// byte 2048). Used for filename on open, and read data on read.
//
// Handles are keyed by an integer id we return from open().

const STATE = 0;
const OP = 1;
const HANDLE = 2;
const OFF_LO = 3;
const OFF_HI = 4;
const LEN = 5;
const ERRNO = 6;

const OP_OPEN = 1;
const OP_READ = 2;
const OP_SIZE = 3;
const OP_CLOSE = 4;

const S_IDLE = 0;
const S_REQ = 1;
const S_DONE = 2;
const S_ERR = 3;

const PAYLOAD_BYTE_OFFSET = 2048;

/** @type {SharedArrayBuffer|null} */
let sab = null;
/** @type {Int32Array|null} */
let ctl = null;
/** @type {Uint8Array|null} */
let payload = null;

/** @type {Map<number, FileSystemSyncAccessHandle>} */
const handles = new Map();
let nextHandleId = 1;

/** @type {FileSystemDirectoryHandle|null} */
let rootDir = null;

async function resolvePath(path) {
  // path like "cuttlefish/15660610/super.img"
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  let dir = rootDir;
  for (const seg of parts) dir = await dir.getDirectoryHandle(seg);
  return dir.getFileHandle(name);
}

async function handleOpen() {
  const nameLen = Atomics.load(ctl, LEN);
  const nameBytes = payload.subarray(0, nameLen);
  const path = new TextDecoder().decode(nameBytes);
  const fh = await resolvePath(path);
  const sync = await fh.createSyncAccessHandle();
  const id = nextHandleId++;
  handles.set(id, sync);
  Atomics.store(ctl, HANDLE, id);
  Atomics.store(ctl, LEN, sync.getSize()); // convenience
}

function handleRead() {
  const id = Atomics.load(ctl, HANDLE);
  const sync = handles.get(id);
  if (!sync) {
    Atomics.store(ctl, ERRNO, -9); // EBADF
    throw new Error("bad handle");
  }
  const offset =
    (Atomics.load(ctl, OFF_LO) >>> 0) +
    (Atomics.load(ctl, OFF_HI) >>> 0) * 0x100000000;
  const len = Atomics.load(ctl, LEN);
  const cap = payload.byteLength;
  const toRead = Math.min(len, cap);
  const view = new Uint8Array(sab, PAYLOAD_BYTE_OFFSET, toRead);
  const n = sync.read(view, { at: offset });
  Atomics.store(ctl, LEN, n);
}

function handleSize() {
  const id = Atomics.load(ctl, HANDLE);
  const sync = handles.get(id);
  if (!sync) {
    Atomics.store(ctl, ERRNO, -9);
    throw new Error("bad handle");
  }
  const size = sync.getSize();
  Atomics.store(ctl, OFF_LO, size >>> 0);
  Atomics.store(ctl, OFF_HI, Math.floor(size / 0x100000000) >>> 0);
}

function handleClose() {
  const id = Atomics.load(ctl, HANDLE);
  const sync = handles.get(id);
  if (sync) {
    try { sync.close(); } catch { /* ignore */ }
    handles.delete(id);
  }
}

async function serve() {
  for (;;) {
    // Wait for a request. Atomics.wait blocks the worker thread.
    Atomics.wait(ctl, STATE, S_IDLE);
    const op = Atomics.load(ctl, OP);
    Atomics.store(ctl, ERRNO, 0);
    try {
      if (op === OP_OPEN) await handleOpen();
      else if (op === OP_READ) handleRead();
      else if (op === OP_SIZE) handleSize();
      else if (op === OP_CLOSE) handleClose();
      else throw new Error("unknown op " + op);
      Atomics.store(ctl, STATE, S_DONE);
    } catch (e) {
      if (!Atomics.load(ctl, ERRNO)) Atomics.store(ctl, ERRNO, -5); // EIO
      Atomics.store(ctl, STATE, S_ERR);
      // eslint-disable-next-line no-console
      console.error("[opfs-block-worker]", e);
    }
    Atomics.notify(ctl, STATE);
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg && msg.type === "init") {
    sab = msg.sab;
    ctl = new Int32Array(sab, 0, 8);
    payload = new Uint8Array(sab, PAYLOAD_BYTE_OFFSET);
    rootDir = await navigator.storage.getDirectory();
    self.postMessage({ type: "ready" });
    serve();
  }
};
