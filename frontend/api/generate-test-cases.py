import os
import sys
import json
from http.server import BaseHTTPRequestHandler

# Add tools directory to sys.path based on file location
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.abspath(os.path.join(current_dir, "..", ".."))
sys.path.insert(0, os.path.join(root_dir, "tools"))

from test_cases_engine import TestCasesEngine

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        payload = json.loads(post_data)

        payload_path = "/tmp/tc_payload.json"
        with open(payload_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)

        try:
            engine = TestCasesEngine(payload_path)
            final_doc_path, test_cases_data = engine.run_pipeline()

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            response = {
                "status": "success",
                "message": "Test cases generated.",
                "document_path": final_doc_path,
                "test_cases": test_cases_data
            }
            self.wfile.write(json.dumps(response).encode('utf-8'))

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"detail": str(e)}).encode('utf-8'))
