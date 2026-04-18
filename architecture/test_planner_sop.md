# 🏗️ Test Planner Engine SOP

## 1. Goal
Execute a deterministic pipeline that securely retrieves project requirements from specified integrations (Jira, ADO, etc.), structures them strictly according to the Extracted Requirements Schema, and outputs a formatted Test Plan document alongside atomic test cases.

## 2. Inputs
- **Payload Path:** `.tmp/job_payload.json` (Structured identically to the UI State Schema).
- **Template:** `Test Plan - Template.docx`.
- **Environment Context:** API integrations `.env` configuration.

## 3. Execution Pipeline (The 3 Phases)

### Step 1: Issue Ingestion & Enrichment (tools/issue_fetcher.py)
1. Read `.tmp/job_payload.json` for base URL, tool ID, and auth tokens.
2. Make HTTP GET request to the specified Integration provider endpoint (e.g., Jira `/rest/api/2/issue/{id}`).
3. Capture Raw Text/Description constraints. Add any uploaded `.pdf` / `.docx` context strings.

### Step 2: Deterministic Extraction (tools/llm_router.py)
1. Route context to the selected LLM Provider (Ollama / GROQ / Grok) with the **Zero Hallucination system prompt**.
2. Require the LLM to output ONLY the **Extracted Requirements Schema**.
3. *Validation:* The Python tool must parse the LLM's response using `json.loads()`. If it fails schema validation, retry or explicitly error.

### Step 3: Test Generation & Document Assembly (tools/test_planner_engine.py)
1. Pass the validated Requirements Schema to generate the atomic test cases arrays matching the **Generated Test Cases Schema**.
2. Load `Test Plan - Template.docx` into memory (via `python-docx`).
3. Replace template token blocks (e.g., `{{FEATURE_SCOPE}}`, `{{BUSINESS_RULES}}`).
4. Iteratively build the dynamic output table using the tool's nomenclature (e.g., Jira ID mapping to Column 2).
5. Save final file locally for the frontend to download or directly upload back to the Integration Provider.

## 4. Edge Cases & Error Handling
- **Invalid Auth Credentials:** Fail fast, throw Custom Auth Exception back to UI.
- **LLM Hallucination / Bad JSON:** Fallback to safe defaults or alert the user.
- **Missing Issue ID data:** Alert that the fetched ticket has insufficient ACs or scope to write atomic tests.
