"""
╔══════════════════════════════════════════════════════════╗
║   A.N.T. Layer 3 Tool — LLM Router                      ║
║   Routes prompts to the selected LLM provider.          ║
║   Zero-hallucination system prompt enforced.            ║
╚══════════════════════════════════════════════════════════╝
Supported: GROQ | Grok | Claude | Anthropic | Ollama | OpenAI | OpenRouter
"""

import json
import time
import requests
import re
import os

# ── Tool ID Column Label per gemini.md ───────────────────────────────────────
TOOL_COLUMN_LABEL = {
    "Jira":     "Jira ID",
    "ADO":      "ADO Work Item ID",
    "X-Ray":    "X-Ray Test ID",
    "TestRail": "TestRail Case ID",
    "QTest":    "QTest ID",
}

# ── Zero-Hallucination System Prompt ─────────────────────────────────────────
SYSTEM_PROMPT = """You are the AntiGravity Test Planner. STRICT RULES:
1. ZERO HALLUCINATION: Never invent requirements not in context.
2. ATOMIC DESIGN: Each test case validates ONE acceptance criterion.
3. CONCRETE DATA: Use real values, never placeholders like <value>.
4. JSON ONLY: Response must be valid JSON matching schema exactly.
5. TRACEABILITY: Every test case maps to a source AC.
6. STRUCTURED STEPS: Each step has action, expected, testData (N/A if none).

Generate structured test cases (max 20) in the provided JSON schema. No prose, no markdown — only JSON."""


def _repair_truncated_json(s: str) -> str:
    """Closes open braces/arrays and handles mid-string cutoffs."""
    s = s.strip()
    if not s: return "{}"

    # Remove trailing comma at the very end
    s = re.sub(r',\s*$', '', s)

    # Track whether we're inside a string
    in_string = False
    i = 0
    while i < len(s):
        if s[i] == '"' and (i == 0 or s[i-1] != '\\'):
            in_string = not in_string
        i += 1

    # If we end in an unclosed string, we need to close it
    # But first, back up to find a good place to truncate
    if in_string:
        # Find the opening quote of the unclosed string
        # Look backwards from the end to find the last unescaped quote
        quote_count = 0
        i = len(s) - 1
        while i >= 0:
            if s[i] == '"' and (i == 0 or s[i-1] != '\\'):
                quote_count += 1
                if quote_count == 1:
                    # Found the opening quote of unclosed string
                    # Now back up to the previous structural element
                    # to find a safe truncation point
                    j = i - 1
                    while j >= 0 and s[j] not in ':{},[]':
                        j -= 1
                    if j >= 0 and s[j] in ':,':
                        # Found a colon or comma before the unclosed string
                        # Keep up to and including that character
                        s = s[:j+1]
                    elif j >= 0:
                        s = s[:j+1]
                    else:
                        # No structural element found, keep what we have
                        pass
                    break
            i -= 1

    # Clean up any trailing colons or commas
    s = re.sub(r'[,:\s]+$', '', s)

    # Now balance all brackets and braces
    stack = []
    in_str = False
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == '"' and (i == 0 or s[i-1] != '\\'):
            in_str = not in_str
        if not in_str:
            if ch in ('{', '['):
                stack.append('}' if ch == '{' else ']')
            elif ch in ('}', ']'):
                if stack and stack[-1] == ch:
                    stack.pop()
        i += 1

    # Close everything on stack in reverse order
    while stack:
        s += stack.pop()

    # Final cleanup: remove any trailing commas before closing brackets
    s = re.sub(r',(\s*[}\]])', r'\1', s)
    return s


def _parse_json_response(raw: str) -> dict:
    """Extracts JSON and handles common LLM formatting errors."""
    try:
        # Clean markdown if present
        clean = re.sub(r'^```json\s*', '', raw, flags=re.MULTILINE)
        clean = re.sub(r'\s*```$', '', clean, flags=re.MULTILINE).strip()

        start = clean.find("{")
        end   = clean.rfind("}") + 1

        if start == -1:
            print("[JSON-Parser] No JSON object found in response, returning empty dict")
            return {}

        candidate = clean[start:end] if end > start else clean[start:]

        # Try standard parse first
        try:
            # Simple fix for common trailing commas
            fixed = re.sub(r',(\s*[}\]])', r'\1', candidate)
            return json.loads(fixed)
        except json.JSONDecodeError as e:
            # Attempt deep repair on truncated JSON
            print(f"[JSON-Parser] Standard parse failed: {e}. Attempting repair...")
            repaired = _repair_truncated_json(candidate)
            try:
                return json.loads(repaired)
            except json.JSONDecodeError as retry_e:
                print(f"[JSON-Parser] Repair attempt failed. Repaired JSON: {repaired[:200]}...")
                raise ValueError(f"JSON Parse Failure after repair: {retry_e}. Repaired snippet: {repaired[:300]}")

    except Exception as e:
        raise ValueError(f"JSON Parse Failure: {e}. Raw snippet: {raw[:300]}")


def _build_scenario_prompt(context_text: str, issue_id: str, tool: str) -> str:
    return f"""Generate 3-5 test scenarios (happy path, negative, boundary) from this requirement.

REQUIREMENT:
{context_text}

RETURN ONLY THIS JSON (no other text):
{{
  "testPlanTitle": "string (max 60 chars)",
  "selectedTool": "{tool}",
  "scenarios": [
    {{"id": "TS-001", "title": "string", "description": "string"}}
  ]
}}"""

def _extract_description_from_context(context_text: str) -> str:
    """Extract Description field from formatted context text."""
    for line in context_text.split('\n'):
        if line.startswith('Description:'):
            return line.replace('Description:', '').strip()
    return context_text


def _load_custom_prompt(context_text: str) -> str:
    """Load CustomTestCasesPrompt.txt and inject description context."""
    prompt_path = os.path.join(os.path.dirname(__file__), "..", "Templates", "CustomTestCasesPrompt.txt")
    try:
        with open(prompt_path, 'r', encoding='utf-8') as f:
            prompt = f.read()
        description = _extract_description_from_context(context_text)
        prompt = prompt.replace('[INSERT USER STORY HERE]', description if description else context_text)
        return prompt
    except FileNotFoundError:
        raise RuntimeError(f"CustomTestCasesPrompt.txt not found at {prompt_path}")
    except Exception as e:
        raise RuntimeError(f"Failed to load custom prompt: {e}")


def _build_user_prompt(context_text: str, issue_id: str, tool: str,
                       custom_instructions: str = "", use_custom_prompt: bool = False) -> str:
    if use_custom_prompt:
        base_prompt = _load_custom_prompt(context_text)
    else:
        # Compressed prompt with abbreviated schema
        base_prompt = f"""REQUIREMENT CONTEXT:
{context_text}

OUTPUT JSON SCHEMA:
{{
  "testPlanTitle": "string",
  "selectedTool": "{tool}",
  "requirementsProfile": {{
    "featureScope": "string",
    "acceptanceCriteria": ["AC1", "..."],
    "businessRules": [],
    "fieldValidations": [],
    "technicalDependencies": [],
    "errorHandling": []
  }},
  "testCases": [{{
    "testCaseId": "TC-001",
    "toolTicketId": "{issue_id}",
    "module": "string",
    "testCaseTitle": "string",
    "preconditions": "string",
    "testSteps": [{{
      "stepNumber": 1,
      "action": "string",
      "expected": "string",
      "testData": "string or N/A"
    }}],
    "priority": "High|Medium|Low",
    "testType": "Functional|Non-Functional|Regression|Smoke|Sanity|API"
  }}]
}}"""

    custom_part = f"\n\nUSER INSTRUCTIONS: {custom_instructions}" if custom_instructions else ""

    if use_custom_prompt:
        return f"""{base_prompt}{custom_part}

RETURN ONLY VALID JSON matching this schema:
{{
  "testPlanTitle": "string",
  "selectedTool": "{tool}",
  "testCases": [{{
    "testCaseId": "TC-001",
    "toolTicketId": "{issue_id}",
    "module": "string",
    "testCaseTitle": "string",
    "preconditions": "string",
    "testSteps": [{{
      "stepNumber": 1,
      "action": "string",
      "expected": "string",
      "testData": "string or N/A"
    }}],
    "priority": "High|Medium|Low",
    "testType": "Functional|Non-Functional|Regression|Smoke|Sanity|API"
  }}]
}}"""
    else:
        return f"{base_prompt}{custom_part}"

def _request_with_retry(method, url, retries=3, **kwargs):
    """Make an HTTP request with automatic retry on 429 rate-limit errors."""
    for attempt in range(retries):
        resp = method(url, **kwargs)
        if resp.status_code == 429 and attempt < retries - 1:
            wait = int(resp.headers.get("retry-after", 2 ** attempt + 1))
            print(f"[LLMRouter] Rate limited (429). Retrying in {wait}s (attempt {attempt + 1}/{retries})...")
            time.sleep(wait)
            continue
        return resp
    return resp


def _call_groq(api_key: str, model: str, messages: list, max_tokens: int = 4096) -> str:
    resp = _request_with_retry(
        requests.post,
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": model or "llama-3.3-70b-versatile", "messages": messages,
              "temperature": 0.1, "max_tokens": max_tokens},
        timeout=120
    )
    if resp.status_code == 413:
        raise requests.exceptions.HTTPError("413 Client Error: Payload Too Large", response=resp)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]

def _call_grok(api_key: str, model: str, messages: list) -> str:
    resp = _request_with_retry(
        requests.post,
        "https://api.x.ai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": model or "grok-beta", "messages": messages,
              "temperature": 0.1, "max_tokens": 8192},
     )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]

def _call_claude(api_key: str, model: str, messages: list) -> str:
    system_msg = next((m["content"] for m in messages if m["role"] == "system"), SYSTEM_PROMPT)
    user_msgs  = [m for m in messages if m["role"] != "system"]
    resp = _request_with_retry(
        requests.post,
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        },
        json={
            "model": model or "claude-sonnet-4-20250514",
            "max_tokens": 16384,
            "system": system_msg,
            "messages": user_msgs,
            "temperature": 0.1
        },
        timeout=120
    )
    if resp.status_code == 400:
        try:
            err_detail = resp.json().get("error", {}).get("message", resp.text[:300])
        except Exception:
            err_detail = resp.text[:300]
        raise requests.exceptions.HTTPError(
            f"400 Bad Request from Anthropic: {err_detail}", response=resp
        )
    resp.raise_for_status()
    return resp.json()["content"][0]["text"]

def _call_ollama(endpoint: str, model: str, messages: list) -> str:
    resp = requests.post(
        f"{endpoint.rstrip('/')}/api/chat",
        json={"model": model or "llama3", "messages": messages, "stream": False, "format": "json"},
        timeout=180
    )
    resp.raise_for_status()
    return resp.json()["message"]["content"]

def _call_openrouter(api_key: str, model: str, messages: list, max_tokens: int = 4096) -> str:
    resp = _request_with_retry(
        requests.post,
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/otsi-smart-qa", # Optional
            "X-Title": "TestPulse AI-OTSI"
        },
        json={
            "model": model or "google/gemini-pro-1.5",
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"}
        },
        timeout=120
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]

def _truncate_context(text: str, max_chars: int) -> str:
    """Truncate context to stay within LLM provider payload limits."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n[... context truncated to fit provider limits ...]"


def _summarize_context_deterministic(text: str, max_chars: int = 1000) -> str:
    """
    Deterministic context summarization without LLM.
    Extracts key information and compresses text.
    """
    if len(text) <= max_chars:
        return text
    
    # Split into lines and extract key sections
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    
    # Priority keywords to keep
    priority_keywords = [
        'acceptance criteria', 'AC:', 'AC.', 'given', 'when', 'then',
        'user story', 'as a', 'i want', 'so that',
        'requirement', 'must', 'should', 'shall',
        'test case', 'scenario', 'feature',
        'business rule', 'validation', 'error'
    ]
    
    # Extract high-priority lines
    important_lines = []
    for line in lines:
        line_lower = line.lower()
        # Keep lines with priority keywords or short lines (likely headings)
        if (any(kw in line_lower for kw in priority_keywords) or 
            len(line) < 80 or 
            line.startswith(('#', '##', '###', '-', '*', '•'))):
            important_lines.append(line)
    
    # If we extracted enough important content, use that
    extracted_text = '\n'.join(important_lines)
    if len(extracted_text) <= max_chars and len(important_lines) > len(lines) * 0.3:
        return extracted_text
    
    # Fallback: Take first and last parts with ellipsis
    if len(text) > max_chars * 2:
        part_size = max_chars // 2 - 50
        return text[:part_size] + "\n\n[... summarized content ...]\n\n" + text[-part_size:]
    else:
        return text[:max_chars]


# ── Lite Mode Model Mappings ──────────────────────────────────────────────────
# Maps full model names to smaller/faster alternatives for lite mode
LITE_MODEL_MAP = {
    "llama-3.3-70b-versatile": "llama-3.1-8b-instant",
    "grok-beta": "grok-beta",  # No smaller alternative
    "claude-sonnet-4-20250514": "claude-3-5-haiku-20241022",
    "claude-3-5-sonnet-latest": "claude-3-5-haiku-20241022",
    "llama3": "llama3.2:3b",
    "llama3.1": "llama3.2:3b",
    "google/gemini-pro-1.5": "google/gemini-flash-1.5",
}

def _get_model_for_mode(config: dict) -> tuple:
    """
    Returns (model_name, is_lite_mode) based on config and context size.
    Supports explicit lite mode selection via model name prefix or config.
    """
    model = config.get("llmModel", "").strip() or None
    provider = config.get("llmProvider", "GROQ")
    
    # Check for explicit lite mode indicator
    lite_mode = config.get("liteMode", False)
    
    if not model:
        # Use provider defaults
        if provider == "GROQ":
            model = "llama-3.3-70b-versatile" if not lite_mode else "llama-3.1-8b-instant"
        elif provider == "Grok":
            model = "grok-beta"
        elif provider in ["Claude", "Anthropic"]:
            model = "claude-sonnet-4-20250514" if not lite_mode else "claude-3-5-haiku-20241022"
        elif provider == "Ollama":
            model = "llama3" if not lite_mode else "llama3.2:3b"
        elif provider == "OpenRouter":
            model = "google/gemini-pro-1.5" if not lite_mode else "google/gemini-flash-1.5"
    
    # Auto-enable lite mode for very large contexts (>5000 chars)
    if not lite_mode and model in LITE_MODEL_MAP:
        lite_mode = True
    
    # Map to lite model if needed
    if lite_mode and model in LITE_MODEL_MAP:
        lite_model = LITE_MODEL_MAP[model]
        if lite_model != model:
            print(f"[LLM-Router] Lite mode enabled: {model} -> {lite_model}")
            model = lite_model
    
    return model, lite_mode


def route_to_llm(config: dict, context_text: str, custom_instructions: str = "", use_custom_prompt: bool = False) -> dict:
    provider = config.get("llmProvider", "GROQ")
    api_key  = config.get("llmApiKey", "")
    endpoint = config.get("llmEndpoint", "http://127.0.0.1:11434")
    tool     = config.get("selectedTool", "Jira")
    issue_id = config.get("issueId", "UNKNOWN")

    # Get model with lite mode support
    model, lite_mode = _get_model_for_mode(config)

    # Provider-specific context limits (approximate safe char limits)
    # GROQ free-tier enforces strict payload size — keep conservatively low
    provider_limits = {"GROQ": 3500, "Grok": 32000, "Claude": 100000, "Anthropic": 100000, "Ollama": 16000, "OpenRouter": 64000}
    max_chars = provider_limits.get(provider, 100000)

    # Apply context summarization if enabled (lite mode or very large context)
    if lite_mode or len(context_text) > 5000:
        print(f"[LLM-Router] Applying deterministic summarization for lite mode or large context.")
        context_text = _summarize_context_deterministic(context_text, max_chars)
    else:
        context_text = _truncate_context(context_text, max_chars)

    def _build_messages(ctx: str) -> list:
        prompt = _build_user_prompt(ctx, issue_id, tool, custom_instructions, use_custom_prompt)
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ]

    messages = _build_messages(context_text)

    # Dynamic payload guard: if JSON payload exceeds safe threshold, shrink context further
    MAX_PAYLOAD_CHARS = {"GROQ": 20000, "Grok": 200000, "Claude": 500000, "Anthropic": 500000, "Ollama": 100000, "OpenRouter": 200000}
    max_payload = MAX_PAYLOAD_CHARS.get(provider, 500000)
    payload_size = len(json.dumps(messages))
    if payload_size > max_payload:
        # Calculate overhead without context to find available budget
        overhead = len(json.dumps(_build_messages("")))
        available = max(max_payload - overhead - 500, 500)
        context_text = _truncate_context(context_text, available)
        messages = _build_messages(context_text)
        payload_size = len(json.dumps(messages))
        print(f"[LLM-Router] Payload trimmed to fit {provider} limit. Context={len(context_text)} chars.")

    user_prompt = messages[1]["content"]
    custom_indicator = " | CUSTOM_PROMPT" if use_custom_prompt else ""
    print(f"[LLM-Router] Provider={provider} | Context={len(context_text)} chars | "
          f"Prompt={len(user_prompt)} chars | Total payload={payload_size} chars ({payload_size/1024:.1f} KB){custom_indicator}")

    def _dispatch(msgs: list) -> str:
        if provider == "GROQ":               return _call_groq(api_key, model, msgs)
        elif provider == "Grok":             return _call_grok(api_key, model, msgs)
        elif provider in ["Claude", "Anthropic"]: return _call_claude(api_key, model, msgs)
        elif provider == "Ollama":           return _call_ollama(endpoint, model, msgs)
        elif provider == "OpenRouter":       return _call_openrouter(api_key, model, msgs)
        else: raise ValueError(f"Unsupported provider: {provider}")

    try:
        raw = _dispatch(messages)
        return _parse_json_response(raw)
    except requests.exceptions.HTTPError as e:
        # Retry once with 50% context on 413 Payload Too Large
        if e.response is not None and e.response.status_code == 413:
            print(f"[LLM-Router] 413 Payload Too Large — retrying with 50% context reduction.")
            context_text = _truncate_context(context_text, max(len(context_text) // 2, 500))
            messages = _build_messages(context_text)
            print(f"[LLM-Router] Retry context={len(context_text)} chars | "
                  f"payload={len(json.dumps(messages))} chars")
            try:
                raw = _dispatch(messages)
                return _parse_json_response(raw)
            except Exception as retry_e:
                raise RuntimeError(f"{provider} generation failed after retry: {str(retry_e)}")
        raise RuntimeError(f"{provider} generation failed: {str(e)}")
    except Exception as e:
        raise RuntimeError(f"{provider} generation failed: {str(e)}")


def route_scenarios(config: dict, context_text: str) -> dict:
    """Routes high-level scenario generation to the LLM."""
    provider = config.get("llmProvider", "GROQ")
    api_key  = config.get("llmApiKey", "")
    endpoint = config.get("llmEndpoint", "http://127.0.0.1:11434")
    model    = config.get("llmModel", "").strip() or None
    tool     = config.get("selectedTool", "Jira")
    issue_id = config.get("issueId", "UNKNOWN")

    # GROQ has very strict payload limits on free tier - be conservative
    max_chars = {"GROQ": 2000, "Grok": 32000, "Ollama": 16000, "OpenRouter": 64000}.get(provider, 100000)
    context_text = _truncate_context(context_text, max_chars)

    def _build_sc_messages(ctx: str) -> list:
        prompt = _build_scenario_prompt(ctx, issue_id, tool)
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ]

    messages = _build_sc_messages(context_text)

    # Dynamic payload guard: if JSON payload exceeds safe threshold, shrink context further
    # GROQ free tier is very restrictive - use much smaller limits
    MAX_PAYLOAD_CHARS = {"GROQ": 15000, "Grok": 200000, "Ollama": 100000, "OpenRouter": 200000}
    max_payload = MAX_PAYLOAD_CHARS.get(provider, 500000)
    payload_size = len(json.dumps(messages))
    if payload_size > max_payload:
        # Calculate overhead without context to find available budget
        overhead = len(json.dumps(_build_sc_messages("")))
        available = max(max_payload - overhead - 500, 500)
        context_text = _truncate_context(context_text, available)
        messages = _build_sc_messages(context_text)
        payload_size = len(json.dumps(messages))
        print(f"[LLM-Router] Scenario payload trimmed to fit {provider} limit. Context={len(context_text)} chars.")

    user_prompt = messages[1]["content"]
    print(f"[LLM-Router] Scenario Provider={provider} | Context={len(context_text)} chars | "
          f"Prompt={len(user_prompt)} chars | Total payload={payload_size} chars ({payload_size/1024:.1f} KB)")

    def _dispatch(msgs: list) -> str:
        # For scenarios, use moderate token limit to keep payload manageable
        scenario_max_tokens = {"GROQ": 2048, "Grok": 4096, "Claude": 4096, "Anthropic": 4096, "Ollama": 2048, "OpenRouter": 4096}
        tokens = scenario_max_tokens.get(provider, 2048)
        if provider == "GROQ":               return _call_groq(api_key, model, msgs, max_tokens=tokens)
        elif provider == "Grok":             return _call_grok(api_key, model, msgs)
        elif provider in ["Claude", "Anthropic"]: return _call_claude(api_key, model, msgs)
        elif provider == "Ollama":           return _call_ollama(endpoint, model, msgs)
        elif provider == "OpenRouter":       return _call_openrouter(api_key, model, msgs, max_tokens=tokens)
        else: raise ValueError(f"Unsupported provider: {provider}")

    try:
        raw = _dispatch(messages)
        return _parse_json_response(raw)
    except requests.exceptions.HTTPError as e:
        # Retry with more aggressive context reduction on 413 Payload Too Large
        if e.response is not None and e.response.status_code == 413:
            print(f"[LLM-Router] 413 Payload Too Large — retrying scenarios with 75% context reduction.")
            # More aggressive: reduce to 25% of original context
            context_text = _truncate_context(context_text, max(len(context_text) // 4, 500))
            messages = _build_sc_messages(context_text)
            print(f"[LLM-Router] Retry context={len(context_text)} chars | "
                  f"payload={len(json.dumps(messages))} chars")
            try:
                raw = _dispatch(messages)
                return _parse_json_response(raw)
            except Exception as retry_e:
                raise RuntimeError(f"{provider} scenario generation failed after retry: {str(retry_e)}")
        raise RuntimeError(f"{provider} scenario generation failed: {str(e)}")
    except Exception as e:
        raise RuntimeError(f"{provider} scenario generation failed: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
# Gap Analysis Router
# ─────────────────────────────────────────────────────────────────────────────

GAP_SYSTEM_PROMPT = """You are a QA Requirements Gap Analyst operating under the B.L.A.S.T. framework.
Your job is to identify ONLY what is explicitly missing from the provided requirement context.
DO NOT invent missing items — flag only what is truly absent.
Return ONLY valid JSON, no prose or markdown."""

GAP_USER_TEMPLATE = """Review the following requirement and identify testing-relevant gaps.

REQUIREMENT CONTEXT:
{context}

Return ONLY this JSON (no other text):
{{
  "issueId": "{issue_id}",
  "summary": "one-sentence summary of what this requirement is about",
  "sourceContext": "brief excerpt of the requirement (max 400 chars)",
  "strengths": ["item present and clear", "..."],
  "gaps": ["what is explicitly missing", "..."],
  "recommendation": "one concise recommendation to improve testability"
}}"""


def route_gap_analysis(config: dict, context_text: str) -> dict:
    """Run a gap analysis on the requirement context using the selected LLM."""
    provider = config.get("llmProvider", "GROQ")
    api_key  = config.get("llmApiKey", "")
    endpoint = config.get("llmEndpoint", "http://127.0.0.1:11434")
    model    = config.get("llmModel", "").strip() or None
    issue_id = config.get("issueId", "UNKNOWN")

    print(f"[LLMRouter] Running gap analysis via {provider}...")

    messages = [
        {"role": "system", "content": GAP_SYSTEM_PROMPT},
        {"role": "user",   "content": GAP_USER_TEMPLATE.format(
            context=context_text, issue_id=issue_id)},
    ]

    try:
        if provider == "GROQ":
            raw = _call_groq(api_key, model, messages)
        elif provider == "Grok":
            raw = _call_grok(api_key, model, messages)
        elif provider in {"Claude", "Anthropic"}:
            raw = _call_claude(api_key, model, messages)
        elif provider == "Ollama":
            raw = _call_ollama(endpoint, model or "llama3", messages)
        elif provider == "OpenRouter":
            raw = _call_openrouter(api_key, model, messages)
        else:
            raise RuntimeError(f"Unsupported provider: {provider!r}")
    except Exception as e:
        print(f"[LLMRouter] Gap analysis failed: {e}. Using deterministic fallback.")
        return _deterministic_gap_fallback(context_text, issue_id)

    try:
        result = _parse_json_response(raw)
    except Exception:
        return _deterministic_gap_fallback(context_text, issue_id)

    result.setdefault("issueId",        issue_id)
    result.setdefault("summary",        f"Gap review for {issue_id}")
    result.setdefault("sourceContext",  context_text[:400])
    result.setdefault("strengths",      [])
    result.setdefault("gaps",           [])
    result.setdefault("recommendation", "Clarify missing items before generating test cases.")
    return result


def _deterministic_gap_fallback(context: str, issue_id: str) -> dict:
    lower = (context or "").lower()
    checks = [
        ("acceptance criteria", "Acceptance criteria are not explicitly listed."),
        ("error",               "Error-handling expectations are not described."),
        ("validation",          "Input validation rules are missing."),
        ("role",                "User roles or permission expectations are unclear."),
        ("performance",         "Performance / response-time expectations are not defined."),
        ("security",            "Security requirements are not called out."),
    ]
    gaps      = [msg for kw, msg in checks if kw not in lower]
    strengths = []
    if "title" in lower or "summary" in lower:
        strengths.append("Requirement title / summary is present.")
    if len(context) > 120:
        strengths.append("Baseline functional context is available for planning.")
    if issue_id and issue_id != "UNKNOWN":
        strengths.append(f"Traceability to source item {issue_id} is available.")
    return {
        "issueId":        issue_id,
        "summary":        f"Deterministic gap review for {issue_id}.",
        "sourceContext":  context[:400],
        "strengths":      strengths or ["Some context is available."],
        "gaps":           gaps or ["No obvious gaps detected."],
        "recommendation": "Add explicit acceptance criteria and error-handling details.",
    }
