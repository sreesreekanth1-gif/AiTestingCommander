"""
MCP Server Discovery

Scans a test automation framework directory for MCP (Model Context Protocol)
server configurations.  Returns a list of server descriptors that the backend
can later spawn via stdio transport during test-script generation.

Discovery locations (checked in order):
    1. {root}/mcp.json
    2. {root}/.mcp/config.json
    3. {root}/.cursor/mcp.json
    4. {root}/.vscode/mcp.json
    5. {root}/package.json → "mcpServers" key

Each discovered server produces a dict:
    {
        "name":        "playwright",
        "command":     "npx",
        "args":        ["@playwright/mcp@latest"],
        "transport":   "stdio",
        "source_file": "mcp.json",
        "env":         {},
        "enabled":     True,
    }

Public surface:
    discover_mcp_servers(framework_path: str) -> list[dict]
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional


# Config file candidates, relative to the framework root, in priority order.
_CONFIG_CANDIDATES = [
    "mcp.json",
    os.path.join(".mcp", "config.json"),
    os.path.join(".cursor", "mcp.json"),
    os.path.join(".vscode", "mcp.json"),
]


def _safe_read_json(path: str) -> Optional[Dict[str, Any]]:
    """Read and parse a JSON file, returning None on any failure."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError, ValueError):
        pass
    return None


def _extract_servers_from_config(
    data: Dict[str, Any],
    source_file: str,
) -> List[Dict[str, Any]]:
    """
    Extract MCP server definitions from a parsed config object.

    Supports two key formats:
        - "mcpServers": { "name": { "command": ..., "args": [...] } }
        - "servers":    { "name": { "command": ..., "args": [...] } }
    """
    servers: List[Dict[str, Any]] = []

    # Try both common top-level keys
    for key in ("mcpServers", "servers"):
        block = data.get(key)
        if not isinstance(block, dict):
            continue
        for name, entry in block.items():
            if not isinstance(entry, dict):
                continue
            command = (entry.get("command") or "").strip()
            if not command:
                continue  # A server without a command is unusable for stdio

            args = entry.get("args") or []
            if not isinstance(args, list):
                args = [str(args)]
            args = [str(a) for a in args]

            env = entry.get("env") or {}
            if not isinstance(env, dict):
                env = {}
            env = {str(k): str(v) for k, v in env.items()}

            servers.append({
                "name": str(name).strip(),
                "command": command,
                "args": args,
                "transport": "stdio",
                "source_file": source_file,
                "env": env,
                "enabled": True,
            })

    return servers


def _extract_from_package_json(
    data: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Extract MCP servers from a package.json file (under 'mcpServers' key)."""
    return _extract_servers_from_config(data, "package.json")


def discover_mcp_servers(framework_path: str) -> List[Dict[str, Any]]:
    """
    Scan a framework directory for MCP server configurations.

    Returns a (possibly empty) list of server descriptors.  Each descriptor
    has enough information for the backend to spawn the server via stdio at
    generation time.

    This function performs only local file reads — no network calls, no
    process spawning.
    """
    if not framework_path:
        return []

    root = os.path.realpath(os.path.abspath(framework_path))
    if not os.path.isdir(root):
        return []

    seen_names: set = set()
    result: List[Dict[str, Any]] = []

    def _add_unique(servers: List[Dict[str, Any]]) -> None:
        for srv in servers:
            name = srv.get("name", "")
            if name and name not in seen_names:
                seen_names.add(name)
                result.append(srv)

    # 1. Check dedicated MCP config files
    for rel in _CONFIG_CANDIDATES:
        path = os.path.join(root, rel)
        data = _safe_read_json(path)
        if data is not None:
            _add_unique(_extract_servers_from_config(data, rel))

    # 2. Check package.json for embedded mcpServers
    pkg_path = os.path.join(root, "package.json")
    pkg_data = _safe_read_json(pkg_path)
    if pkg_data is not None:
        _add_unique(_extract_from_package_json(pkg_data))

    return result
