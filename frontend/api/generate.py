import os
import sys
import json
from http.server import BaseHTTPRequestHandler

# Add tools directory to sys.path based on file location
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.abspath(os.path.join(current_dir, "..", ".."))
sys.path.insert(0, os.path.join(root_dir, "tools"))

from test_planner_engine import TestPlannerEngine

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        payload = json.loads(post_data)

        # In Vercel, we must use /tmp for any file writes
        payload_path = "/tmp/job_payload.json"
        with open(payload_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)

        try:
            engine = TestPlannerEngine(payload_path)
            # Adjust engine to use /tmp (already done in earlier step)
            final_doc_path = engine.run_pipeline()

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            response = {
                "status": "success",
                "message": "Test generated deterministically.",
                "document_path": final_doc_path
            }
            self.wfile.write(json.dumps(response).encode('utf-8'))

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"detail": str(e)}).encode('utf-8'))
