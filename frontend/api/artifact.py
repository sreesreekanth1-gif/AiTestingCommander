import os
import sys
import mimetypes
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query_params = parse_qs(urlparse(self.path).query)
        artifact_path = query_params.get("path", [""])[0]

        if not artifact_path:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Missing artifact path")
            return

        # Simple security check for artifact locations
        if not (artifact_path.startswith("/tmp") or artifact_path.startswith(".tmp")):
             self.send_response(403)
             self.end_headers()
             self.wfile.write(b"Forbidden path access")
             return

        if not os.path.exists(artifact_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Artifact not found")
            return

        filename = os.path.basename(artifact_path)
        mime_type, _ = mimetypes.guess_type(artifact_path) or ('application/octet-stream', None)

        self.send_response(200)
        self.send_header('Content-type', mime_type)
        self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()

        with open(artifact_path, 'rb') as f:
            self.wfile.write(f.read())
