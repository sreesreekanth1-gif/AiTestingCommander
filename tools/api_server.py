from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os
import sys
import base64
from urllib.parse import urlparse

# Ensure tools directory is prioritized for imports
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from test_planner_engine import TestPlannerEngine
from test_cases_engine import TestCasesEngine
from test_scenarios_engine import TestScenariosEngine

app = FastAPI(title="AntiGravity Agent API", version="1.0.0")

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AgentPayload(BaseModel):
    selectedTool: str
    baseUrl: str
    username: str
    token: str
    llmProvider: str
    llmEndpoint: str
    llmModel: str
    llmApiKey: str
    issueId: str
    manualRequirements: str = ""

class TestCasePayload(BaseModel):
    selectedTool: str
    baseUrl: str
    username: str
    token: str
    llmProvider: str
    llmEndpoint: str
    llmModel: str
    llmApiKey: str
    issueId: str
    manualRequirements: str = ""
    customInstructions: str = ""
    sharedPrerequisites: str = ""
    businessRules: str = ""
    widgetsSections: str = ""
    additionalContext: str = ""
    tcDepth: str = "Standard"
    tcMaxCount: str = ""
    tcFocusAreas: str = ""

class ScenarioPayload(BaseModel):
    selectedTool: str
    baseUrl: str
    username: str
    token: str
    llmProvider: str
    llmEndpoint: str
    llmModel: str
    llmApiKey: str
    issueId: str
    manualRequirements: str = ""
    additionalContext: str = ""

class VerifyPayload(BaseModel):
    type: str
    # ALM fields
    toolType: str = ""        # Jira | ADO | X-Ray | TestRail | QTest
    selectedTool: str = ""   # kept for backwards compat
    baseUrl: str = ""
    username: str = ""
    token: str = ""
    # LLM fields
    llmProvider: str = ""
    llmEndpoint: str = ""
    llmModel: str = ""
    llmApiKey: str = ""

    @property
    def resolved_tool(self) -> str:
        return self.toolType or self.selectedTool


class UploadPayload(BaseModel):
    selectedTool: str
    baseUrl: str
    username: str
    token: str
    testCases: list
    # Tool-specific context fields (optional, filled by frontend)
    projectKey: str = ""
    projectName: str = ""
    testPlanId: str = ""
    testSuiteId: str = ""
    projectId: str = ""
    suiteId: str = ""
    sectionId: str = ""
    moduleId: str = ""
    issueId: str = ""


class UpdatePayload(BaseModel):
    test_cases: list
    issueId: str
    selectedTool: str


def _resolve_generated_artifact(path: str) -> str:
    if not path:
        raise HTTPException(status_code=400, detail="Missing artifact path")

    tmp_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".tmp"))
    candidate = os.path.abspath(path)

    if os.path.commonpath([tmp_root, candidate]) != tmp_root:
        raise HTTPException(status_code=403, detail="Artifact path is outside the allowed output folder")
    if not os.path.exists(candidate):
        raise HTTPException(status_code=404, detail="Generated artifact not found")

    return candidate


def _validate_ollama_endpoint(endpoint: str):
    import requests

    normalized = endpoint.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid Ollama endpoint URL")

    candidate_urls = [
        f"{normalized}/api/tags",
        f"{normalized}/api/version",
        normalized,
    ]

    last_error = None
    for candidate in candidate_urls:
        try:
            response = requests.get(candidate, timeout=4)
            if response.ok:
                return
            last_error = f"{candidate} returned HTTP {response.status_code}"
        except requests.exceptions.RequestException as exc:
            last_error = str(exc)

    raise HTTPException(
        status_code=404,
        detail=f"Ollama server is unreachable or not responding correctly at {normalized}. Last check: {last_error}",
    )


def _build_alm_request(payload: VerifyPayload):
    tool = payload.resolved_tool
    normalized = payload.baseUrl.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid Base URL format")

    headers = {"Accept": "application/json"}
    auth = None
    api_url = normalized

    if tool == "Jira":
        api_url = f"{normalized}/rest/api/3/myself"
        auth = (payload.username, payload.token)
    elif tool == "ADO":
        api_url = f"{normalized}/_apis/projects?api-version=7.1"
        token_bytes = f":{payload.token}".encode("utf-8")
        headers["Authorization"] = f"Basic {base64.b64encode(token_bytes).decode('ascii')}"
    elif tool == "X-Ray":
        # X-Ray Cloud uses JWT auth — we verify the auth endpoint responds
        api_url = f"{normalized}/authenticate"
        headers["Content-Type"] = "application/json"
        # X-Ray auth is a POST; flag it so the caller uses POST
        return api_url, headers, "XRAY_AUTH"
    elif tool == "TestRail":
        api_url = f"{normalized}/index.php?/api/v2/get_case_fields"
        auth = (payload.username, payload.token)
    elif tool == "QTest":
        api_url = f"{normalized}/api/v3/projects"
        headers["Authorization"] = f"Bearer {payload.token}"
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported platform: {tool}")

    return api_url, headers, auth

@app.get("/health")
def health_check():
    return {"status": "alive", "phase": "Link established"}


@app.get("/artifact")
def download_artifact(path: str):
    artifact_path = _resolve_generated_artifact(path)
    return FileResponse(artifact_path, filename=os.path.basename(artifact_path))

@app.post("/verify")
def verify_connection(payload: VerifyPayload):
    import requests

    # ── ALM Verification ──────────────────────────────────────
    if payload.type == "ALM":
        tool = payload.resolved_tool
        if not payload.baseUrl:
            raise HTTPException(status_code=400, detail="Missing Base URL")
        # X-Ray and QTest don't require username
        if tool in {"Jira", "TestRail", "ADO"} and not payload.username:
            raise HTTPException(status_code=400, detail="Missing username / email")
        if not payload.token:
            raise HTTPException(status_code=400, detail="Missing API Token / PAT")

        api_url, headers, auth = _build_alm_request(payload)

        try:
            # X-Ray uses POST for auth
            if auth == "XRAY_AUTH":
                res = requests.post(
                    api_url,
                    json={"client_id": payload.username, "client_secret": payload.token},
                    headers=headers,
                    timeout=8,
                )
            else:
                res = requests.get(
                    api_url, auth=auth, headers=headers,
                    timeout=8, allow_redirects=False,
                )

            if res.status_code in [401, 403]:
                raise HTTPException(status_code=401, detail="Invalid credentials — check username/token.")
            if res.status_code in [301, 302, 303, 307, 308]:
                raise HTTPException(status_code=400, detail="Platform redirected the request. Verify the Base URL.")
            if res.status_code == 404:
                raise HTTPException(status_code=404, detail=f"API endpoint not found at {api_url}")
            if "text/html" in res.headers.get("content-type", ""):
                raise HTTPException(status_code=401, detail="Authentication rejected (received login page).")
            if not 200 <= res.status_code < 300:
                message = res.text.strip()[:180]
                raise HTTPException(status_code=400, detail=f"Platform validation failed: {message or f'HTTP {res.status_code}'}")  
        except requests.exceptions.RequestException as exc:
            raise HTTPException(status_code=404, detail=f"Unreachable platform URL: {exc}")

        return {"status": "success", "message": f"{tool} connection validated successfully."}

    # ── LLM / AI Verification ─────────────────────────────────
    elif payload.type == "AI":
        provider = payload.llmProvider

        if provider == "Ollama":
            if not payload.llmEndpoint:
                raise HTTPException(status_code=400, detail="Missing Ollama endpoint URL")
            _validate_ollama_endpoint(payload.llmEndpoint)
            return {"status": "success", "message": "Ollama connection validated."}

        # All cloud providers require an API key
        if not payload.llmApiKey or len(payload.llmApiKey) < 8:
            raise HTTPException(status_code=401, detail="Invalid or missing API Key.")

        try:
            if provider == "GROQ":
                res = requests.get(
                    "https://api.groq.com/openai/v1/models",
                    headers={"Authorization": f"Bearer {payload.llmApiKey}"},
                    timeout=8,
                )
            elif provider == "Grok":
                res = requests.get(
                    "https://api.x.ai/v1/models",
                    headers={"Authorization": f"Bearer {payload.llmApiKey}"},
                    timeout=8,
                )
            elif provider in {"Claude", "Anthropic"}:
                res = requests.get(
                    "https://api.anthropic.com/v1/models",
                    headers={
                        "x-api-key": payload.llmApiKey,
                        "anthropic-version": "2023-06-01",
                    },
                    timeout=8,
                )
            elif provider == "OpenRouter":
                res = requests.get(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Authorization": f"Bearer {payload.llmApiKey}"},
                    timeout=8,
                )
            else:
                raise HTTPException(status_code=400, detail=f"Unknown LLM provider: {provider}")

            if res.status_code == 401:
                raise HTTPException(status_code=401, detail=f"{provider} API Key rejected — unauthorized.")
            if not res.ok:
                raise HTTPException(status_code=400, detail=f"{provider} returned HTTP {res.status_code}.")

            # --- Model Validation ---
            requested = (payload.llmModel or "").strip().lower()
            if requested:
                data = res.json()
                # Unified "id" extraction for standard AI APIs
                available = [m.get("id", "") for m in data.get("data", [])]
                available = [m for m in available if m] # filter empty
                
                normalized_available = [m.lower() for m in available]
                
                if requested not in normalized_available:
                    # Find similar models
                    similar = [m for m in available if requested in m.lower()]
                    suggestion_header = f"Top suggestions" if similar else "Available samples"
                    list_to_show = similar[:15] if similar else available[:15]
                    
                    suggestion_str = ", ".join(list_to_show)
                    msg = (
                        f"Model '{payload.llmModel}' not found for {provider}. "
                        f"{suggestion_header}: {suggestion_str} (Total: {len(available)})"
                    )
                    raise HTTPException(status_code=400, detail=msg)

        except requests.exceptions.RequestException as exc:
            raise HTTPException(status_code=404, detail=f"Cannot reach {provider} API: {exc}")

        return {"status": "success", "message": f"{provider} connection validated successfully."}

    raise HTTPException(status_code=400, detail="Unknown verification type. Use 'ALM' or 'AI'.")

@app.post("/generate")
def trigger_generation(payload: AgentPayload):
    print(f"Received JSON block: {payload.dict()}")
    # Determine tmp path for payload
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", ".tmp"), exist_ok=True)
    payload_path = os.path.join(os.path.dirname(__file__), "..", ".tmp", "job_payload.json")
    
    with open(payload_path, "w") as f:
        f.write(payload.json())
        
    try:
        engine = TestPlannerEngine(payload_path)
        final_doc_path = engine.run_pipeline()
        return {"status": "success", "message": "Test generated deterministically.", "document_path": final_doc_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate-test-cases")
def generate_test_cases(payload: TestCasePayload):
    print(f"Received test case generation request: {payload.dict()}")
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", ".tmp"), exist_ok=True)
    payload_path = os.path.join(os.path.dirname(__file__), "..", ".tmp", "tc_payload.json")

    with open(payload_path, "w") as f:
        f.write(payload.json())

    try:
        engine = TestCasesEngine(payload_path)
        final_doc_path, test_cases_data = engine.run_pipeline()
        return {
            "status": "success",
            "message": "Test cases generated in Excel format.",
            "document_path": final_doc_path,
            "test_cases": test_cases_data,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze-gaps")
def analyze_gaps(payload: AgentPayload):
    print(f"Received gap analysis request: {payload.dict()}")
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", ".tmp"), exist_ok=True)
    payload_path = os.path.join(os.path.dirname(__file__), "..", ".tmp", "job_payload.json")

    with open(payload_path, "w") as f:
        f.write(payload.json())

    try:
        engine = TestPlannerEngine(payload_path)
        analysis = engine.run_gap_analysis()
        return {"status": "success", "analysis": analysis}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/generate-scenarios")
def generate_scenarios(payload: ScenarioPayload):
    print(f"Received scenario generation request: {payload.dict()}")
    try:
        engine = TestScenariosEngine(payload.dict())
        scenarios_data = engine.run_pipeline()
        return {
            "status": "success",
            "message": "Test scenarios generated successfully.",
            "scenarios": scenarios_data.get("scenarios", []),
            "testPlanTitle": scenarios_data.get("testPlanTitle", "High-Level Scenarios")
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/fetch-ticket")
def fetch_ticket(payload: AgentPayload):
    print(f"Fetching ticket context for {payload.issueId}")
    try:
        from issue_fetcher import fetch_issue
        context = fetch_issue(payload.dict())

        # Parse text response into structured format
        details = {}
        for line in context.split('\n'):
            if ':' in line:
                key, value = line.split(':', 1)
                details[key.strip()] = value.strip()

        return {"status": "success", "details": details}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/update-test-cases")
def update_test_cases(payload: UpdatePayload):
    print(f"Update request for {payload.issueId}: {len(payload.test_cases)} test cases")
    try:
        # We initialized with None as we've already got data
        engine = TestCasesEngine(None) 
        engine.config = {"issueId": payload.issueId, "selectedTool": payload.selectedTool}
        
        final_doc_path = engine.generate_xlsx_file({"testCases": payload.test_cases})
        return {
            "status": "success", 
            "message": "Test cases artifact updated.", 
            "document_path": final_doc_path
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/upload-to-alm")
def upload_to_alm(payload: UploadPayload):
    print(f"Upload request: {payload.selectedTool} for {len(payload.testCases)} test cases")
    try:
        from alm_uploader import get_uploader
        config = payload.dict()

        # Auto-derive projectKey from issueId if not provided
        if not config.get("projectKey") and config.get("issueId"):
            config["projectKey"] = config["issueId"].split("-")[0]

        uploader = get_uploader(config)
        results = uploader.upload_all(payload.testCases, config)

        uploaded = sum(1 for r in results if r.get("status") == "uploaded")
        skipped  = sum(1 for r in results if r.get("status") == "skipped")
        failed   = sum(1 for r in results if r.get("status") == "failed")

        message = f"Upload complete: {uploaded} uploaded, {skipped} skipped (duplicate), {failed} failed."
        return {
            "status": "success",
            "message": message,
            "results": results
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    # Running local API backend on port 8000
    uvicorn.run(app, host="127.0.0.1", port=8000)
