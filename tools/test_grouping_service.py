"""
Test Grouping Service

Pure logic: groups normalized test cases by their `module` field. One module
group => one generated test class; one test case => one test method in it.

Deterministic fallback for missing/inconsistent module values:
    - Whitespace is stripped; comparison is case-insensitive
    - Empty / null / whitespace-only / "n/a" / "none" / "tbd" / "-"
      collapse into a single group named "Ungrouped"
    - Two cases whose modules differ only in casing/whitespace are merged
      under the first-seen canonical spelling (preserves human-readable name)

This module is intentionally pure (no LLM, no IO) so it can be unit tested.
"""

from __future__ import annotations

from typing import Any, Dict, List


FALLBACK_GROUP_NAME = "Ungrouped"
_EMPTY_MODULE_TOKENS = {"", "n/a", "na", "none", "null", "tbd", "-"}


def _normalize_module_key(raw: Any) -> str:
    """
    Produce a lookup key for grouping. Returns "" for cases that should fall
    into the Ungrouped bucket.
    """
    if raw is None:
        return ""
    s = str(raw).strip().lower()
    if s in _EMPTY_MODULE_TOKENS:
        return ""
    return s


def _canonical_display_name(raw: Any) -> str:
    """Trim whitespace but preserve original casing for display."""
    if raw is None:
        return FALLBACK_GROUP_NAME
    s = str(raw).strip()
    return s if s else FALLBACK_GROUP_NAME


def group_test_cases_by_module(test_cases: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Group the supplied normalized test cases by module.

    Input: list of test case dicts (must include `module`).
    Output: list of group dicts:
        [
          {
            "module": "Homepage Load & Hero Section",
            "test_cases": [<tc1>, <tc2>, ...]
          },
          ...
        ]

    Order: groups in first-seen order; Ungrouped (if present) always last.
    """
    if test_cases is None:
        return []

    buckets: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    for tc in test_cases:
        if not isinstance(tc, dict):
            continue
        raw_module = tc.get("module")
        key = _normalize_module_key(raw_module)

        if key == "":
            bucket_key = FALLBACK_GROUP_NAME
            display = FALLBACK_GROUP_NAME
        else:
            bucket_key = key
            display = _canonical_display_name(raw_module)

        if bucket_key not in buckets:
            buckets[bucket_key] = {"module": display, "test_cases": []}
            order.append(bucket_key)

        buckets[bucket_key]["test_cases"].append(tc)

    # Re-order: keep insertion order, but push Ungrouped to the end
    ordered = [buckets[k] for k in order if k != FALLBACK_GROUP_NAME]
    if FALLBACK_GROUP_NAME in buckets:
        ordered.append(buckets[FALLBACK_GROUP_NAME])
    return ordered


def grouping_preview(test_cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Lightweight preview for the UI confirmation step.

    Returns:
        {
          "total_cases": N,
          "total_groups": M,
          "groups": [
            {"module": "...", "case_count": k, "case_ids": ["TC-001", ...]}
          ]
        }
    """
    groups = group_test_cases_by_module(test_cases or [])
    return {
        "total_cases": sum(len(g["test_cases"]) for g in groups),
        "total_groups": len(groups),
        "groups": [
            {
                "module": g["module"],
                "case_count": len(g["test_cases"]),
                "case_ids": [tc.get("testCaseId", "") for tc in g["test_cases"]],
            }
            for g in groups
        ],
    }
