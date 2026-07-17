// Main-thread bridge to /opfs-block-worker.js. Owns the SharedArrayBuffer,
// spawns the worker, and exposes a client-side handle that can perform
// synchronous open/read/size/close from ANY thread that shares the SAB.
//
// The client half is a plain object of methods — it does not touch the
// worker directly, only the SAB — so it can be transferred into an
// Emscripten FS callback that runs on a pthread worker and still block
// synchronously via Atomics.wait.

export type OpfsBlockClient = {
  open: (opfsPath: string) => number; // returns handle id, throws on error
  read: (handleId: number, offset: number, into: Uint8Array) => number;
  size: (handleId: number) => number;
  close: (handleId: number) => void;
  sab: SharedArrayBuffer;
};

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
// 16 MiB SAB — payload cap is (16 MiB - 2 KiB). Emscripten reads are
// usually 4 KiB–64 KiB so cap isn't the bottleneck.
const SAB_BYTES = 16 * 1024 * 1024;

function makeClient(sab: SharedArrayBuffer): OpfsBlockClient {
  const ctl = new Int32Array(sab, 0, 8);
  const payload = new Uint8Array(sab, PAYLOAD_BYTE_OFFSET);

  function submit(op: number) {
    Atomics.store(ctl, OP, op);
    Atomics.store(ctl, STATE, S_REQ);
    Atomics.notify(ctl, STATE);
    // Block until worker flips STATE to DONE or ERR.
    // Passing S_REQ means "wait while state == S_REQ".
    Atomics.wait(ctl, STATE, S_REQ);
    const st = Atomics.load(ctl, STATE);
    // Reset for next request.
    Atomics.store(ctl, STATE, S_IDLE);
    if (st === S_ERR) {
      const err = Atomics.load(ctl, ERRNO);
      throw new Error(`opfs-block op ${op} failed (errno ${err})`);
    }
  }

  return {
    sab,
    open(opfsPath) {
      const bytes = new TextEncoder().encode(opfsPath);
      if (bytes.length > payload.byteLength) throw new Error("path too long");
      payload.set(bytes, 0);
      Atomics.store(ctl, LEN, bytes.length);
      submit(OP_OPEN);
      return Atomics.load(ctl, HANDLE);
    },
    read(handleId, offset, into) {
      let total = 0;
      const cap = payload.byteLength;
      while (total < into.length) {
        const want = Math.min(into.length - total, cap);
        Atomics.store(ctl, HANDLE, handleId);
        Atomics.store(ctl, OFF_LO, (offset + total) >>> 0);
        Atomics.store(ctl, OFF_HI, Math.floor((offset + total) / 0x100000000) >>> 0);
        Atomics.store(ctl, LEN, want);
        submit(OP_READ);
        const got = Atomics.load(ctl, LEN);
        if (got <= 0) break;
        into.set(payload.subarray(0, got), total);
        total += got;
        if (got < want) break; // short read = EOF
      }
      return total;
    },
    size(handleId) {
      Atomics.store(ctl, HANDLE, handleId);
      submit(OP_SIZE);
      return (
        (Atomics.load(ctl, OFF_LO) >>> 0) +
        (Atomics.load(ctl, OFF_HI) >>> 0) * 0x100000000
      );
    },
    close(handleId) {
      Atomics.store(ctl, HANDLE, handleId);
      submit(OP_CLOSE);
    },
  };
}

let cachedClient: OpfsBlockClient | null = null;

export async function getOpfsBlockClient(): Promise<OpfsBlockClient> {
  if (cachedClient) return cachedClient;
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error("SharedArrayBuffer unavailable — need cross-origin isolation.");
  }
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const worker = new Worker("/opfs-block-worker.js");
  await new Promise<void>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", onMsg);
        resolve();
      }
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", (e) => reject(e.error ?? e));
    worker.postMessage({ type: "init", sab });
  });
  cachedClient = makeClient(sab);
  return cachedClient;
}
