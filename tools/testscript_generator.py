"""
Test Script Generator

Takes a framework schema (from framework_analyzer), a single module group of
normalized test cases (from test_grouping_service), and the user's LLM
connection config –" returns generated test-class source code that matches the
framework's existing conventions.

Key contract:
    - One LLM call per group (caller iterates over groups sequentially).
    - Returns raw source code (NOT JSON). No file writes.
    - Includes traceability annotations: @TestCaseId(...) and @ExternalRef(...)
      rendered in the language-appropriate syntax.

Public surface:
    generate_script_for_group(framework_schema, group, llm_config,
                              refinement_instruction=None) -> dict
    derive_target_file_path(framework_schema, module_name) -> str
"""

from __future__ import annotations

import json
import difflib
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import requests

from llm_router import (
    _call_groq,
    _call_grok,
    _call_claude,
    _call_ollama,
    _call_openrouter,
    _request_with_retry,
    _suggest_alternate_model,
)
from script_policy_validator import validate_generation


# Provider char budgets for the full user-prompt. Conservative; framework
# schema + test cases must fit together. Lower than llm_router defaults
# because we don't truncate framework context –" we keep it short instead.
PROVIDER_PROMPT_BUDGET = {
    "GROQ":       8000,
    "Grok":       30000,
    "Claude":     80000,
    "Anthropic":  80000,
    "Ollama":     12000,
    "OpenRouter": 50000,
}

# Max serialized payload size for [{"role":"system"},{"role":"user"}] messages.
# Keep GROQ conservative because 413 thresholds vary by account/model tier.
PROVIDER_PAYLOAD_BUDGET = {
    "GROQ":       7000,
    "Grok":       180000,
    "Claude":     400000,
    "Anthropic":  400000,
    "Ollama":     90000,
    "OpenRouter": 180000,
}

SYSTEM_PROMPT = (
    "You are a senior test automation engineer. Generate framework-compliant "
    "automation updates as structured JSON only. STRICT RULES:\n"
    "1. Output valid JSON object only. No markdown fences. No prose.\n"
    "2. Every test method maps to exactly one input test case.\n"
    "3. Keep UI locators/selectors inside page object files, not tests.\n"
    "4. Preserve framework attributes/decorators, base class, imports, and "
    "category patterns inferred from the framework profile.\n"
    "5. Ensure each test step includes reporter Info-level logging.\n"
    "6. Generate compile-ready code; no TODO placeholders.\n"
    "7. Include impacted page/test file updates when signature changes require "
    "propagated changes."
)


def _payload_chars(messages: List[Dict[str, str]]) -> int:
    """Estimate payload size using the same JSON defaults requests uses."""
    return len(json.dumps(messages))


def _fit_messages_to_payload_limit(
    system_prompt: str,
    user_prompt: str,
    max_payload: int,
) -> Tuple[List[Dict[str, str]], Optional[str]]:
    """
    Return messages guaranteed to serialize under `max_payload` chars.
    Uses binary-search truncation on user prompt when needed.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    if _payload_chars(messages) <= max_payload:
        return messages, None

    suffix = "\n[... prompt hard-truncated ...]"
    lo, hi = 0, len(user_prompt)
    best_text: Optional[str] = None
    best_payload = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = user_prompt[:mid]
        if mid < len(user_prompt):
            candidate = candidate.rstrip() + suffix
        probe = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": candidate},
        ]
        pchars = _payload_chars(probe)
        if pchars <= max_payload:
            best_text = candidate
            best_payload = pchars
            lo = mid + 1
        else:
            hi = mid - 1

    # Absolute fallback when provider cap is very small.
    if best_text is None:
        best_text = suffix
        probe = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": best_text},
        ]
        best_payload = _payload_chars(probe)
        if best_payload > max_payload:
            tiny = "[truncated]"
            probe = [
                {"role": "system", "content": _clip(system_prompt, max(200, max_payload // 3))},
                {"role": "user", "content": tiny},
            ]
            best_payload = _payload_chars(probe)
            return probe, (
                f"Prompt and system instruction were reduced to fit strict provider payload cap "
                f"({best_payload}/{max_payload} chars)."
            )

    return (
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": best_text},
        ],
        f"Prompt hard-truncated to satisfy provider payload ceiling ({best_payload}/{max_payload} chars).",
    )


def _estimate_message_tokens(messages: List[Dict[str, str]]) -> int:
    """
    Rough token estimate from serialized JSON chars.
    Using ~4 chars/token as a conservative approximation.
    """
    return max(1, _payload_chars(messages) // 4)


def _groq_safe_max_tokens(messages: List[Dict[str, str]], model: str) -> int:
    """
    Pick a safe completion budget to avoid Groq TPM 413 on on-demand tier.
    We reserve headroom under 6000 total requested tokens.
    """
    est_prompt = _estimate_message_tokens(messages)
    safe_total = 5600
    allowance = safe_total - est_prompt
    # Keep enough room for useful code while staying under common tier limits.
    tokens = max(256, min(1800, allowance))
    if "8b-instant" in (model or "").lower():
        tokens = min(tokens, 1200)
    return tokens


# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Filename / target path derivation
# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def _slugify(name: str) -> str:
    """Lowercase, replace non-alnum runs with underscores. Strip edges."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", (name or "").strip()).strip("_").lower()
    return s or "module"


def _pascal_case(name: str) -> str:
    parts = re.split(r"[^a-zA-Z0-9]+", (name or "").strip())
    parts = [p for p in parts if p]
    if not parts:
        return "Module"
    return "".join(p[:1].upper() + p[1:] for p in parts)


def _camel_case(name: str) -> str:
    pc = _pascal_case(name)
    return pc[:1].lower() + pc[1:] if pc else "module"


def derive_target_file_path(framework_schema: Dict[str, Any], module_name: str) -> str:
    """
    Derive a relative path (relative to framework_path) where the generated
    code should be saved, based on the framework's detected layout.
    """
    tech = framework_schema.get("tech_stack") or {}
    lang = tech.get("language") or ""
    layout = framework_schema.get("directory_layout") or {}
    test_root = (layout.get("test_root") or "").strip().strip("/\\")

    if lang == "python":
        fname = f"test_{_slugify(module_name)}.py"
    elif lang == "java":
        fname = f"{_pascal_case(module_name)}Test.java"
    elif lang == "csharp":
        fname = f"{_pascal_case(module_name)}Tests.cs"
    elif lang in ("javascript", "typescript"):
        ext = "ts" if lang == "typescript" else "js"
        # Detect spec vs test from naming_conventions
        pattern = (framework_schema.get("naming_conventions") or {}).get("test_file_pattern", "")
        marker = "spec" if "spec" in pattern.lower() else "test"
        fname = f"{_camel_case(module_name)}.{marker}.{ext}"
    else:
        fname = f"{_slugify(module_name)}.txt"

    if test_root and test_root not in (".", ""):
        return os.path.join(test_root, fname).replace("\\", "/")
    return fname


# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Prompt construction
# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def _compact_framework_schema(schema: Dict[str, Any], char_budget: int) -> Tuple[str, Optional[str]]:
    """
    Render the framework schema as compact human-readable text the LLM can
    follow. We drop fields the LLM doesn't need (raw path, counts) and trim
    long snippets if needed.

    Returns (text, warning). `warning` is set when the rendered profile
    exceeds char_budget and had to be truncated.
    """
    tech = schema.get("tech_stack") or {}
    layout = schema.get("directory_layout") or {}
    naming = schema.get("naming_conventions") or {}

    parts: List[str] = []
    parts.append("FRAMEWORK PROFILE")
    parts.append(f"- language: {tech.get('language', 'unknown')}")
    parts.append(f"- test_framework: {tech.get('test_framework', 'unknown')}")
    parts.append(f"- build_tool: {tech.get('build_tool', 'unknown')}")
    parts.append(f"- test_root: {layout.get('test_root') or '(unknown)'}")
    parts.append(f"- page_objects_root: {layout.get('page_objects_root') or '(none)'}")
    parts.append(f"- test_file_pattern: {naming.get('test_file_pattern') or '(unknown)'}")

    imports = schema.get("import_patterns") or []
    if imports:
        parts.append("\nIMPORT PATTERNS (mimic these):")
        for line in imports[:12]:
            parts.append(f"  {line}")

    base_classes = schema.get("base_classes") or []
    if base_classes:
        parts.append("\nBASE CLASSES (extend / use as parent where appropriate):")
        for bc in base_classes[:3]:
            parts.append(f"- {bc.get('name')} (file: {bc.get('file')})")
            snippet = (bc.get("snippet") or "").strip()
            if snippet:
                parts.append("```")
                parts.append(snippet[:800])
                parts.append("```")

    page_objects = schema.get("page_objects") or []
    if page_objects:
        parts.append("\nPAGE OBJECTS (call these – do not invent UI element lookups):")
        for po in page_objects[:6]:
            methods = po.get("methods") or []
            method_str = ", ".join(methods[:10]) if methods else "(no public methods detected)"
            parts.append(f"- {po.get('name')} (file: {po.get('file')}) -> {method_str}")
            snippet = (po.get("snippet") or "").strip()
            if snippet:
                parts.append(f"  [source excerpt]")
                parts.append("  ```")
                parts.append(snippet[:300])
                parts.append("  ```")

    code_samples = schema.get("code_samples") or []
    if code_samples:
        parts.append("\nEXISTING TEST SAMPLES (replicate this style):")
        for cs in code_samples[:2]:
            parts.append(f"# {cs.get('file')}")
            parts.append("```")
            parts.append((cs.get("snippet") or "").strip()[:1000])
            parts.append("```")

    text = "\n".join(parts)
    original_len = len(text)
    if original_len > char_budget:
        text = text[:char_budget] + "\n[... framework profile truncated ...]"
        warning = (
            f"Framework profile truncated from {original_len} to {char_budget} chars "
            f"to fit provider budget. Generated code may miss patterns from later sections "
            f"(page objects, code samples). Consider switching to a higher-context provider "
            f"or reducing framework scope."
        )
        return text, warning
    return text, None


def _compact_test_cases(test_cases: List[Dict[str, Any]]) -> str:
    return _compact_test_cases_budgeted(test_cases)[0]


def _to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _clip(text: str, max_len: int) -> str:
    if max_len <= 0:
        return ""
    s = _to_text(text)
    if len(s) <= max_len:
        return s
    if max_len <= 3:
        return s[:max_len]
    return s[: max_len - 3].rstrip() + "..."


def _render_test_cases_by_detail(test_cases: List[Dict[str, Any]], detail_level: int) -> str:
    """
    detail_level:
      0 = rich detail
      1 = reduced detail (drop most data/preconditions)
      2 = skeletal steps
      3 = id+title only
    """
    lines: List[str] = ["TEST CASES TO IMPLEMENT (one method per case):"]

    for i, tc in enumerate(test_cases, 1):
        if not isinstance(tc, dict):
            continue
        tcid = _to_text(tc.get("testCaseId")) or f"TC-{i:03d}"
        title = _to_text(tc.get("testCaseTitle"))
        ext = _to_text(tc.get("toolTicketId"))
        priority = _to_text(tc.get("priority"))
        ttype = _to_text(tc.get("testType"))
        pre = _to_text(tc.get("preconditions"))
        td = _to_text(tc.get("testData"))
        exp = _to_text(tc.get("expectedResult"))

        if detail_level == 0:
            title = _clip(title, 160)
            pre = _clip(pre, 220)
            td = _clip(td, 220)
            exp = _clip(exp, 220)
            max_steps = 10
            action_max = 220
            expected_max = 220
            step_data_max = 120
        elif detail_level == 1:
            title = _clip(title, 120)
            pre = ""
            td = ""
            exp = _clip(exp, 140)
            max_steps = 6
            action_max = 140
            expected_max = 120
            step_data_max = 0
        elif detail_level == 2:
            title = _clip(title, 90)
            pre = ""
            td = ""
            exp = ""
            max_steps = 3
            action_max = 90
            expected_max = 70
            step_data_max = 0
        else:
            title = _clip(title, 72)
            pre = ""
            td = ""
            exp = ""
            max_steps = 0
            action_max = 0
            expected_max = 0
            step_data_max = 0

        header = f"\n[{i}] {tcid}: {title}"
        if ext:
            header += f"  (ExternalRef: {ext})"
        lines.append(header)

        if detail_level <= 1 and (priority or ttype):
            lines.append(f"    priority={priority or 'N/A'} | type={ttype or 'N/A'}")
        if pre:
            lines.append(f"    preconditions: {pre}")
        if td:
            lines.append(f"    testData: {td}")

        steps = tc.get("testSteps") or []
        if max_steps > 0 and steps:
            lines.append("    steps:")
            emitted = 0
            for step in steps:
                if emitted >= max_steps or not isinstance(step, dict):
                    continue
                n = _to_text(step.get("stepNumber")) or str(emitted + 1)
                action = _clip(_to_text(step.get("action")), action_max)
                expected = _clip(_to_text(step.get("expected")), expected_max)
                step_data = _clip(_to_text(step.get("testData")), step_data_max)
                line = f"      {n}. action: {action}"
                if expected:
                    line += f" | expected: {expected}"
                if step_data and step_data != "N/A":
                    line += f" | data: {step_data}"
                lines.append(line)
                emitted += 1
        if exp:
            lines.append(f"    overall_expected: {exp}")

    return "\n".join(lines)


def _compact_test_cases_budgeted(
    test_cases: List[Dict[str, Any]],
    char_budget: int = 3000,
    min_detail_level: int = 0,
) -> Tuple[str, Optional[str]]:
    """Fit test-case section within budget by lowering detail before truncating."""
    budget = max(char_budget, 600)
    start_level = max(0, min(min_detail_level, 3))
    selected_text = ""
    selected_level = start_level
    for level in range(start_level, 4):
        candidate = _render_test_cases_by_detail(test_cases, level)
        if len(candidate) <= budget:
            selected_text = candidate
            selected_level = level
            break
        selected_text = candidate
        selected_level = level

    warning_parts: List[str] = []
    if selected_level > start_level:
        warning_parts.append(
            f"Test cases compressed from detail level {start_level} to {selected_level} to fit provider budget."
        )
    if len(selected_text) > budget:
        selected_text = selected_text[:budget] + "\n[... test cases truncated ...]"
        warning_parts.append(
            "Test case section still exceeded budget and was hard-truncated."
        )
    warning = " ".join(warning_parts) if warning_parts else None
    return selected_text, warning


def _annotation_hint(language: str, test_framework: str) -> str:
    """
    Tell the LLM how to render the traceability annotations in this language.
    We pick a conventional shape; the LLM may adapt if the framework uses
    something different.
    """
    lang = (language or "").lower()
    tf = (test_framework or "").lower()
    if lang == "python":
        return ('Use pytest markers: `@pytest.mark.test_case_id("TC-001")` and '
                '`@pytest.mark.external_ref("SCRUM-2")` above each test function.')
    if lang == "java":
        return ('Use annotations on the test method: `@Tag("TC-001")` and '
                '`@Tag("ext:SCRUM-2")`. If the framework already uses custom '
                'annotations like `@TestCaseId`, prefer those.')
    if lang == "csharp":
        return ('Use `[TestProperty("TestCaseId", "TC-001")]` and '
                '`[TestProperty("ExternalRef", "SCRUM-2")]` attributes.')
    if lang in ("javascript", "typescript"):
        if "jest" in tf or "mocha" in tf:
            return ('Embed the IDs in the test name: `test("[TC-001][SCRUM-2] '
                    'title", ...)`. The IDs must be present in the test title '
                    'so reporters can extract them.')
        return ('Embed the IDs in the test name string, e.g. '
                '`test("[TC-001][SCRUM-2] title", ...)`.')
    return ('Mark each test method with the test case ID and external ref in a '
            'way that fits the framework idiom (annotation, comment header, or '
            'test name prefix).')


def _build_user_prompt(framework_schema: Dict[str, Any],
                       group: Dict[str, Any],
                       refinement_instruction: Optional[str],
                       provider: str,
                       detail_level: int = 0,
                       prompt_budget: Optional[int] = None) -> Tuple[str, Optional[str]]:
    budget = prompt_budget or PROVIDER_PROMPT_BUDGET.get(provider, 50000)
    warnings: List[str] = []
    glue_overhead = 2200
    min_framework_budget = 1200
    max_test_cases_budget = max(budget - glue_overhead - min_framework_budget, 900)

    test_cases_text, tc_warning = _compact_test_cases_budgeted(
        group.get("test_cases") or [],
        char_budget=max_test_cases_budget,
        min_detail_level=detail_level,
    )
    if tc_warning:
        warnings.append(tc_warning)

    framework_budget = max(budget - len(test_cases_text) - glue_overhead, min_framework_budget)
    framework_text, fw_warning = _compact_framework_schema(framework_schema, framework_budget)
    if fw_warning:
        warnings.append(fw_warning)

    tech = framework_schema.get("tech_stack") or {}
    policy = framework_schema.get("generation_policy") or {}
    annotation_hint = _annotation_hint(tech.get("language", ""), tech.get("test_framework", ""))

    module_name = group.get("module", "Module")
    target_path = derive_target_file_path(framework_schema, module_name)

    refinement_block = ""
    if refinement_instruction:
        refinement_block = f"\n\nADDITIONAL USER INSTRUCTION:\n{refinement_instruction.strip()}\n"

    prompt = (
        f"{framework_text}\n\n"
        f"GENERATION POLICY (must follow):\n{json.dumps(policy, ensure_ascii=True)}\n\n"
        f"TARGET FILE: {target_path}\n"
        f"TARGET MODULE / TEST CLASS: {module_name}\n\n"
        f"ANNOTATION RULE:\n{annotation_hint}\n\n"
        f"{test_cases_text}\n"
        f"{refinement_block}\n"
        "Return JSON with this exact shape:\n"
        "{\n"
        '  "test_file": {"path": "relative/path", "content": "full source"},\n'
        '  "page_files": [{"path":"relative/path","content":"full source","change_summary":"short summary"}],\n'
        '  "impacted_test_files": [{"path":"relative/path","content":"full source","change_summary":"short summary"}],\n'
        '  "warnings": ["optional warning strings"]\n'
        "}\n"
        "Always include test_file. Use page_files/impacted_test_files when needed."
    )
    return prompt, (" ".join(warnings) if warnings else None)


# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# LLM dispatch for raw (non-JSON) code output
# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def _call_ollama_text(endpoint: str, model: str, messages: list) -> str:
    """Ollama call without `format: json` so we get raw code back."""
    resp = _request_with_retry(
        requests.post,
        f"{endpoint.rstrip('/')}/api/chat",
        json={"model": model or "llama3", "messages": messages, "stream": False},
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()["message"]["content"]


def _call_openrouter_text(api_key: str, model: str, messages: list) -> str:
    """OpenRouter call without response_format=json_object."""
    resp = _request_with_retry(
        requests.post,
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/otsi-smart-qa",
            "X-Title": "TestPulse AI-OTSI",
        },
        json={
            "model": model or "google/gemini-pro-1.5",
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 8192,
        },
        timeout=180,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _dispatch(provider: str, api_key: str, model: str, endpoint: str,
              messages: list, groq_max_tokens: Optional[int] = None) -> str:
    if provider == "GROQ":
        max_tokens = groq_max_tokens if groq_max_tokens is not None else 1200
        return _call_groq(api_key, model, messages, max_tokens=max_tokens)
    if provider == "Grok":
        return _call_grok(api_key, model, messages)
    if provider in ("Claude", "Anthropic"):
        return _call_claude(api_key, model, messages)
    if provider == "Ollama":
        return _call_ollama_text(endpoint, model, messages)
    if provider == "OpenRouter":
        return _call_openrouter_text(api_key, model, messages)
    raise ValueError(f"Unsupported LLM provider: {provider}")


# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Code post-processing
# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

_FENCE_OPEN_RE = re.compile(r"^\s*```[a-zA-Z0-9_+\-]*\s*\n")
_FENCE_CLOSE_RE = re.compile(r"\n\s*```\s*$")


def _strip_markdown_fences(text: str) -> str:
    """LLMs often wrap code in ```lang ... ``` despite instructions. Strip it."""
    if not text:
        return ""
    s = text.strip()
    # Strip a single leading fence + matching trailing fence if present
    open_match = _FENCE_OPEN_RE.match(s)
    if open_match:
        s = s[open_match.end():]
        close_match = _FENCE_CLOSE_RE.search(s)
        if close_match:
            s = s[:close_match.start()]
    return s.rstrip() + "\n"


def _first_nonempty_code(*values: Any) -> str:
    """
    Return the first non-empty code/text candidate after fence stripping.
    """
    for value in values:
        if value is None:
            continue
        candidate = _strip_markdown_fences(str(value))
        if candidate.strip():
            return candidate
    return ""


def _extract_first_json_object(text: str) -> Optional[Dict[str, Any]]:
    """
    Best-effort extraction of first JSON object from model output.
    Accepts plain JSON or prose with an embedded JSON object.
    """
    if not text:
        return None
    s = text.strip()
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = s[start:end + 1]
    try:
        obj = json.loads(candidate)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _normalize_path(path: str) -> str:
    return (path or "").strip().replace("\\", "/").lstrip("/")


def _default_page_path(framework_schema: Dict[str, Any], module_name: str) -> str:
    layout = framework_schema.get("directory_layout") or {}
    pages_root = (layout.get("page_objects_root") or "").strip().strip("/\\")
    fname = f"{_pascal_case(module_name)}Page"
    language = ((framework_schema.get("tech_stack") or {}).get("language") or "").lower()
    ext = {
        "python": ".py",
        "java": ".java",
        "csharp": ".cs",
        "javascript": ".js",
        "typescript": ".ts",
    }.get(language, ".txt")
    rel = f"{fname}{ext}"
    return f"{pages_root}/{rel}".replace("//", "/") if pages_root else rel


def _normalize_plan(
    framework_schema: Dict[str, Any],
    group: Dict[str, Any],
    raw_text: str,
) -> Dict[str, Any]:
    """
    Convert model output into normalized multi-file plan.
    Falls back to single-file script format when JSON is not parseable.
    """
    module_name = group.get("module", "Module")
    default_test_path = derive_target_file_path(framework_schema, module_name)
    parsed = _extract_first_json_object(raw_text)
    if not parsed:
        return {
            "test_file": {
                "path": default_test_path,
                "content": _strip_markdown_fences(raw_text),
            },
            "page_files": [],
            "impacted_test_files": [],
            "warnings": ["LLM returned non-JSON output; fell back to single-file parsing."],
        }

    test_file = parsed.get("test_file") if isinstance(parsed.get("test_file"), dict) else {}
    test_path = _normalize_path(test_file.get("path") or default_test_path)
    test_content = _first_nonempty_code(
        test_file.get("content"),
        test_file.get("generated_code"),
        test_file.get("generatedCode"),
        test_file.get("code"),
        test_file.get("source"),
        test_file.get("script"),
    )

    page_files: List[Dict[str, str]] = []
    for item in parsed.get("page_files") or []:
        if not isinstance(item, dict):
            continue
        p = _normalize_path(item.get("path") or _default_page_path(framework_schema, module_name))
        c = _strip_markdown_fences(str(item.get("content") or ""))
        if not c.strip():
            continue
        page_files.append({
            "path": p,
            "content": c,
            "change_summary": str(item.get("change_summary") or "Updated page object methods for generated tests."),
        })

    impacted: List[Dict[str, str]] = []
    for item in parsed.get("impacted_test_files") or []:
        if not isinstance(item, dict):
            continue
        p = _normalize_path(item.get("path") or "")
        c = _strip_markdown_fences(str(item.get("content") or ""))
        if not p or not c.strip():
            continue
        impacted.append({
            "path": p,
            "content": c,
            "change_summary": str(item.get("change_summary") or "Updated dependent test usage after page method changes."),
        })

    warnings = [str(w) for w in (parsed.get("warnings") or []) if str(w).strip()]
    if not test_content.strip():
        # Some models put primary test content into impacted_test_files.
        promoted = next((i for i in impacted if i.get("path") == test_path and (i.get("content") or "").strip()), None)
        if promoted is None:
            promoted = next((i for i in impacted if (i.get("content") or "").strip()), None)
        if promoted:
            test_path = _normalize_path(promoted.get("path") or test_path or default_test_path)
            test_content = _strip_markdown_fences(str(promoted.get("content") or ""))
            warnings.append("Primary test content missing in test_file; promoted from impacted_test_files.")

    if not test_content.strip():
        test_content = _first_nonempty_code(
            parsed.get("generated_code"),
            parsed.get("generatedCode"),
            parsed.get("code"),
            parsed.get("source"),
            parsed.get("script"),
            raw_text,
        )
        warnings.append("JSON output missing test_file.content; used fallback output field/raw output.")
    return {
        "test_file": {"path": test_path, "content": test_content},
        "page_files": page_files,
        "impacted_test_files": impacted,
        "warnings": warnings,
    }


def _safe_read_existing(framework_root: str, rel_path: str) -> str:
    rel = _normalize_path(rel_path)
    if not framework_root or not rel:
        return ""
    abs_path = os.path.realpath(os.path.abspath(os.path.join(framework_root, rel)))
    root_abs = os.path.realpath(os.path.abspath(framework_root))
    try:
        common = os.path.commonpath([root_abs, abs_path])
    except ValueError:
        return ""
    if common != root_abs or not os.path.isfile(abs_path):
        return ""
    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _method_names(content: str) -> List[str]:
    names = re.findall(r"\b(?:public|private|protected|internal)?\s*(?:async\s+)?[A-Za-z_][\w<>\[\],\s]*\s+([A-Za-z_]\w*)\s*\(", content)
    seen: List[str] = []
    for n in names:
        if n not in seen:
            seen.append(n)
    return seen


def _build_diff_summary(old_text: str, new_text: str) -> str:
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    add = max(0, len(new_lines) - len(old_lines))
    rem = max(0, len(old_lines) - len(new_lines))
    new_methods = set(_method_names(new_text))
    old_methods = set(_method_names(old_text))
    added_methods = sorted(new_methods - old_methods)
    removed_methods = sorted(old_methods - new_methods)
    parts = [f"+{add}/-{rem} lines"]
    if added_methods:
        parts.append(f"added methods: {', '.join(added_methods[:4])}")
    if removed_methods:
        parts.append(f"removed methods: {', '.join(removed_methods[:4])}")
    return "; ".join(parts)


def _compose_changed_files(
    framework_schema: Dict[str, Any],
    plan: Dict[str, Any],
) -> List[Dict[str, Any]]:
    root = framework_schema.get("framework_path") or ""
    changed: List[Dict[str, Any]] = []

    def add_file(path: str, content: str, file_kind: str, summary: str) -> None:
        rel = _normalize_path(path)
        if not rel or not content.strip():
            return
        old = _safe_read_existing(root, rel)
        old_lines = old.splitlines(keepends=True)
        new_lines = content.splitlines(keepends=True)
        diff = "".join(
            difflib.unified_diff(
                old_lines,
                new_lines,
                fromfile=f"a/{rel}",
                tofile=f"b/{rel}",
                lineterm="",
            )
        )
        changed.append(
            {
                "path": rel,
                "content": content,
                "file_kind": file_kind,
                "change_type": "update" if old else "create",
                "diff_unified": diff,
                "diff_summary": summary or _build_diff_summary(old, content),
            }
        )

    tf = plan.get("test_file") or {}
    add_file(
        tf.get("path") or "",
        tf.get("content") or "",
        "test",
        "Generated/updated target test class.",
    )
    for p in plan.get("page_files") or []:
        add_file(
            p.get("path") or "",
            p.get("content") or "",
            "page",
            p.get("change_summary") or "Updated page object methods/locators.",
        )
    for p in plan.get("impacted_test_files") or []:
        add_file(
            p.get("path") or "",
            p.get("content") or "",
            "test",
            p.get("change_summary") or "Updated dependent tests for signature alignment.",
        )
    return changed


# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Public entry
# â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def generate_script_for_group(
    framework_schema: Dict[str, Any],
    group: Dict[str, Any],
    llm_config: Dict[str, Any],
    refinement_instruction: Optional[str] = None,
    config_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Generate test-script source code for a single module group.
    Args:
        framework_schema: output of analyze_framework()
        group: { "module": str, "test_cases": [tc, ...] }
        llm_config: { "llmProvider", "llmApiKey", "llmModel", "llmEndpoint" }
        refinement_instruction: optional extra instruction to steer regeneration
    Returns:
        {
          "module": str,
          "generated_code": str,
          "target_file_path": str,      # relative to framework_path
          "language": str,
          "source_test_case_ids": [str, ...],
        }
    """
    if not isinstance(framework_schema, dict) or not framework_schema:
        raise ValueError("framework_schema is required and must be a dict")
    if not isinstance(group, dict) or not group.get("test_cases"):
        raise ValueError("group must be a dict containing non-empty test_cases")
    if not isinstance(llm_config, dict):
        raise ValueError("llm_config is required and must be a dict")
    provider = (llm_config.get("llmProvider") or "GROQ").strip()
    api_key = llm_config.get("llmApiKey") or ""
    model = (llm_config.get("llmModel") or "").strip() or None
    endpoint = llm_config.get("llmEndpoint") or "http://127.0.0.1:11434"
    if provider != "Ollama" and not api_key:
        raise ValueError(f"llmApiKey is required for provider {provider}")
    module_name = group.get("module", "Module")
    test_cases = group.get("test_cases") or []
    source_ids = [tc.get("testCaseId", "") for tc in test_cases if isinstance(tc, dict)]
    language = (framework_schema.get("tech_stack") or {}).get("language", "")
    max_payload = PROVIDER_PAYLOAD_BUDGET.get(provider, 400000)
    policy = framework_schema.get("generation_policy") or {}
    max_repairs = int((policy.get("validation") or {}).get("auto_repair_retries", 2) or 2)
    max_repairs = max(0, min(max_repairs, 2))

    warnings: List[str] = []
    last_plan: Optional[Dict[str, Any]] = None
    last_validation: Dict[str, Any] = {"passed": True, "violations": [], "warnings": []}
    repair_instruction: Optional[str] = None

    def _dispatch_once(active_messages: List[Dict[str, str]], active_prompt: str) -> str:
        payload_chars = _payload_chars(active_messages)
        print(f"[ScriptGen] provider={provider} module={module_name!r} "
              f"cases={len(test_cases)} prompt={len(active_prompt)} chars "
              f"payload={payload_chars} chars")
        groq_max_tokens = None
        if provider == "GROQ":
            groq_max_tokens = _groq_safe_max_tokens(active_messages, model or "")
            print(
                f"[ScriptGen] GROQ token budget: prompt~{_estimate_message_tokens(active_messages)} "
                f"max_tokens={groq_max_tokens}"
            )
        try:
            return _dispatch(
                provider, api_key, model or "", endpoint, active_messages,
                groq_max_tokens=groq_max_tokens,
            )
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response is not None else "?"
            body_excerpt = ""
            if e.response is not None:
                try:
                    body_excerpt = e.response.text[:400]
                except Exception:
                    body_excerpt = ""
            suggestion = _suggest_alternate_model(provider, model or "")
            hint = f" {suggestion}" if suggestion else ""
            raise RuntimeError(
                f"{provider} script generation failed: HTTP {status} - {str(e)[:200]}"
                f"{(' Body: ' + body_excerpt) if body_excerpt else ''}{hint}"
            )
        except Exception as e:
            raise RuntimeError(f"{provider} script generation failed: {str(e)[:220]}")

    for attempt in range(max_repairs + 1):
        detail_level = 0
        active_prompt_budget = PROVIDER_PROMPT_BUDGET.get(provider, 50000)
        attempt_refinement = refinement_instruction
        if repair_instruction:
            attempt_refinement = ((attempt_refinement or "") + "\n\n" + repair_instruction).strip()

        user_prompt, truncation_warning = _build_user_prompt(
            framework_schema,
            group,
            attempt_refinement,
            provider,
            detail_level=detail_level,
            prompt_budget=active_prompt_budget,
        )
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]
        payload_chars = _payload_chars(messages)
        while payload_chars > max_payload and detail_level < 3:
            detail_level += 1
            active_prompt_budget = max(int(active_prompt_budget * 0.75), 2200)
            user_prompt, truncation_warning = _build_user_prompt(
                framework_schema,
                group,
                attempt_refinement,
                provider,
                detail_level=detail_level,
                prompt_budget=active_prompt_budget,
            )
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ]
            payload_chars = _payload_chars(messages)
            print(
                f"[ScriptGen] Payload guard applied. detail={detail_level} "
                f"prompt_budget={active_prompt_budget} payload={payload_chars}"
            )
        messages, fit_warning = _fit_messages_to_payload_limit(SYSTEM_PROMPT, user_prompt, max_payload)
        if truncation_warning:
            warnings.append(truncation_warning)
        if fit_warning:
            warnings.append(fit_warning)
        user_prompt = messages[1]["content"]
        raw = _dispatch_once(messages, user_prompt)
        plan = _normalize_plan(framework_schema, group, raw)
        primary_content = _strip_markdown_fences(str((plan.get("test_file") or {}).get("content") or ""))
        if not primary_content.strip():
            if attempt < max_repairs:
                repair_instruction = (
                    "The previous response did not include non-empty test_file.content. "
                    "Return full JSON with test_file.path and a non-empty compile-ready test_file.content."
                )
                print(f"[ScriptGen] repair attempt {attempt + 1}/{max_repairs} for module={module_name!r} (empty test_file.content)")
                continue
            raise RuntimeError(f"{provider} returned empty test file content for module {module_name!r}")
        changed_files = _compose_changed_files(framework_schema, plan)
        validation = validate_generation(framework_schema, group, changed_files)
        last_plan = plan
        last_validation = validation
        warnings.extend(plan.get("warnings") or [])
        warnings.extend(validation.get("warnings") or [])
        if validation.get("passed"):
            break

        if attempt < max_repairs:
            violations = validation.get("violations") or []
            violation_lines = []
            for v in violations:
                violation_lines.append(
                    f"- [{v.get('code')}] file={v.get('file')}: {v.get('message')}"
                )
            repair_instruction = (
                "Repair the generated files to satisfy these validator findings and regenerate full JSON plan:\n"
                + "\n".join(violation_lines)
            )
            print(f"[ScriptGen] repair attempt {attempt + 1}/{max_repairs} for module={module_name!r}")

    if not last_plan:
        raise RuntimeError(f"{provider} returned empty content for module {module_name!r}")

    changed_files = _compose_changed_files(framework_schema, last_plan)
    test_file = (last_plan.get("test_file") or {})
    code = _strip_markdown_fences(str(test_file.get("content") or ""))
    target_path = _normalize_path(str(test_file.get("path") or derive_target_file_path(framework_schema, module_name)))
    if not code.strip():
        raise RuntimeError(f"{provider} returned empty test file content for module {module_name!r}")
    warning_text = " ".join([w for w in warnings if str(w).strip()]) or None
    return {
        "module": module_name,
        "generated_code": code,
        "target_file_path": target_path,
        "language": language,
        "source_test_case_ids": source_ids,
        "warning": warning_text,
        "changed_files": changed_files,
        "validation_report": last_validation,
    }

