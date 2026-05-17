"""
Script policy validator for generated automation artifacts.

This module performs deterministic checks against framework policy inferred by
framework_analyzer. It is intentionally heuristic-based and best-effort: it
returns warnings when confidence is low instead of hard-stopping generation.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List


SELECTOR_RE = re.compile(
    r"\bBy\.(?:XPath|CssSelector|Id|Name|ClassName|LinkText|PartialLinkText)\s*\(",
    re.IGNORECASE,
)


def _expected_step_count(group: Dict[str, Any]) -> int:
    total = 0
    for tc in group.get("test_cases") or []:
        if not isinstance(tc, dict):
            continue
        steps = tc.get("testSteps")
        if isinstance(steps, list):
            total += sum(1 for s in steps if isinstance(s, dict))
    return total


def _contains_required_attributes(content: str, attrs: List[str]) -> List[str]:
    missing: List[str] = []
    for attr in attrs:
        token = (attr or "").strip()
        if not token:
            continue
        if token not in content:
            missing.append(token)
    return missing


def _count_reporter_info_calls(content: str, info_patterns: List[str]) -> int:
    if not info_patterns:
        info_patterns = [".Info("]
    count = 0
    for pat in info_patterns:
        token = (pat or "").strip()
        if not token:
            continue
        count += content.count(token)
    return count


def validate_generation(
    framework_schema: Dict[str, Any],
    group: Dict[str, Any],
    changed_files: List[Dict[str, Any]],
) -> Dict[str, Any]:
    policy = (framework_schema or {}).get("generation_policy") or {}
    required_attrs = policy.get("required_test_class_attributes") or []
    info_patterns = ((policy.get("reporter") or {}).get("info_call_patterns")) or [".Info("]
    disallow_selectors_in_tests = bool((policy.get("selector_ownership") or {}).get("disallow_in_tests", True))

    violations: List[Dict[str, str]] = []
    warnings: List[str] = []

    step_count = _expected_step_count(group)
    test_files = [f for f in changed_files if (f.get("file_kind") or "") == "test"]
    if not test_files and changed_files:
        test_files = changed_files[:1]

    for f in test_files:
        rel = f.get("path") or "(unknown)"
        content = f.get("content") or ""

        missing_attrs = _contains_required_attributes(content, required_attrs)
        if missing_attrs:
            violations.append(
                {
                    "severity": "warning",
                    "code": "MISSING_REQUIRED_ATTRIBUTES",
                    "file": rel,
                    "message": f"Missing required class attributes: {', '.join(missing_attrs)}",
                }
            )

        if disallow_selectors_in_tests and SELECTOR_RE.search(content):
            violations.append(
                {
                    "severity": "warning",
                    "code": "HARDCODED_SELECTOR_IN_TEST",
                    "file": rel,
                    "message": "Detected locator construction in test file. Move selectors to page objects.",
                }
            )

        info_calls = _count_reporter_info_calls(content, info_patterns)
        if step_count > 0 and info_calls < step_count:
            violations.append(
                {
                    "severity": "warning",
                    "code": "INSUFFICIENT_REPORTER_INFO_LOGS",
                    "file": rel,
                    "message": (
                        f"Reporter Info logging appears incomplete: expected about {step_count}, "
                        f"found {info_calls}."
                    ),
                }
            )

    if not required_attrs:
        warnings.append("No dominant class-attribute pattern detected. Attribute validation downgraded to warning-only mode.")

    return {
        "passed": len(violations) == 0,
        "violations": violations,
        "warnings": warnings,
    }

