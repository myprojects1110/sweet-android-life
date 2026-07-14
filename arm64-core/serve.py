#!/usr/bin/env python3
"""Serve ./out with cross-origin isolation headers for local QEMU-Wasm testing.

QEMU-Wasm needs SharedArrayBuffer, which requires COOP/COEP. Run:

    python3 serve.py            # serves ./out on http://localhost:8000
    python3 serve.py 9000 out   # custom port / dir

Then point the Emulator Lab (aarch64 core) at http://localhost:8000/.
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "out"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


if __name__ == "__main__":
    if not os.path.isdir(DIRECTORY):
        sys.exit(f"Directory '{DIRECTORY}' not found — build the artifact first.")
    print(f"Serving ./{DIRECTORY} on http://localhost:{PORT} (COOP/COEP on)")
    http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
