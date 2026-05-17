from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
import asyncio
import hashlib
import json
import os
import re
import sys
import time
import uuid
import base64
from collections import Counter
from typing import Dict, Any, List, Optional
from urllib.parse import urlparse

_CANCEL_TOKENS: Dict[str, asyncio.Event] = {}
_SSE_HEARTBEAT_SECS = 15

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
    coverageInstructions: str = ""

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


class SaveLibraryPayload(BaseModel):
    title: str = ""
    testCases: list
    issueId: str = ""
    savedAt: str = ""


class AnalyzeFrameworkPayload(BaseModel):
    framework_path: str


class TestLLMConnectionPayload(BaseModel):
    llmProvider: str
    llmApiKey: str = ""
    llmModel: str = ""
    llmEndpoint: str = ""


class GenerateTestScriptsPayload(BaseModel):
    framework_path: str
    llmProvider: str
    llmApiKey: str = ""
    llmModel: str = ""
    llmEndpoint: str = ""
    selectedTestCases: list
    refinement_instruction: str = ""
    target_module: str = ""   # if set, only that module group is (re)generated
    target_test_case_id: str = ""  # optional per-test-case regenerate
    request_id: str = ""      # client-supplied id for server-side cancel
    config_context: Optional[Dict[str, Any]] = None  # parsed config/env/dependency info from analyze-framework


class CancelGenerationPayload(BaseModel):
    request_id: str


class FrameworkVersionPayload(BaseModel):
    framework_path: str


class SaveGeneratedScriptPayload(BaseModel):
    framework_path: str
    target_file_path: str
    generated_code: str
    overwrite: bool = False
    changed_files: list = []
    force_save: bool = False
    warnings: list = []


class PreviewGroupingsPayload(BaseModel):
    selectedTestCases: list


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


def _extract_symbols(path: str, content: str) -> List[str]:
    """
    Best-effort method/function extraction by language inferred from file extension.
    Heuristic-only; used to flag potential destructive removals.
    """
    ext = os.path.splitext((path or "").lower())[1]
    if not content:
        return []

    patterns: List[str] = []
    if ext == ".py":
        patterns = [r"^\s*def\s+([A-Za-z_]\w*)\s*\("]
    elif ext == ".java":
        patterns = [r"^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\("]
    elif ext == ".cs":
        patterns = [r"^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\("]
    elif ext in (".js", ".ts", ".tsx"):
        patterns = [
            r"^\s*(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(",
            r"^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{",
            r"^\s*(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{",
        ]

    out: List[str] = []
    for pat in patterns:
        try:
            for m in re.finditer(pat, content, flags=re.MULTILINE):
                name = (m.group(1) or "").strip()
                if name and name not in out:
                    out.append(name)
        except re.error:
            continue
    return out


def _read_existing_text(path: str) -> str:
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _analyze_page_line_removals(rel: str, old_content: str, new_content: str) -> Dict[str, Any]:
    """
    Detect whether a page update removes existing line content.
    We treat pure-addition edits as safe, and any removed existing line as disallowed.
    """
    old_methods = set(_extract_symbols(rel, old_content))
    new_methods = set(_extract_symbols(rel, new_content))
    removed_methods = sorted(old_methods - new_methods)

    old_lines = old_content.splitlines()
    new_lines = new_content.splitlines()
    old_counts = Counter(old_lines)
    new_counts = Counter(new_lines)
    removed_lines = 0
    for line, count in old_counts.items():
        removed_lines += max(0, count - new_counts.get(line, 0))

    return {
        "path": rel,
        "file_kind": "page",
        "removed_methods": removed_methods,
        "removed_lines": removed_lines,
        "old_lines": len(old_lines),
        "new_lines": len(new_lines),
    }


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
        final_doc_path, md_path, test_cases_data = engine.run_pipeline()
        return {
            "status": "success",
            "message": "Test cases generated in Excel format.",
            "document_path": final_doc_path,
            "md_path": md_path,
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

@app.post("/list-projects")
def list_projects(payload: dict):
    """List available projects from the specified ALM tool."""
    import requests

    tool = payload.get("selectedTool", "")
    baseUrl = payload.get("baseUrl", "").rstrip("/")
    username = payload.get("username", "")
    token = payload.get("token", "")

    if not baseUrl or not token:
        raise HTTPException(status_code=400, detail="Missing baseUrl or token")

    projects = []

    try:
        if tool == "Jira":
            url = f"{baseUrl}/rest/api/3/projects"
            res = requests.get(url, auth=(username, token), timeout=10)
            if res.status_code == 200:
                data = res.json()
                if isinstance(data, list):
                    projects = [{"key": p.get("key"), "name": p.get("name"), "id": p.get("id")} for p in data]
                elif isinstance(data, dict) and "values" in data:
                    projects = [{"key": p.get("key"), "name": p.get("name"), "id": p.get("id")} for p in data.get("values", [])]
            elif res.status_code == 401 or res.status_code == 403:
                raise HTTPException(status_code=res.status_code, detail="Invalid Jira credentials (username/token)")
            elif res.status_code == 404:
                raise HTTPException(status_code=res.status_code, detail=f"Jira API endpoint not found. Check your base URL: {baseUrl}")
            else:
                raise HTTPException(status_code=res.status_code, detail=f"Failed to fetch Jira projects (HTTP {res.status_code})")

        elif tool == "ADO":
            url = f"{baseUrl}/_apis/projects?api-version=7.1"
            token_bytes = f":{token}".encode("utf-8")
            headers = {"Authorization": f"Basic {base64.b64encode(token_bytes).decode('ascii')}"}
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                data = res.json()
                projects = [{"name": p.get("name"), "id": p.get("id")} for p in data.get("value", [])]
            elif res.status_code == 401 or res.status_code == 403:
                raise HTTPException(status_code=res.status_code, detail="Invalid ADO credentials (PAT token)")
            elif res.status_code == 404:
                raise HTTPException(status_code=res.status_code, detail=f"ADO API endpoint not found. Check your base URL: {baseUrl}")
            else:
                raise HTTPException(status_code=res.status_code, detail=f"Failed to fetch ADO projects (HTTP {res.status_code})")

        elif tool == "TestRail":
            url = f"{baseUrl}/index.php?/api/v2/get_projects"
            res = requests.get(url, auth=(username, token), timeout=10)
            if res.status_code == 200:
                data = res.json()
                projects = [{"id": p.get("id"), "name": p.get("name"), "key": f"P{p.get('id')}"} for p in data]
            elif res.status_code == 401 or res.status_code == 403:
                raise HTTPException(status_code=res.status_code, detail="Invalid TestRail credentials (username/token)")
            elif res.status_code == 404:
                raise HTTPException(status_code=res.status_code, detail=f"TestRail API endpoint not found. Check your base URL: {baseUrl}")
            else:
                raise HTTPException(status_code=res.status_code, detail=f"Failed to fetch TestRail projects (HTTP {res.status_code})")

        elif tool == "QTest":
            url = f"{baseUrl}/api/v3/projects"
            headers = {"Authorization": f"Bearer {token}"}
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                data = res.json()
                projects = [{"id": p.get("id"), "name": p.get("name")} for p in data.get("items", [])]
            elif res.status_code == 401 or res.status_code == 403:
                raise HTTPException(status_code=res.status_code, detail="Invalid QTest credentials (API token)")
            elif res.status_code == 404:
                raise HTTPException(status_code=res.status_code, detail=f"QTest API endpoint not found. Check your base URL: {baseUrl}")
            else:
                raise HTTPException(status_code=res.status_code, detail=f"Failed to fetch QTest projects (HTTP {res.status_code})")

        else:
            raise HTTPException(status_code=400, detail=f"Unsupported tool: {tool}")

        return {"status": "success", "projects": projects, "count": len(projects)}

    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=500, detail=f"Connection error: {str(e)}")
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


@app.post("/save-library")
def save_library(payload: SaveLibraryPayload):
    import json as json_lib
    from datetime import datetime

    lib_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".tmp"))
    os.makedirs(lib_dir, exist_ok=True)
    lib_path = os.path.join(lib_dir, "library.json")

    entry = payload.dict()
    entry["savedAt"] = entry.get("savedAt") or datetime.utcnow().isoformat()

    existing = []
    if os.path.exists(lib_path):
        try:
            with open(lib_path, "r", encoding="utf-8") as f:
                existing = json_lib.load(f)
        except Exception:
            existing = []

    existing.append(entry)

    with open(lib_path, "w", encoding="utf-8") as f:
        json_lib.dump(existing, f, indent=2)

    return {
        "status": "success",
        "message": f"Saved '{entry['title']}' to library ({len(entry['testCases'])} cases).",
        "total_saved": len(existing)
    }


# ── Test Script Generation Endpoints ──────────────────────────────────────────

@app.post("/select-folder")
def select_folder():
    """Open native folder picker on the host running the backend; return chosen absolute path.

    Runs in a subprocess so tkinter does not conflict with FastAPI's worker threads.
    """
    import subprocess

    script = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "r = tk.Tk()\n"
        "r.withdraw()\n"
        "r.attributes('-topmost', True)\n"
        "p = filedialog.askdirectory(title='Select Test Automation Framework Folder')\n"
        "r.destroy()\n"
        "print(p or '')\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="Folder picker timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open folder picker: {e}")

    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Folder picker error: {result.stderr.strip() or 'unknown'}")

    path = (result.stdout or "").strip()
    if not path:
        return {"status": "cancelled", "path": ""}

    abs_path = os.path.realpath(os.path.abspath(path))
    if not os.path.isdir(abs_path):
        raise HTTPException(status_code=400, detail=f"Selected path is not a directory: {path}")
    return {"status": "success", "path": abs_path}


@app.post("/analyze-framework")
def analyze_framework_endpoint(payload: AnalyzeFrameworkPayload):
    """Validate framework path and return schema preview for the Settings dialog."""
    from framework_analyzer import analyze_framework, safe_resolve_under_root
    from config_parser import parse_project_configs

    fw_path = (payload.framework_path or "").strip()
    if not fw_path:
        raise HTTPException(status_code=400, detail="framework_path is required")

    try:
        if os.path.isabs(fw_path):
            abs_path = os.path.realpath(os.path.abspath(fw_path))
        else:
            abs_path = safe_resolve_under_root(os.path.expanduser("~"), fw_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not os.path.isdir(abs_path):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {fw_path}")

    try:
        schema = analyze_framework(abs_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Framework analysis failed: {e}")

    try:
        config_context = parse_project_configs(abs_path)
    except Exception as e:
        config_context = {
            "discovered_files": [],
            "env_vars": {},
            "base_urls": [],
            "environments": [],
            "timeouts": {},
            "framework_config": {},
            "ambiguities": [{"type": "error", "field": "config_parse", "detail": f"Config parsing error: {e}"}],
            "redacted_keys": [],
        }

    # Compact preview the UI can render without overwhelming the user
    preview = {
        "framework_path": schema.get("framework_path"),
        "tech_stack": schema.get("tech_stack"),
        "directory_layout": schema.get("directory_layout"),
        "naming_conventions": schema.get("naming_conventions"),
        "counts": schema.get("counts"),
        "base_class_names": [bc.get("name") for bc in schema.get("base_classes", [])],
        "page_object_names": [po.get("name") for po in schema.get("page_objects", [])],
        "sample_imports": schema.get("import_patterns", [])[:10],
        "config_context": config_context,
    }
    return {"status": "success", "schema_preview": preview, "schema": schema}


_CHAT_PROBE_DEFAULT_MODEL = {
    "GROQ": "llama-3.1-8b-instant",
    "Grok": "grok-beta",
    "Claude": "claude-3-5-haiku-20241022",
    "Anthropic": "claude-3-5-haiku-20241022",
    "OpenRouter": "openai/gpt-4o-mini",
}


def _chat_probe(provider: str, api_key: str, model: str) -> tuple[bool, str]:
    """
    POST a 1-token chat completion to verify the key actually has chat permissions.
    The /v1/models endpoint can return 200 with keys that lack inference scope or credits
    (especially on OpenRouter), so a real chat round-trip is the only reliable gate.

    Returns (ok, detail). detail is a short reason on failure, success message on ok.
    """
    import requests as _r

    probe_model = (model or "").strip() or _CHAT_PROBE_DEFAULT_MODEL.get(provider, "")
    if not probe_model:
        return True, "skipped (no model)"

    try:
        if provider in ("GROQ", "Grok", "OpenRouter"):
            url = {
                "GROQ": "https://api.groq.com/openai/v1/chat/completions",
                "Grok": "https://api.x.ai/v1/chat/completions",
                "OpenRouter": "https://openrouter.ai/api/v1/chat/completions",
            }[provider]
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            if provider == "OpenRouter":
                headers["HTTP-Referer"] = "https://github.com/otsi-smart-qa"
                headers["X-Title"] = "TestPulse AI-OTSI"
            res = _r.post(url, headers=headers, json={
                "model": probe_model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1,
                "temperature": 0,
            }, timeout=15)
        elif provider in ("Claude", "Anthropic"):
            res = _r.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json={
                    "model": probe_model,
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "ping"}],
                },
                timeout=15,
            )
        else:
            return True, "skipped (unknown provider)"
    except _r.exceptions.RequestException as exc:
        return False, f"network error during chat probe: {exc}"

    if 200 <= res.status_code < 300:
        return True, "chat permission verified"

    body_excerpt = ""
    try:
        body_excerpt = res.text[:300]
    except Exception:
        pass
    if res.status_code == 401:
        return False, (
            f"{provider} rejected the API key at /chat/completions (HTTP 401). "
            "Key may be revoked, scoped to read-only, or missing inference permission. "
            f"Body: {body_excerpt}"
        )
    if res.status_code == 402:
        return False, (
            f"{provider} reports insufficient credits/quota (HTTP 402). "
            f"Top up the account and retry. Body: {body_excerpt}"
        )
    if res.status_code == 404:
        return False, (
            f"Model '{probe_model}' not found at {provider} (HTTP 404). "
            f"Check the model identifier. Body: {body_excerpt}"
        )
    if res.status_code == 429:
        # Rate limit means the key is valid; pass.
        return True, "chat permission verified (rate limited but auth ok)"
    return False, f"{provider} chat probe failed (HTTP {res.status_code}). Body: {body_excerpt}"


@app.post("/test-llm-connection")
def test_llm_connection(payload: TestLLMConnectionPayload):
    """Connectivity + chat-permission check. Never echoes the key back."""
    import requests

    provider = (payload.llmProvider or "").strip()
    if not provider:
        raise HTTPException(status_code=400, detail="llmProvider is required")

    if provider == "Ollama":
        if not payload.llmEndpoint:
            raise HTTPException(status_code=400, detail="Missing Ollama endpoint URL")
        _validate_ollama_endpoint(payload.llmEndpoint)
        return {"status": "success", "message": "Ollama connection validated.", "provider": provider}

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

        requested = (payload.llmModel or "").strip().lower()
        if requested:
            try:
                data = res.json()
            except Exception:
                data = {}
            available = [m.get("id", "") for m in data.get("data", []) if isinstance(m, dict)]
            available = [m for m in available if m]
            if available and requested not in [m.lower() for m in available]:
                similar = [m for m in available if requested in m.lower()]
                head = "Top suggestions" if similar else "Available samples"
                listed = ", ".join((similar or available)[:10])
                raise HTTPException(
                    status_code=400,
                    detail=f"Model '{payload.llmModel}' not found for {provider}. {head}: {listed}",
                )
    except requests.exceptions.RequestException as exc:
        raise HTTPException(status_code=404, detail=f"Cannot reach {provider} API: {exc}")

    # Chat-permission probe: /models passing isn't enough — keys can be read-only or
    # out of credits. This catches OpenRouter 401/402 before the user hits Generate.
    ok, detail = _chat_probe(provider, payload.llmApiKey, payload.llmModel or "")
    if not ok:
        raise HTTPException(status_code=401, detail=detail)

    return {
        "status": "success",
        "message": f"{provider} connection + chat permission verified.",
        "provider": provider,
        "chat_probe": detail,
    }


@app.post("/preview-groupings")
def preview_groupings_endpoint(payload: PreviewGroupingsPayload):
    """Return the module groupings the generator would produce — used by UI confirmation step."""
    from test_grouping_service import grouping_preview

    if not payload.selectedTestCases:
        raise HTTPException(status_code=400, detail="selectedTestCases must be a non-empty list")
    return {"status": "success", **grouping_preview(payload.selectedTestCases)}


def _prepare_generate(payload: GenerateTestScriptsPayload):
    """Shared validation + framework analysis + grouping for JSON and SSE paths."""
    from framework_analyzer import analyze_framework
    from test_grouping_service import group_test_cases_by_module

    fw_path = (payload.framework_path or "").strip()
    if not fw_path:
        raise HTTPException(status_code=400, detail="framework_path is required")
    if not payload.selectedTestCases:
        raise HTTPException(status_code=400, detail="selectedTestCases must be a non-empty list")

    abs_path = os.path.realpath(os.path.abspath(fw_path))
    if not os.path.isdir(abs_path):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {fw_path}")

    try:
        framework_schema = analyze_framework(abs_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Framework analysis failed: {e}")

    selected_cases = payload.selectedTestCases
    if payload.target_test_case_id:
        target_id = payload.target_test_case_id.strip().lower()
        selected_cases = [
            tc for tc in selected_cases
            if isinstance(tc, dict) and str(tc.get("testCaseId", "")).strip().lower() == target_id
        ]
        if not selected_cases:
            raise HTTPException(
                status_code=404,
                detail=f"target_test_case_id '{payload.target_test_case_id}' not found in selection",
            )

    groups = group_test_cases_by_module(selected_cases)
    if not groups:
        raise HTTPException(status_code=400, detail="No groups produced from selected test cases.")

    if payload.target_module:
        target = payload.target_module.strip().lower()
        groups = [g for g in groups if (g.get("module") or "").strip().lower() == target]
        if not groups:
            raise HTTPException(
                status_code=404,
                detail=f"target_module '{payload.target_module}' not found in selection",
            )

    llm_config = {
        "llmProvider": payload.llmProvider,
        "llmApiKey": payload.llmApiKey,
        "llmModel": payload.llmModel,
        "llmEndpoint": payload.llmEndpoint or "http://127.0.0.1:11434",
    }
    refinement = payload.refinement_instruction.strip() or None
    config_context = payload.config_context or {}
    return framework_schema, groups, llm_config, refinement, config_context


def _framework_summary(framework_schema: dict) -> dict:
    tech = framework_schema.get("tech_stack") or {}
    return {"language": tech.get("language"), "test_framework": tech.get("test_framework")}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _generate_test_scripts_json(payload: GenerateTestScriptsPayload):
    """Legacy JSON path. Hard-stops on first failure (preserves prior behavior)."""
    from testscript_generator import generate_script_for_group

    framework_schema, groups, llm_config, refinement, config_context = _prepare_generate(payload)

    results = []
    for idx, group in enumerate(groups):
        try:
            gen = generate_script_for_group(framework_schema, group, llm_config, refinement, config_context)
        except Exception as e:
            results.append({
                "module": group.get("module"),
                "error": str(e)[:500],
                "source_test_case_ids": [
                    tc.get("testCaseId", "") for tc in group.get("test_cases", [])
                    if isinstance(tc, dict)
                ],
            })
            return {
                "status": "partial",
                "completed_groups": idx,
                "total_groups": len(groups),
                "groups": results,
                "framework_summary": _framework_summary(framework_schema),
            }
        results.append({
            "module": gen["module"],
            "generated_code": gen["generated_code"],
            "target_file_path": gen["target_file_path"],
            "language": gen["language"],
            "source_test_case_ids": gen["source_test_case_ids"],
            "warning": gen.get("warning"),
            "changed_files": gen.get("changed_files") or [],
            "validation_report": gen.get("validation_report") or {},
        })

    return {
        "status": "success",
        "completed_groups": len(results),
        "total_groups": len(groups),
        "groups": results,
        "framework_summary": _framework_summary(framework_schema),
    }


def _ids_of(group: dict) -> list:
    return [
        tc.get("testCaseId", "") for tc in (group.get("test_cases") or [])
        if isinstance(tc, dict)
    ]


def _is_retryable(err_msg: str) -> bool:
    low = err_msg.lower()
    return any(tok in low for tok in (
        "429", "rate limit", "timeout", "connection", "503", "502", "504",
    ))


async def _stream_generate_test_scripts(payload: GenerateTestScriptsPayload, request: Request):
    """SSE generator. Continues on per-group failure; guarantees terminal `done`."""
    request_id = (payload.request_id or "").strip() or uuid.uuid4().hex
    cancel_event = asyncio.Event()
    _CANCEL_TOKENS[request_id] = cancel_event

    queue: asyncio.Queue = asyncio.Queue()
    started_at = time.monotonic()

    async def emit(event: str, data: dict):
        await queue.put(_sse(event, data))

    async def heartbeat():
        try:
            while True:
                await asyncio.sleep(_SSE_HEARTBEAT_SECS)
                await queue.put(": keepalive\n\n")
        except asyncio.CancelledError:
            return

    async def worker():
        completed = 0
        failed = 0
        total = 0
        cancelled_flag = False
        try:
            print(f"[ScriptGen] rid={request_id} worker started")
            await emit("request_id", {"request_id": request_id})
            try:
                from testscript_generator import generate_script_for_group
            except Exception as e:
                err_msg = f"Script generation bootstrap failed: {str(e)[:300]}"
                print(f"[ScriptGen] rid={request_id} {err_msg}")
                await emit("error", {"status": 500, "detail": err_msg})
                return
            try:
                framework_schema, groups, llm_config, refinement, config_context = _prepare_generate(payload)
            except HTTPException as e:
                print(f"[ScriptGen] rid={request_id} prep failed: {e.status_code} {e.detail}")
                await emit("error", {"status": e.status_code, "detail": e.detail})
                return
            except Exception as e:
                # _prepare_generate should only raise HTTPException, but guard the SSE contract.
                err_msg = f"Unexpected prep error: {e}"
                print(f"[ScriptGen] rid={request_id} {err_msg}")
                await emit("error", {"status": 500, "detail": err_msg})
                return

            total = len(groups)
            print(f"[ScriptGen] rid={request_id} start total_groups={total}")
            await emit("start", {
                "total_groups": total,
                "request_id": request_id,
                "groups": [
                    {"module": g.get("module"), "case_count": len(g.get("test_cases") or [])}
                    for g in groups
                ],
                "framework_summary": _framework_summary(framework_schema),
            })

            for idx, group in enumerate(groups):
                module_name = group.get("module") or f"Group {idx}"
                disconnected = await request.is_disconnected()
                if cancel_event.is_set() or disconnected:
                    cancelled_flag = True
                    reason = "Cancelled by user" if cancel_event.is_set() else "Client disconnected"
                    print(f"[ScriptGen] rid={request_id} aborting at idx={idx}/{total}: {reason}")
                    for rem_idx in range(idx, total):
                        rem = groups[rem_idx]
                        rem_name = rem.get("module") or f"Group {rem_idx}"
                        await emit("group_error", {
                            "index": rem_idx,
                            "module": rem_name,
                            "error": reason,
                            "retryable": True,
                            "source_test_case_ids": _ids_of(rem),
                        })
                        failed += 1
                    break

                print(f"[ScriptGen] rid={request_id} group_start idx={idx} module={module_name!r}")
                await emit("group_start", {"index": idx, "module": module_name})
                try:
                    gen = await run_in_threadpool(
                        generate_script_for_group, framework_schema, group, llm_config, refinement, config_context,
                    )
                    completed += 1
                    print(f"[ScriptGen] rid={request_id} group_complete idx={idx} module={module_name!r}")
                    await emit("group_complete", {
                        "index": idx,
                        "module": gen["module"],
                        "generated_code": gen["generated_code"],
                        "target_file_path": gen["target_file_path"],
                        "language": gen["language"],
                        "source_test_case_ids": gen["source_test_case_ids"],
                        "warning": gen.get("warning"),
                        "changed_files": gen.get("changed_files") or [],
                        "validation_report": gen.get("validation_report") or {},
                    })
                except Exception as e:
                    failed += 1
                    err_msg = str(e)[:500]
                    print(f"[ScriptGen] rid={request_id} group_error idx={idx} module={module_name!r}: {err_msg}")
                    await emit("group_error", {
                        "index": idx,
                        "module": module_name,
                        "error": err_msg,
                        "retryable": _is_retryable(err_msg),
                        "source_test_case_ids": _ids_of(group),
                    })
        except BaseException as e:
            # Catches CancelledError (Py3.8+ BaseException subclass) so we still emit a terminal
            # done. Without this, a client-disconnect cancels the worker mid-await and the SSE
            # stream closes with no group_error/done — the client sees stale "queued" rows.
            print(f"[ScriptGen] rid={request_id} worker terminated by {type(e).__name__}: {e}")
            cancelled_flag = True
        finally:
            duration_ms = int((time.monotonic() - started_at) * 1000)
            print(f"[ScriptGen] rid={request_id} done completed={completed} failed={failed} "
                  f"total={total} cancelled={cancelled_flag or cancel_event.is_set()} "
                  f"duration_ms={duration_ms}")
            try:
                await emit("done", {
                    "completed": completed,
                    "failed": failed,
                    "total": total,
                    "duration_ms": duration_ms,
                    "cancelled": cancelled_flag or cancel_event.is_set(),
                    "request_id": request_id,
                })
            except Exception as e:
                print(f"[ScriptGen] rid={request_id} failed to emit done: {e}")
            await queue.put(None)

    hb_task = asyncio.create_task(heartbeat())
    worker_task = asyncio.create_task(worker())

    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        hb_task.cancel()
        if not worker_task.done():
            worker_task.cancel()
        _CANCEL_TOKENS.pop(request_id, None)


@app.post("/generate-test-scripts")
async def generate_test_scripts(payload: GenerateTestScriptsPayload, request: Request):
    """
    Generate test-class source code for selected test cases.

    Dual-mode: clients with `Accept: text/event-stream` get SSE with per-group
    progress and per-group error isolation. All other clients get the legacy
    JSON response (hard-stops on first failure).
    """
    accept = request.headers.get("accept", "")
    if "text/event-stream" in accept:
        return StreamingResponse(
            _stream_generate_test_scripts(payload, request),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )
    return _generate_test_scripts_json(payload)


@app.post("/generate-test-scripts/cancel")
def cancel_generate_test_scripts(payload: CancelGenerationPayload):
    """Signal an in-flight SSE generation to stop after current group."""
    rid = (payload.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id is required")
    ev = _CANCEL_TOKENS.get(rid)
    if ev is None:
        # Already finished or never existed — treat as no-op success so client UX stays clean.
        return {"status": "noop", "request_id": rid}
    ev.set()
    return {"status": "cancelled", "request_id": rid}


@app.post("/framework/version")
def framework_version(payload: FrameworkVersionPayload):
    """Return a stable hash + timestamp for a framework path so the UI can detect changes."""
    from framework_analyzer import analyze_framework

    fw_path = (payload.framework_path or "").strip()
    if not fw_path:
        raise HTTPException(status_code=400, detail="framework_path is required")
    abs_path = os.path.realpath(os.path.abspath(fw_path))
    if not os.path.isdir(abs_path):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {fw_path}")
    try:
        schema = analyze_framework(abs_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")
    blob = json.dumps(schema, sort_keys=True, default=str).encode("utf-8")
    return {
        "framework_path": abs_path,
        "schema_hash": hashlib.sha256(blob).hexdigest(),
        "analyzed_at": int(time.time()),
        "framework_summary": _framework_summary(schema),
    }


@app.post("/save-generated-script")
def save_generated_script(payload: SaveGeneratedScriptPayload):
    """Write generated code (and optional changed_files bundle) under the framework root."""
    from framework_analyzer import safe_resolve_under_root

    fw_path = (payload.framework_path or "").strip()
    rel_target = (payload.target_file_path or "").strip()
    if not fw_path:
        raise HTTPException(status_code=400, detail="framework_path is required")
    if not rel_target:
        raise HTTPException(status_code=400, detail="target_file_path is required")
    if os.path.isabs(rel_target):
        raise HTTPException(status_code=400, detail="target_file_path must be relative to framework_path")
    if payload.generated_code is None:
        raise HTTPException(status_code=400, detail="generated_code is required")
    abs_fw = os.path.realpath(os.path.abspath(fw_path))
    if not os.path.isdir(abs_fw):
        raise HTTPException(status_code=400, detail=f"framework_path is not a directory: {fw_path}")

    warning_lines = [str(w).strip() for w in (payload.warnings or []) if str(w).strip()]
    warning_block = ""
    if payload.force_save and warning_lines:
        warning_block = "/**Warning: Validation warnings were accepted during force-save.\n"
        for line in warning_lines:
            warning_block += f" - {line}\n"
        warning_block += "*/\n"

    def _with_warning_comment(rel: str, content: str) -> str:
        if not warning_block:
            return content
        lowered = rel.lower()
        is_script = lowered.endswith((".cs", ".java", ".js", ".ts", ".tsx"))
        if not is_script:
            return content
        if content.lstrip().startswith("/**Warning:"):
            return content
        return warning_block + content

    write_items = []
    if payload.changed_files:
        for item in payload.changed_files:
            if not isinstance(item, dict):
                continue
            rel = (item.get("path") or "").strip()
            content = item.get("content")
            if not rel or content is None:
                continue
            write_items.append(
                {
                    "rel": rel,
                    "content": _with_warning_comment(rel, str(content)),
                    "file_kind": (item.get("file_kind") or "").strip().lower(),
                }
            )
    else:
        write_items.append(
            {
                "rel": rel_target,
                "content": _with_warning_comment(rel_target, payload.generated_code),
                "file_kind": "",
            }
        )

    if not write_items:
        raise HTTPException(status_code=400, detail="No writable files found in payload.")

    resolved_paths = []
    for item in write_items:
        rel = item["rel"]
        if os.path.isabs(rel):
            raise HTTPException(status_code=400, detail=f"Path must be relative: {rel}")
        try:
            abs_target = safe_resolve_under_root(fw_path, rel)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        if os.path.exists(abs_target):
            if not payload.overwrite:
                raise HTTPException(
                    status_code=409,
                    detail=f"File already exists at {rel}. Resend with overwrite=true to replace.",
                )
            if not os.path.isfile(abs_target):
                raise HTTPException(status_code=400, detail=f"Target path exists and is not a regular file: {rel}")
        resolved_paths.append({**item, "abs_target": abs_target})

    # Page files are additive-only: never remove existing lines/methods.
    # If generated page content is non-additive, keep existing file content and return warnings.
    page_preservation_warnings: List[Dict[str, Any]] = []
    for item in resolved_paths:
        if item.get("file_kind") != "page":
            continue
        abs_target = item["abs_target"]
        existing = _read_existing_text(abs_target)
        if not existing:
            continue
        analysis = _analyze_page_line_removals(item["rel"], existing, item["content"])
        if int(analysis.get("removed_lines", 0)) > 0 or (analysis.get("removed_methods") or []):
            item["content"] = existing
            analysis["applied_mode"] = "preserved_existing_page"
            page_preservation_warnings.append(analysis)

    written = []
    total_bytes = 0
    for item in resolved_paths:
        rel = item["rel"]
        abs_target = item["abs_target"]
        content = item["content"]
        parent = os.path.dirname(abs_target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        try:
            with open(abs_target, "w", encoding="utf-8", newline="\n") as f:
                f.write(content)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Failed to write file '{rel}': {e}")
        b = len(content.encode("utf-8"))
        total_bytes += b
        written.append({"relative_path": rel, "written_path": abs_target, "bytes_written": b})

    return {
        "status": "success",
        "relative_path": rel_target,
        "written_path": resolved_paths[0]["abs_target"],
        "bytes_written": total_bytes,
        "written_files": written,
        "page_preservation_warnings": page_preservation_warnings,
    }


if __name__ == "__main__":
    import uvicorn
    # Running local API backend on port 8000
    uvicorn.run(app, host="127.0.0.1", port=8000)
