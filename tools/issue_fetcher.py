"""
╔══════════════════════════════════════════════════════════╗
║   A.N.T. Layer 3 Tool — Issue Fetcher                   ║
║   Deterministic fetcher for all 5 ALM platforms.        ║
║   SOP Reference: architecture/test_planner_sop.md       ║
╚══════════════════════════════════════════════════════════╝
Supported: Jira | ADO | X-Ray | TestRail | QTest
"""

import base64
import requests


# ─────────────────────────────────────────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────────────────────────────────────────

def _extract_text(value) -> str:
    """Recursively collapse Atlassian ADF / nested dicts into plain text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(filter(None, (_extract_text(i) for i in value))).strip()
    if isinstance(value, dict):
        parts = []
        if value.get("text"):
            parts.append(str(value["text"]))
        for key in ("content", "items"):
            if key in value:
                parts.append(_extract_text(value[key]))
        return " ".join(filter(None, parts)).strip()
    return str(value)


def _format_context(fields: dict) -> str:
    """Return a clean text block from a normalised field dict."""
    lines = []
    for label, val in fields.items():
        if val:
            lines.append(f"{label}: {val}")
    return "\n".join(lines).strip()


# ─────────────────────────────────────────────────────────────────────────────
# 1. JIRA  (Atlassian Cloud / Server v3)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_jira(base_url: str, username: str, token: str, issue_id: str) -> str:
    """
    Fetch a Jira issue via REST API v3.
    Returns: flat text block suitable for LLM extraction.
    Raises: RuntimeError on auth / network / 4xx failures.
    """
    url = (
        f"{base_url.rstrip('/')}/rest/api/3/issue/{issue_id}"
        "?fields=summary,description,issuetype,priority,labels,components,acceptance_criteria"
    )
    resp = requests.get(url, auth=(username, token),
                        headers={"Accept": "application/json"}, timeout=12)

    if resp.status_code == 401:
        raise RuntimeError("Jira auth failed — check email and API token.")
    if resp.status_code == 404:
        raise RuntimeError(f"Jira issue {issue_id!r} not found.")
    if not resp.ok:
        raise RuntimeError(f"Jira fetch failed [{resp.status_code}]: {resp.text[:200]}")

    data = resp.json()
    f = data.get("fields") or {}
    return _format_context({
        "Issue ID":          issue_id,
        "Issue Type":        _extract_text((f.get("issuetype") or {}).get("name")),
        "Priority":          _extract_text((f.get("priority") or {}).get("name")),
        "Labels":            ", ".join(f.get("labels") or []),
        "Components":        ", ".join(c.get("name") for c in (f.get("components") or []) if isinstance(c, dict) and c.get("name")),
        "Title":             f.get("summary", ""),
        "Description":       _extract_text(f.get("description")),
    })


# ─────────────────────────────────────────────────────────────────────────────
# 2. ADO  (Azure DevOps – Work Item REST API v7.1)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_ado(org_url: str, pat: str, work_item_id: str) -> str:
    """
    Fetch an ADO Work Item.
    org_url example: https://dev.azure.com/myorg  OR  https://myorg.visualstudio.com
    """
    token_b64 = base64.b64encode(f":{pat}".encode()).decode("ascii")
    url = (
        f"{org_url.rstrip('/')}/_apis/wit/workitems/{work_item_id}"
        "?$expand=all&api-version=7.1"
    )
    resp = requests.get(
        url,
        headers={"Authorization": f"Basic {token_b64}", "Accept": "application/json"},
        timeout=12,
    )

    if resp.status_code == 401:
        raise RuntimeError("ADO auth failed — check your Personal Access Token.")
    if resp.status_code == 404:
        raise RuntimeError(f"ADO work item {work_item_id!r} not found.")
    if not resp.ok:
        raise RuntimeError(f"ADO fetch failed [{resp.status_code}]: {resp.text[:200]}")

    f = resp.json().get("fields") or {}
    description_html = f.get("System.Description", "") or ""
    # ADO returns HTML for description — very basic strip
    import re
    description = re.sub(r"<[^>]+>", " ", description_html).strip()

    return _format_context({
        "Issue ID":       work_item_id,
        "Issue Type":     f.get("System.WorkItemType", ""),
        "Priority":       str(f.get("Microsoft.VSTS.Common.Priority", "")),
        "State":          f.get("System.State", ""),
        "Title":          f.get("System.Title", ""),
        "Description":    description,
        "Acceptance Criteria": re.sub(
            r"<[^>]+>", " ",
            f.get("Microsoft.VSTS.Common.AcceptanceCriteria", "") or ""
        ).strip(),
    })


# ─────────────────────────────────────────────────────────────────────────────
# 3. X-RAY  (X-Ray Cloud REST API)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_xray(base_url: str, client_id: str, client_secret: str, test_id: str) -> str:
    """
    Authenticate against X-Ray Cloud, then fetch test details.
    base_url example: https://xray.cloud.getxray.app/api/v2
    """
    # Step 1: Authenticate
    auth_resp = requests.post(
        f"{base_url.rstrip('/')}/authenticate",
        json={"client_id": client_id, "client_secret": client_secret},
        headers={"Content-Type": "application/json"},
        timeout=10,
    )
    if not auth_resp.ok:
        raise RuntimeError(f"X-Ray auth failed [{auth_resp.status_code}]: {auth_resp.text[:200]}")

    token = auth_resp.text.strip().strip('"')

    # Step 2: Fetch test
    test_resp = requests.get(
        f"{base_url.rstrip('/')}/test/{test_id}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=12,
    )
    if test_resp.status_code == 404:
        raise RuntimeError(f"X-Ray test {test_id!r} not found.")
    if not test_resp.ok:
        raise RuntimeError(f"X-Ray fetch failed [{test_resp.status_code}]: {test_resp.text[:200]}")

    d = test_resp.json()
    steps = d.get("steps") or []
    steps_text = " | ".join(
        f"Step {s.get('index', i+1)}: {s.get('action', '')}" for i, s in enumerate(steps)
    )
    return _format_context({
        "Issue ID":   test_id,
        "Issue Type": "X-Ray Test",
        "Summary":    d.get("summary", ""),
        "Test Type":  (d.get("testType") or {}).get("name", ""),
        "Status":     (d.get("status") or {}).get("name", ""),
        "Steps":      steps_text,
        "Description": d.get("definition", "") or d.get("description", ""),
    })


# ─────────────────────────────────────────────────────────────────────────────
# 4. TESTRAIL  (TestRail REST API v2)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_testrail(base_url: str, username: str, api_key: str, case_id: str) -> str:
    """
    Fetch a TestRail test case.
    case_id should be numeric (e.g. '1234' from 'C1234').
    """
    numeric_id = case_id.lstrip("Cc")
    url = f"{base_url.rstrip('/')}/index.php?/api/v2/get_case/{numeric_id}"
    resp = requests.get(
        url, auth=(username, api_key),
        headers={"Accept": "application/json"}, timeout=12,
    )
    if resp.status_code == 401:
        raise RuntimeError("TestRail auth failed — check username and API key.")
    if resp.status_code == 404:
        raise RuntimeError(f"TestRail case {case_id!r} not found.")
    if not resp.ok:
        raise RuntimeError(f"TestRail fetch failed [{resp.status_code}]: {resp.text[:200]}")

    d = resp.json()
    steps = d.get("custom_steps_separated", []) or []
    steps_text = " | ".join(
        f"Step {i+1}: {s.get('content', '')}" for i, s in enumerate(steps)
    )
    return _format_context({
        "Issue ID":         case_id,
        "Issue Type":       "TestRail Case",
        "Title":            d.get("title", ""),
        "Priority":         str(d.get("priority_id", "")),
        "Type":             str(d.get("type_id", "")),
        "Preconditions":    d.get("custom_preconds", "") or "",
        "Steps":            steps_text or (d.get("custom_steps", "") or ""),
        "Expected Result":  d.get("custom_expected", "") or "",
    })


# ─────────────────────────────────────────────────────────────────────────────
# 5. QTEST  (qTest Manager REST API v3)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_qtest(base_url: str, api_token: str, project_id: str, req_id: str) -> str:
    """
    Fetch a qTest requirement.
    base_url example: https://mycompany.qtestnet.com
    """
    url = f"{base_url.rstrip('/')}/api/v3/projects/{project_id}/requirements/{req_id}"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {api_token}", "Accept": "application/json"},
        timeout=12,
    )
    if resp.status_code == 401:
        raise RuntimeError("QTest auth failed — check your API token.")
    if resp.status_code == 404:
        raise RuntimeError(f"QTest requirement {req_id!r} not found in project {project_id!r}.")
    if not resp.ok:
        raise RuntimeError(f"QTest fetch failed [{resp.status_code}]: {resp.text[:200]}")

    d = resp.json()
    props = {p["field_name"]: p.get("field_value", "") for p in (d.get("properties") or []) if "field_name" in p}
    return _format_context({
        "Issue ID":    f"{project_id}/{req_id}",
        "Issue Type":  "QTest Requirement",
        "Title":       d.get("name", ""),
        "Priority":    str(props.get("Priority") or (d.get("priority") or {}).get("name") or ""),
        "Status":      str(props.get("Status", "")),
        "Description": d.get("description", "") or "",
    })


# ─────────────────────────────────────────────────────────────────────────────
# Router — called by TestPlannerEngine
# ─────────────────────────────────────────────────────────────────────────────

def fetch_issue(config: dict) -> str:
    """
    Dispatch to the correct ALM fetcher based on config['selectedTool'].
    Config keys match the UI State Schema in gemini.md.
    Raises RuntimeError on any failure — caller should catch and surface to UI.
    """
    tool       = config.get("selectedTool", "Jira")
    base_url   = config.get("baseUrl", "").rstrip("/")
    username   = config.get("username", "")
    token      = config.get("token", "")
    issue_id   = config.get("issueId", "").strip()

    if not issue_id:
        raise RuntimeError("No Ticket / Issue ID provided.")
    if not base_url:
        raise RuntimeError(f"No Base URL configured for {tool}.")
    if not token:
        raise RuntimeError(f"No API Token / PAT configured for {tool}.")

    print(f"[IssuerFetcher] Connecting to {tool} at {base_url} for '{issue_id}'...")

    if tool == "Jira":
        return fetch_jira(base_url, username, token, issue_id)

    elif tool == "ADO":
        return fetch_ado(base_url, token, issue_id)

    elif tool == "X-Ray":
        # For X-Ray Cloud: username = client_id, token = client_secret
        return fetch_xray(base_url, username, token, issue_id)

    elif tool == "TestRail":
        return fetch_testrail(base_url, username, token, issue_id)

    elif tool == "QTest":
        # QTest issue_id format: "projectId/reqId"
        parts = issue_id.split("/")
        if len(parts) != 2:
            raise RuntimeError("QTest Issue ID must be 'projectId/reqId' (e.g. '12/456').")
        return fetch_qtest(base_url, token, parts[0].strip(), parts[1].strip())

    else:
        raise RuntimeError(f"Unsupported tool: {tool!r}. Supported: Jira, ADO, X-Ray, TestRail, QTest.")
