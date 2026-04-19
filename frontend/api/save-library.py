import os
import sys
import json
from http.server import BaseHTTPRequestHandler
from datetime import datetime

current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.abspath(os.path.join(current_dir, "..", ".."))
sys.path.insert(0, os.path.join(root_dir, "tools"))


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        payload = json.loads(self.rfile.read(content_length))

        try:
            lib_dir = "/tmp"
            lib_path = os.path.join(lib_dir, "library.json")

            entry = payload
            entry["savedAt"] = entry.get("savedAt") or datetime.utcnow().isoformat()

            existing = []
            if os.path.exists(lib_path):
                with open(lib_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)

            existing.append(entry)

            with open(lib_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "success",
                "message": f"Saved to library ({len(existing)} total entries).",
                "total_saved": len(existing)
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "error",
                "detail": str(e)
            }).encode())
