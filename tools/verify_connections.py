"""
╔══════════════════════════════════════════════════════════╗
║   B.L.A.S.T. Phase 2: LINK — Connectivity Verifier      ║
║   Tests all external service handshakes before build.    ║
╚══════════════════════════════════════════════════════════╝

Run: python tools/verify_connections.py
"""

import os
import sys
import json
import base64
import requests
from datetime import datetime

# ── Load .env manually (no dotenv dependency required) ──────────────────────
def load_env(env_path: str) -> dict:
    env = {}
    if not os.path.exists(env_path):
        print(f"[!] .env file not found at {env_path}")
        return env
    with open(env_path, "r", encoding="utf-8") as f:

        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, val = line.partition("=")
                env[key.strip()] = val.strip()
    return env


# ── Utility ──────────────────────────────────────────────────────────────────
def ok(label: str, detail: str = ""):
    tag = f"  detail: {detail}" if detail else ""
    print(f"  ✅  {label}{tag}")

def fail(label: str, detail: str = ""):
    tag = f"\n       → {detail}" if detail else ""
    print(f"  ❌  {label}{tag}")

def skip(label: str, reason: str = ""):
    tag = f" ({reason})" if reason else ""
    print(f"  ⏭️   {label} — SKIPPED{tag}")

def section(title: str):
    print(f"\n{'─'*55}")
    print(f"  {title}")
    print(f"{'─'*55}")


# ── LLM VERIFIERS ────────────────────────────────────────────────────────────

def verify_groq(api_key: str):
    if not api_key:
        skip("GROQ", "GROQ_API_KEY not set in .env")
        return False
    try:
        resp = requests.get(
            "https://api.groq.com/openai/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=8,
        )
        if resp.status_code == 200:
            models = [m["id"] for m in resp.json().get("data", [])[:3]]
            ok("GROQ API", f"Connected. Available models (sample): {models}")
            return True
        else:
            fail("GROQ API", f"HTTP {resp.status_code} — {resp.text[:120]}")
            return False
    except Exception as e:
        fail("GROQ API", str(e))
        return False


def verify_grok(api_key: str):
    if not api_key:
        skip("Grok (xAI)", "GROK_API_KEY not set in .env")
        return False
    try:
        resp = requests.get(
            "https://api.x.ai/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=8,
        )
        if resp.status_code == 200:
            ok("Grok (xAI) API", "Connected.")
            return True
        else:
            fail("Grok (xAI) API", f"HTTP {resp.status_code}")
            return False
    except Exception as e:
        fail("Grok (xAI) API", str(e))
        return False


def verify_claude(api_key: str):
    if not api_key:
        skip("Claude / Anthropic", "CLAUDE_API_KEY not set in .env")
        return False
    try:
        resp = requests.get(
            "https://api.anthropic.com/v1/models",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            timeout=8,
        )
        if resp.status_code == 200:
            ok("Claude (Anthropic) API", "Connected.")
            return True
        else:
            fail("Claude (Anthropic) API", f"HTTP {resp.status_code}")
            return False
    except Exception as e:
        fail("Claude (Anthropic) API", str(e))
        return False


def verify_ollama(endpoint: str):
    if not endpoint:
        skip("Ollama (local)", "OLLAMA_ENDPOINT not set in .env")
        return False
    endpoint = endpoint.rstrip("/")
    for path in ["/api/tags", "/api/version"]:
        try:
            resp = requests.get(f"{endpoint}{path}", timeout=4)
            if resp.ok:
                ok("Ollama (local)", f"Reachable at {endpoint}{path}")
                return True
        except Exception:
            pass
    fail("Ollama (local)", f"Unreachable at {endpoint} — is Ollama running?")
    return False


# ── ALM VERIFIERS ─────────────────────────────────────────────────────────────

def verify_jira(base_url: str, username: str, token: str):
    if not all([base_url, username, token]):
        skip("Jira", "JIRA_BASE_URL / JIRA_USERNAME / JIRA_API_TOKEN not set")
        return False
    url = f"{base_url.rstrip('/')}/rest/api/3/myself"
    try:
        resp = requests.get(
            url, auth=(username, token),
            headers={"Accept": "application/json"}, timeout=8,
        )
        if resp.status_code == 200:
            display = resp.json().get("displayName", "Unknown")
            ok("Jira", f"Connected as → {display}")
            return True
        else:
            fail("Jira", f"HTTP {resp.status_code} — {resp.text[:120]}")
            return False
    except Exception as e:
        fail("Jira", str(e))
        return False


def verify_ado(org_url: str, project: str, pat: str):
    if not all([org_url, pat]):
        skip("ADO (Azure DevOps)", "ADO_ORG_URL / ADO_PAT not set")
        return False
    token_b64 = base64.b64encode(f":{pat}".encode()).decode("ascii")
    url = f"{org_url.rstrip('/')}/_apis/projects?api-version=7.1"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Basic {token_b64}", "Accept": "application/json"},
            timeout=8,
        )
        if resp.status_code == 200:
            count = resp.json().get("count", "?")
            ok("ADO (Azure DevOps)", f"Connected. {count} project(s) found.")
            return True
        else:
            fail("ADO (Azure DevOps)", f"HTTP {resp.status_code} — {resp.text[:120]}")
            return False
    except Exception as e:
        fail("ADO (Azure DevOps)", str(e))
        return False


def verify_xray(base_url: str, client_id: str, client_secret: str):
    if not all([base_url, client_id, client_secret]):
        skip("X-Ray", "XRAY_BASE_URL / XRAY_CLIENT_ID / XRAY_CLIENT_SECRET not set")
        return False
    auth_url = f"{base_url.rstrip('/')}/authenticate"
    try:
        resp = requests.post(
            auth_url,
            json={"client_id": client_id, "client_secret": client_secret},
            headers={"Content-Type": "application/json"},
            timeout=8,
        )
        if resp.status_code == 200:
            ok("X-Ray", "Authenticated — JWT token received.")
            return True
        else:
            fail("X-Ray", f"HTTP {resp.status_code} — {resp.text[:120]}")
            return False
    except Exception as e:
        fail("X-Ray", str(e))
        return False


def verify_testrail(base_url: str, username: str, api_key: str):
    if not all([base_url, username, api_key]):
        skip("TestRail", "TESTRAIL_BASE_URL / TESTRAIL_USERNAME / TESTRAIL_API_KEY not set")
        return False
    url = f"{base_url.rstrip('/')}/index.php?/api/v2/get_case_fields"
    try:
        resp = requests.get(
            url, auth=(username, api_key),
            headers={"Accept": "application/json"}, timeout=8,
        )
        if resp.status_code == 200:
            ok("TestRail", "Connected — case fields endpoint responded.")
            return True
        else:
            fail("TestRail", f"HTTP {resp.status_code} — {resp.text[:120]}")
            return False
    except Exception as e:
        fail("TestRail", str(e))
        return False


def verify_qtest(base_url: str, api_token: str):
    if not all([base_url, api_token]):
        skip("QTest", "QTEST_BASE_URL / QTEST_API_TOKEN not set")
        return False
    url = f"{base_url.rstrip('/')}/api/v3/projects"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {api_token}", "Accept": "application/json"},
            timeout=8,
        )
        if resp.status_code == 200:
            count = len(resp.json()) if isinstance(resp.json(), list) else "?"
            ok("QTest", f"Connected. {count} project(s) found.")
            return True
        else:
            fail("QTest", f"HTTP {resp.status_code} — {resp.text[:120]}")
            return False
    except Exception as e:
        fail("QTest", str(e))
        return False


# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "═" * 55)
    print("  🚀 B.L.A.S.T. Phase 2: LINK — Connectivity Check")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("═" * 55)

    # Resolve .env from project root (parent of tools/)
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    env = load_env(os.path.join(root, ".env"))

    results = {}

    # ── LLM Providers ────────────────────────────────────────
    section("🤖 LLM PROVIDERS")
    results["GROQ"]       = verify_groq(env.get("GROQ_API_KEY", ""))
    results["Grok_xAI"]   = verify_grok(env.get("GROK_API_KEY", ""))
    results["Claude"]     = verify_claude(env.get("CLAUDE_API_KEY") or env.get("ANTHROPIC_API_KEY", ""))
    results["Ollama"]     = verify_ollama(env.get("OLLAMA_ENDPOINT", ""))

    # ── Test Management Tools ─────────────────────────────────
    section("🔧 TEST MANAGEMENT TOOLS")
    results["Jira"]       = verify_jira(
        env.get("JIRA_BASE_URL", ""),
        env.get("JIRA_USERNAME", ""),
        env.get("JIRA_API_TOKEN", ""),
    )
    results["ADO"]        = verify_ado(
        env.get("ADO_ORG_URL", ""),
        env.get("ADO_PROJECT", ""),
        env.get("ADO_PAT", ""),
    )
    results["XRay"]       = verify_xray(
        env.get("XRAY_BASE_URL", ""),
        env.get("XRAY_CLIENT_ID", ""),
        env.get("XRAY_CLIENT_SECRET", ""),
    )
    results["TestRail"]   = verify_testrail(
        env.get("TESTRAIL_BASE_URL", ""),
        env.get("TESTRAIL_USERNAME", ""),
        env.get("TESTRAIL_API_KEY", ""),
    )
    results["QTest"]      = verify_qtest(
        env.get("QTEST_BASE_URL", ""),
        env.get("QTEST_API_TOKEN", ""),
    )

    # ── Summary ───────────────────────────────────────────────
    section("📊 LINK SUMMARY")
    passed  = [k for k, v in results.items() if v is True]
    failed  = [k for k, v in results.items() if v is False]
    skipped = [k for k, v in results.items() if v is None]

    print(f"  ✅  PASSED  : {', '.join(passed)  or 'None'}")
    print(f"  ❌  FAILED  : {', '.join(failed)  or 'None'}")
    print(f"  ⏭️   SKIPPED : {', '.join(skipped) or 'None'}")

    if "GROQ" in passed:
        print("\n  🟢 LINK ESTABLISHED — GROQ is live. Ready for Phase 3.")
    else:
        print("\n  🔴 LINK BROKEN — No active LLM connection. Check keys.")

    print("\n" + "═" * 55 + "\n")


if __name__ == "__main__":
    main()
