"""
Synchronous stdio MCP client for test script generation.

Implements minimal JSON-RPC 2.0 over subprocess stdin/stdout so callers
that run in a threadpool (no running event loop) can use MCP servers without
any asyncio machinery.

Public surface:
    MCPSession                  — low-level per-server handle
    start_mcp_servers(...)      — start multiple servers, return {name: session}
    stop_mcp_servers(...)       — stop all sessions cleanly
    get_all_tools_for_llm(...)  — convert MCP schemas to OpenAI/Anthropic format
    execute_tool_call(...)      — dispatch a namespaced tool call
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from typing import Any, Dict, List, Optional, Tuple


class MCPSession:
    """Single stdio MCP server process with synchronous JSON-RPC communication."""

    def __init__(self, descriptor: Dict[str, Any], timeout: int = 10) -> None:
        self.name: str = descriptor.get("name", "unknown")
        self.command: str = descriptor.get("command", "")
        self.args: List[str] = descriptor.get("args") or []
        self.env_extra: Dict[str, str] = descriptor.get("env") or {}
        self.timeout: int = timeout
        self._proc: Optional[subprocess.Popen] = None
        self._req_id: int = 0
        self._lock = threading.Lock()
        self.tools: List[Dict[str, Any]] = []

    # ── internal JSON-RPC helpers ──────────────────────────────────────────────

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _send(self, obj: dict) -> None:
        line = json.dumps(obj, ensure_ascii=False) + "\n"
        assert self._proc and self._proc.stdin
        self._proc.stdin.write(line.encode("utf-8"))
        self._proc.stdin.flush()

    def _recv(self) -> dict:
        assert self._proc and self._proc.stdout
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError(f"MCP server {self.name!r} closed stdout unexpectedly")
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            return {}
        return json.loads(text)

    def _request(self, method: str, params: Optional[dict] = None) -> dict:
        """Send a JSON-RPC request and return the matching response."""
        req_id = self._next_id()
        msg: dict = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        with self._lock:
            self._send(msg)
            # Skip notifications/server-push messages until we see our id
            for _ in range(40):
                resp = self._recv()
                if not resp:
                    continue
                if resp.get("id") == req_id:
                    return resp
        raise RuntimeError(
            f"MCP server {self.name!r} did not respond to {method!r} (id={req_id})"
        )

    # ── lifecycle ──────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Spawn the server process, initialize the MCP session, list tools."""
        env = os.environ.copy()
        env.update(self.env_extra)
        cmd = [self.command] + self.args
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        resp = self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-gen-mcp", "version": "1.0"},
        })
        if "error" in resp:
            raise RuntimeError(
                f"MCP initialize failed for {self.name!r}: {resp['error']}"
            )

        # Acknowledge initialization (notification — no id, no response expected)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        resp = self._request("tools/list", {})
        if "error" in resp:
            raise RuntimeError(
                f"MCP tools/list failed for {self.name!r}: {resp['error']}"
            )
        self.tools = (resp.get("result") or {}).get("tools") or []

    def stop(self) -> None:
        """Terminate the server process."""
        if not self._proc:
            return
        try:
            self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._proc = None

    # ── tool call ─────────────────────────────────────────────────────────────

    def call_tool(self, name: str, arguments: dict) -> str:
        """Call a tool and return its text result."""
        resp = self._request("tools/call", {"name": name, "arguments": arguments})
        if "error" in resp:
            raise RuntimeError(f"MCP tool {name!r} error: {resp['error']}")
        result = resp.get("result") or {}
        content = result.get("content") or []
        parts: List[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype == "text":
                parts.append(str(block.get("text") or ""))
            elif btype == "image":
                parts.append(f"[image:{block.get('mimeType','binary')}]")
            elif btype == "resource":
                parts.append(f"[resource:{block.get('uri','unknown')}]")
        return "\n".join(parts) if parts else json.dumps(result)


# ── module-level helpers ──────────────────────────────────────────────────────

_TOOL_NAME_SEP = "__"


def _namespaced(server_name: str, tool_name: str) -> str:
    return f"{server_name}{_TOOL_NAME_SEP}{tool_name}"


def start_mcp_servers(
    descriptors: List[Dict[str, Any]],
    timeout: int = 10,
) -> Dict[str, MCPSession]:
    """Start MCP servers for each enabled descriptor.

    Returns {name: session} only for servers that started successfully.
    Failures are logged but do not raise.
    """
    sessions: Dict[str, MCPSession] = {}
    for desc in descriptors:
        if not desc.get("enabled", True):
            continue
        name = desc.get("name", "")
        if not name:
            continue
        session = MCPSession(desc, timeout=timeout)
        try:
            session.start()
            sessions[name] = session
            print(f"[MCP] Started {name!r} — {len(session.tools)} tool(s)")
        except Exception as exc:
            print(f"[MCP] Failed to start {name!r}: {exc}")
    return sessions


def stop_mcp_servers(sessions: Dict[str, MCPSession]) -> None:
    """Stop all MCP sessions."""
    for name, session in sessions.items():
        try:
            session.stop()
            print(f"[MCP] Stopped {name!r}")
        except Exception as exc:
            print(f"[MCP] Error stopping {name!r}: {exc}")


def get_all_tools_for_llm(
    sessions: Dict[str, MCPSession],
    provider: str = "openai",
) -> List[Dict[str, Any]]:
    """Convert all MCP tool schemas to LLM-ready tool definitions.

    provider="claude"  → Anthropic format  (name, description, input_schema)
    provider=anything  → OpenAI format     (type, function: {name, description, parameters})
    Tool names are namespaced as  server__tool  to disambiguate across servers.
    """
    tools: List[Dict[str, Any]] = []
    for server_name, session in sessions.items():
        for tool in session.tools:
            raw_name = tool.get("name", "")
            ns_name = _namespaced(server_name, raw_name)
            description = tool.get("description") or f"{raw_name} (from {server_name})"
            schema = tool.get("inputSchema") or {"type": "object", "properties": {}}

            if provider in ("Claude", "Anthropic"):
                tools.append({
                    "name": ns_name,
                    "description": description,
                    "input_schema": schema,
                })
            else:
                tools.append({
                    "type": "function",
                    "function": {
                        "name": ns_name,
                        "description": description,
                        "parameters": schema,
                    },
                })
    return tools


def execute_tool_call(
    sessions: Dict[str, MCPSession],
    namespaced_name: str,
    arguments: dict,
) -> str:
    """Dispatch a namespaced tool call to the correct MCP session.

    namespaced_name format: "server_name__tool_name"
    """
    if _TOOL_NAME_SEP not in namespaced_name:
        raise ValueError(
            f"Invalid tool name {namespaced_name!r} — expected 'server{_TOOL_NAME_SEP}tool'"
        )
    server_name, tool_name = namespaced_name.split(_TOOL_NAME_SEP, 1)
    session = sessions.get(server_name)
    if not session:
        raise ValueError(
            f"MCP server {server_name!r} is not running. "
            f"Available: {list(sessions.keys())}"
        )
    return session.call_tool(tool_name, arguments)


def check_mcp_server(
    descriptor: Dict[str, Any],
    timeout: int = 10,
) -> Tuple[bool, List[str], str]:
    """Probe a single MCP server: start, list tools, stop.

    Returns (ok, tool_names, error_message).
    """
    session = MCPSession(descriptor, timeout=timeout)
    try:
        session.start()
        tool_names = [t.get("name", "") for t in session.tools]
        session.stop()
        return True, tool_names, ""
    except Exception as exc:
        try:
            session.stop()
        except Exception:
            pass
        return False, [], str(exc)[:300]
