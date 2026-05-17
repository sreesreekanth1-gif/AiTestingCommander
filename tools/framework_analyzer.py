"""
Framework Analyzer

Scans a local test-automation framework directory and produces an optimized
JSON schema describing the framework so an LLM can generate scripts that match
the user's existing patterns (base classes, page objects, naming, imports).

Tech stack detection: Python / Java / C# / JavaScript / TypeScript.
Heuristics only — no AST parsing, no third-party deps beyond stdlib.

Path safety: callers must validate paths before passing to `analyze_framework`.
This module does not police the filesystem; it walks whatever path it receives.

Public surface:
    analyze_framework(framework_path: str, max_files: int = 800) -> dict
    safe_resolve_under_root(root: str, candidate: str) -> str
"""

from __future__ import annotations

import os
import re
from collections import Counter
from typing import Any, Dict, List, Optional


# File extensions for each supported language
LANG_EXTENSIONS = {
    "python": {".py"},
    "java": {".java"},
    "csharp": {".cs"},
    "javascript": {".js", ".jsx"},
    "typescript": {".ts", ".tsx"},
}

# Directory names to skip during walk (noise / generated / vendor)
SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "venv", ".venv", "env", ".env",
    "__pycache__", ".pytest_cache", ".mypy_cache", "build", "dist", "target",
    "bin", "obj", "out", ".idea", ".vscode", "coverage", "htmlcov",
    ".tox", ".gradle", "site-packages",
}

# File size caps to avoid pulling in giant generated files
MAX_FILE_BYTES = 200_000
MAX_SNIPPET_CHARS = 1500


def safe_resolve_under_root(root: str, candidate: str) -> str:
    """
    Resolve candidate path against root and assert it stays under root.
    Rejects traversal (..), absolute escapes, and symlink jumps.

    Returns the resolved absolute path on success. Raises ValueError on escape.
    """
    if not root or not candidate:
        raise ValueError("Both root and candidate paths are required")

    root_abs = os.path.realpath(os.path.abspath(root))
    if not os.path.isdir(root_abs):
        raise ValueError(f"Root directory does not exist or is not a directory: {root}")

    # Treat candidate as relative to root if not absolute
    if os.path.isabs(candidate):
        target = candidate
    else:
        target = os.path.join(root_abs, candidate)

    target_abs = os.path.realpath(os.path.abspath(target))

    # commonpath raises on different drives (Windows) — wrap to ValueError
    try:
        common = os.path.commonpath([root_abs, target_abs])
    except ValueError:
        raise ValueError(f"Path '{candidate}' escapes framework root")

    if common != root_abs:
        raise ValueError(f"Path '{candidate}' escapes framework root")

    return target_abs


def _detect_language(file_counts: Counter) -> Optional[str]:
    """Pick the dominant language based on file extension counts."""
    scores: Dict[str, int] = {}
    for lang, exts in LANG_EXTENSIONS.items():
        scores[lang] = sum(file_counts.get(ext, 0) for ext in exts)
    if not scores or max(scores.values()) == 0:
        return None
    return max(scores, key=scores.get)


def _detect_test_framework(language: str, root: str, sampled_contents: str) -> str:
    """Identify the test framework (pytest, junit, jest, etc.) from markers."""
    text = sampled_contents.lower()

    if language == "python":
        if os.path.exists(os.path.join(root, "pytest.ini")) or "import pytest" in text or "@pytest." in text:
            return "pytest"
        if os.path.exists(os.path.join(root, "conftest.py")):
            return "pytest"
        if "unittest.testcase" in text or "import unittest" in text:
            return "unittest"
        if "import robot" in text or "*** test cases ***" in text:
            return "robot"
        return "pytest"  # most common default

    if language == "java":
        if "org.testng" in text or "@test(" in text and "testng" in text:
            return "testng"
        if "org.junit.jupiter" in text or "@beforeeach" in text:
            return "junit5"
        if "org.junit" in text or "@before" in text:
            return "junit4"
        return "junit5"

    if language == "csharp":
        if "xunit" in text or "[fact]" in text:
            return "xunit"
        if "nunit" in text or "[testfixture]" in text:
            return "nunit"
        if "mstest" in text or "[testclass]" in text:
            return "mstest"
        return "nunit"

    if language in ("javascript", "typescript"):
        if "@playwright/test" in text or "playwright" in text:
            return "playwright"
        if "cypress" in text:
            return "cypress"
        if "@wdio" in text or "webdriverio" in text:
            return "webdriverio"
        if "jest" in text or "describe(" in text and "expect(" in text:
            return "jest"
        if "mocha" in text:
            return "mocha"
        return "playwright"

    return "unknown"


def _detect_build_tool(language: str, root: str) -> str:
    """Identify build / dependency manager from manifest files at root."""
    if language == "python":
        if os.path.exists(os.path.join(root, "pyproject.toml")):
            return "poetry-or-pip"
        if os.path.exists(os.path.join(root, "requirements.txt")):
            return "pip"
        return "pip"
    if language == "java":
        if os.path.exists(os.path.join(root, "pom.xml")):
            return "maven"
        if os.path.exists(os.path.join(root, "build.gradle")) or os.path.exists(os.path.join(root, "build.gradle.kts")):
            return "gradle"
        return "maven"
    if language == "csharp":
        for f in os.listdir(root):
            if f.endswith(".csproj") or f.endswith(".sln"):
                return "dotnet"
        return "dotnet"
    if language in ("javascript", "typescript"):
        if os.path.exists(os.path.join(root, "yarn.lock")):
            return "yarn"
        if os.path.exists(os.path.join(root, "pnpm-lock.yaml")):
            return "pnpm"
        return "npm"
    return "unknown"


def _walk_source_files(root: str, language: str, max_files: int) -> List[str]:
    """Walk the framework directory and return source file paths (capped)."""
    exts = LANG_EXTENSIONS.get(language, set())
    results: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if any(fn.endswith(ext) for ext in exts):
                full = os.path.join(dirpath, fn)
                try:
                    if os.path.getsize(full) <= MAX_FILE_BYTES:
                        results.append(full)
                        if len(results) >= max_files:
                            return results
                except OSError:
                    continue
    return results


def _read_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _is_test_file(path: str, language: str, content: str) -> bool:
    """Heuristic check: does this file look like a test (vs. page object / util)?"""
    fname = os.path.basename(path).lower()
    if language == "python":
        return fname.startswith("test_") or fname.endswith("_test.py") or "@pytest" in content or "unittest.TestCase" in content
    if language == "java":
        return fname.endswith("test.java") or fname.endswith("tests.java") or "@Test" in content
    if language == "csharp":
        return fname.endswith("test.cs") or fname.endswith("tests.cs") or "[Test]" in content or "[Fact]" in content
    if language in ("javascript", "typescript"):
        return ".test." in fname or ".spec." in fname or "describe(" in content
    return False


def _is_page_object_file(path: str, content: str) -> bool:
    """Heuristic: looks like a page object (POM pattern)."""
    p = path.lower()
    if "/pages/" in p.replace("\\", "/") or "/page_objects/" in p.replace("\\", "/") or "/pageobjects/" in p.replace("\\", "/"):
        return True
    fname = os.path.basename(path).lower()
    if fname.endswith("page.py") or fname.endswith("page.java") or fname.endswith("page.cs") or fname.endswith("page.ts") or fname.endswith("page.js"):
        return True
    return False


def _extract_class_names(content: str, language: str) -> List[str]:
    """Pull class names out of source text."""
    if language == "python":
        return re.findall(r"^class\s+([A-Za-z_]\w*)\s*[:\(]", content, re.MULTILINE)
    if language in ("java", "csharp"):
        return re.findall(r"\bclass\s+([A-Za-z_]\w*)", content)
    if language in ("javascript", "typescript"):
        return re.findall(r"\bclass\s+([A-Za-z_]\w*)", content)
    return []


def _extract_methods(content: str, language: str) -> List[str]:
    """Pull function/method names out of source text."""
    if language == "python":
        return re.findall(r"^\s*def\s+([A-Za-z_]\w*)\s*\(", content, re.MULTILINE)
    if language == "java":
        return re.findall(r"public\s+\w[\w<>\[\]]*\s+([A-Za-z_]\w*)\s*\(", content)
    if language == "csharp":
        return re.findall(r"public\s+\w[\w<>\[\]]*\s+([A-Za-z_]\w*)\s*\(", content)
    if language in ("javascript", "typescript"):
        return re.findall(r"(?:async\s+)?(?:function\s+|(?<=\s))([A-Za-z_]\w*)\s*\(", content)
    return []


def _extract_imports(content: str, language: str) -> List[str]:
    """Pull first ~10 import statements (verbatim) for the LLM to mimic."""
    lines: List[str] = []
    if language == "python":
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("import ") or stripped.startswith("from "):
                lines.append(stripped)
    elif language == "java":
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("import "):
                lines.append(stripped)
    elif language == "csharp":
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("using "):
                lines.append(stripped)
    elif language in ("javascript", "typescript"):
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("import ") or stripped.startswith("const ") and "require(" in stripped:
                lines.append(stripped)
    return lines[:10]


def _looks_like_base_class(name: str, content_around: str, language: str) -> bool:
    """Detect base classes — `BaseTest`, abstract classes, test helpers."""
    if "Base" in name and ("Test" in name or "Page" in name or "Spec" in name):
        return True
    if name.startswith("Abstract"):
        return True
    if language == "python" and re.search(rf"class\s+{re.escape(name)}\s*\(.*TestCase.*\)", content_around):
        return True
    if language == "java" and re.search(rf"abstract\s+class\s+{re.escape(name)}", content_around):
        return True
    return False


def _trim_snippet(text: str, max_chars: int = MAX_SNIPPET_CHARS) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n... [truncated]"


def _extract_csharp_class_attributes(content: str) -> List[List[str]]:
    """
    Capture attribute blocks above class declarations in C# files.
    Returns list of attribute-line groups in encounter order.
    """
    lines = content.splitlines()
    groups: List[List[str]] = []
    i = 0
    while i < len(lines):
        if "class " not in lines[i]:
            i += 1
            continue
        j = i - 1
        attrs: List[str] = []
        while j >= 0:
            s = lines[j].strip()
            if not s:
                j -= 1
                continue
            if s.startswith("[") and s.endswith("]"):
                attrs.insert(0, s)
                j -= 1
                continue
            break
        if attrs:
            groups.append(attrs)
        i += 1
    return groups


def _infer_generation_policy(
    root: str,
    language: str,
    test_files: List[str],
    page_object_files: List[str],
) -> Dict[str, Any]:
    required_test_class_attributes: List[str] = []
    category_template = ""
    reporter_patterns: List[str] = []
    selector_roots: List[str] = []
    confidence: Dict[str, float] = {}
    warnings: List[str] = []

    if language == "csharp":
        attr_combo_counter: Counter = Counter()
        attr_line_counter: Counter = Counter()
        cat_line_counter: Counter = Counter()
        for path in test_files[:25]:
            content = _read_file(path)
            for group in _extract_csharp_class_attributes(content):
                key = "\n".join(group)
                attr_combo_counter[key] += 1
                for line in group:
                    attr_line_counter[line] += 1
                    if "Category(" in line:
                        cat_line_counter[line] += 1
        if attr_combo_counter:
            dominant_block, count = attr_combo_counter.most_common(1)[0]
            required_test_class_attributes = [ln.strip() for ln in dominant_block.split("\n") if ln.strip()]
            confidence["required_test_class_attributes"] = min(1.0, count / max(1, len(test_files[:25])))
        else:
            confidence["required_test_class_attributes"] = 0.0
            warnings.append("Could not infer dominant C# class attributes from test files.")

        if cat_line_counter:
            category_template = cat_line_counter.most_common(1)[0][0]
            confidence["category_template"] = 0.9
        else:
            confidence["category_template"] = 0.0

        info_counter: Counter = Counter()
        for path in (test_files + page_object_files)[:50]:
            content = _read_file(path)
            for m in re.findall(r"\.\s*Info\s*\(", content):
                info_counter[".Info("] += 1
            for m in re.findall(r"\bInfo\s*\(", content):
                info_counter["Info("] += 1
        reporter_patterns = [pat for pat, _ in info_counter.most_common(2)] or [".Info("]
        confidence["reporter_pattern"] = 0.8 if info_counter else 0.3
    else:
        reporter_patterns = [".info(", ".Info("]
        confidence["required_test_class_attributes"] = 0.2
        confidence["category_template"] = 0.2
        confidence["reporter_pattern"] = 0.2
        warnings.append("Non-C# framework policy inference is currently heuristic and may need refinement.")

    page_dirs = sorted({_relative(os.path.dirname(p), root) for p in page_object_files if p})
    for d in page_dirs:
        selector_roots.append(d)
    # Include sibling folders containing page-like names.
    sibling_candidates = set()
    for d in page_dirs:
        parent = os.path.dirname(d).replace("\\", "/")
        abs_parent = os.path.join(root, parent) if parent else root
        if not os.path.isdir(abs_parent):
            continue
        try:
            for entry in os.listdir(abs_parent):
                abs_entry = os.path.join(abs_parent, entry)
                if not os.path.isdir(abs_entry):
                    continue
                low = entry.lower()
                if "page" in low:
                    rel = _relative(abs_entry, root)
                    sibling_candidates.add(rel)
        except OSError:
            continue
    selector_roots.extend(sorted(sibling_candidates))
    selector_roots = sorted(set(selector_roots))

    return {
        "required_test_class_attributes": required_test_class_attributes,
        "category_attribute_template": category_template,
        "reporter": {
            "info_call_patterns": reporter_patterns,
            "log_each_step": True,
        },
        "selector_ownership": {
            "disallow_in_tests": True,
            "allowed_page_roots": selector_roots,
        },
        "validation": {
            "mode": "best_effort_warning",
            "auto_repair_retries": 2,
        },
        "confidence": confidence,
        "warnings": warnings,
    }


def _relative(path: str, root: str) -> str:
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except ValueError:
        return path


def analyze_framework(framework_path: str, max_files: int = 800) -> dict:
    """
    Scan a framework directory and return a JSON-serializable schema.

    The schema is designed to fit in an LLM prompt: tech stack, conventions,
    base classes, page objects, code samples, imports.
    """
    if not framework_path:
        raise ValueError("framework_path is required")

    root = os.path.realpath(os.path.abspath(framework_path))
    if not os.path.isdir(root):
        raise ValueError(f"Framework path is not a directory: {framework_path}")

    # First pass: count file extensions to detect language
    ext_counts: Counter = Counter()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            ext_counts[ext] += 1

    language = _detect_language(ext_counts)
    if language is None:
        raise ValueError(f"Could not detect a supported language under {root}. "
                         f"Supported: python, java, csharp, javascript, typescript.")

    # Walk source files for the detected language
    src_files = _walk_source_files(root, language, max_files)
    if not src_files:
        raise ValueError(f"No {language} source files found under {root}")

    # Categorize files
    test_files: List[str] = []
    page_object_files: List[str] = []
    other_files: List[str] = []

    sampled_text_for_framework_detection: List[str] = []
    for path in src_files[:120]:
        content = _read_file(path)
        sampled_text_for_framework_detection.append(content[:4000])
        if _is_page_object_file(path, content):
            page_object_files.append(path)
        elif _is_test_file(path, language, content):
            test_files.append(path)
        else:
            other_files.append(path)

    pooled_text = "\n".join(sampled_text_for_framework_detection)
    test_framework = _detect_test_framework(language, root, pooled_text)
    build_tool = _detect_build_tool(language, root)

    # Determine directory layout (most common parent directories of test/page files)
    def _common_parent(paths: List[str]) -> Optional[str]:
        if not paths:
            return None
        parents = Counter(_relative(os.path.dirname(p), root) for p in paths)
        most_common = parents.most_common(1)
        return most_common[0][0] if most_common else None

    test_root = _common_parent(test_files)
    pages_root = _common_parent(page_object_files)

    # Naming conventions (most common test file basename pattern)
    test_file_pattern = ""
    if test_files:
        bases = [os.path.basename(p) for p in test_files[:30]]
        if all(b.startswith("test_") for b in bases) and language == "python":
            test_file_pattern = "test_*.py"
        elif all(b.lower().endswith("test.java") for b in bases) and language == "java":
            test_file_pattern = "*Test.java"
        elif all((".test." in b.lower() or ".spec." in b.lower()) for b in bases):
            test_file_pattern = "*.test.* or *.spec.*"

    # Extract base classes — scan non-test files first (test helpers), then tests
    base_classes: List[dict] = []
    for path in other_files + test_files:
        if len(base_classes) >= 5:
            break
        content = _read_file(path)
        if not content:
            continue
        for cls in _extract_class_names(content, language):
            if _looks_like_base_class(cls, content, language):
                base_classes.append({
                    "name": cls,
                    "file": _relative(path, root),
                    "snippet": _trim_snippet(content),
                })
                if len(base_classes) >= 5:
                    break

    # Extract page objects (top ~8 by occurrence)
    page_objects: List[dict] = []
    for path in page_object_files[:8]:
        content = _read_file(path)
        if not content:
            continue
        classes = _extract_class_names(content, language)
        methods = _extract_methods(content, language)
        page_objects.append({
            "name": classes[0] if classes else os.path.splitext(os.path.basename(path))[0],
            "file": _relative(path, root),
            "methods": [m for m in methods if not m.startswith("_")][:15],
            "snippet": _trim_snippet(content, 800),
        })

    # Code samples — up to 3 representative test files
    code_samples: List[dict] = []
    for path in test_files[:3]:
        content = _read_file(path)
        if not content:
            continue
        code_samples.append({
            "name": os.path.splitext(os.path.basename(path))[0],
            "file": _relative(path, root),
            "snippet": _trim_snippet(content),
        })

    # Import patterns — aggregate from a few test files
    import_patterns: List[str] = []
    seen_imports = set()
    for path in test_files[:5]:
        content = _read_file(path)
        for line in _extract_imports(content, language):
            if line not in seen_imports:
                seen_imports.add(line)
                import_patterns.append(line)
            if len(import_patterns) >= 15:
                break
        if len(import_patterns) >= 15:
            break

    generation_policy = _infer_generation_policy(root, language, test_files, page_object_files)

    return {
        "framework_path": root,
        "tech_stack": {
            "language": language,
            "test_framework": test_framework,
            "build_tool": build_tool,
        },
        "directory_layout": {
            "test_root": test_root or "",
            "page_objects_root": pages_root or "",
        },
        "naming_conventions": {
            "test_file_pattern": test_file_pattern,
        },
        "base_classes": base_classes,
        "page_objects": page_objects,
        "code_samples": code_samples,
        "import_patterns": import_patterns,
        "counts": {
            "total_source_files": len(src_files),
            "test_files": len(test_files),
            "page_object_files": len(page_object_files),
        },
        "generation_policy": generation_policy,
    }
