"""
Curated MCP server catalog for test automation frameworks.

Maps detected tech stack to recommended MCP server descriptors.
Servers already discovered in project config files are excluded by name.
{framework_path} in args is substituted with the actual framework root at call time.
"""
from __future__ import annotations

from typing import Any, Dict, List, Set


_CATALOG: List[Dict[str, Any]] = [
    # Official Microsoft Playwright MCP
    {
        "triggers": {"test_framework": ["playwright"]},
        "server": {
            "name": "playwright",
            "command": "npx",
            "args": ["@playwright/mcp@latest", "--headless"],
            "transport": "stdio",
            "source_file": "catalog",
            "env": {},
            "enabled": True,
            "description": "Official Microsoft Playwright MCP — live browser automation and DOM inspection during script generation",
            "catalog_source": True,
        },
    },
    # Filesystem MCP — JS/TS projects
    {
        "triggers": {"language": ["javascript", "typescript"]},
        "server": {
            "name": "filesystem",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem@latest", "{framework_path}"],
            "transport": "stdio",
            "source_file": "catalog",
            "env": {},
            "enabled": True,
            "description": "MCP Filesystem — read and write test files and page objects inside the framework directory",
            "catalog_source": True,
        },
    },
    # Filesystem MCP — Python projects
    {
        "triggers": {"language": ["python"]},
        "server": {
            "name": "filesystem",
            "command": "uvx",
            "args": ["mcp-server-filesystem", "{framework_path}"],
            "transport": "stdio",
            "source_file": "catalog",
            "env": {},
            "enabled": True,
            "description": "MCP Filesystem — read and write test files and page objects inside the framework directory",
            "catalog_source": True,
        },
    },
    # Filesystem MCP — Java / C# projects
    {
        "triggers": {"language": ["java", "csharp", "c#"]},
        "server": {
            "name": "filesystem",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem@latest", "{framework_path}"],
            "transport": "stdio",
            "source_file": "catalog",
            "env": {},
            "enabled": True,
            "description": "MCP Filesystem — read and write test files and page objects inside the framework directory",
            "catalog_source": True,
        },
    },
    # Fetch MCP — non-Playwright web testing frameworks
    {
        "triggers": {
            "test_framework": ["selenium", "cypress", "webdriverio", "testcafe", "puppeteer", "nightwatch"],
        },
        "server": {
            "name": "fetch",
            "command": "uvx",
            "args": ["mcp-server-fetch"],
            "transport": "stdio",
            "source_file": "catalog",
            "env": {},
            "enabled": True,
            "description": "MCP Fetch — inspect live URLs and REST API responses referenced in test scenarios",
            "catalog_source": True,
        },
    },
]


def recommend_mcp_servers(
    framework_path: str,
    tech_stack: Dict[str, Any],
    discovered_names: Set[str],
) -> List[Dict[str, Any]]:
    """Return catalog-based MCP recommendations for a given tech stack.

    Servers whose names are in discovered_names are excluded (already configured).
    """
    seen_names: Set[str] = set(discovered_names)
    result: List[Dict[str, Any]] = []

    def _norm(v: Any) -> str:
        return str(v or "").lower().strip()

    stack_values = {k: _norm(v) for k, v in (tech_stack or {}).items()}

    for entry in _CATALOG:
        triggers: Dict[str, List[str]] = entry.get("triggers") or {}
        matched = any(
            any(kw in stack_values.get(field, "") for kw in keywords)
            for field, keywords in triggers.items()
        )
        if not matched:
            continue

        template = entry["server"]
        name: str = template["name"]

        if name in seen_names:
            continue
        seen_names.add(name)

        resolved_args = [
            a.replace("{framework_path}", framework_path)
            for a in (template.get("args") or [])
        ]
        result.append({**template, "args": resolved_args})

    # Fallback: if tech stack matched nothing, expose full catalog so users
    # always see available MCPs even when framework detection is incomplete.
    if not result:
        seen_names_fallback: Set[str] = set(discovered_names)
        for entry in _CATALOG:
            template = entry["server"]
            name = template["name"]
            if name in seen_names_fallback:
                continue
            seen_names_fallback.add(name)
            resolved_args = [
                a.replace("{framework_path}", framework_path)
                for a in (template.get("args") or [])
            ]
            result.append({**template, "args": resolved_args})

    return result
