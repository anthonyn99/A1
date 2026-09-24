"""The Repository panel's reads, as MCP tools for the Claude CLI agent.

    python -I mcp_server.py --port 8000 --project proj_…

The Claude CLI starts this over stdio for one task (claude_cli.py passes
`--mcp-config`), so a Read task can "look at issue #12" or "say why the
deploy failed". It is deliberately thin and holds nothing:

  * **No token.** Every tool is an HTTP GET to the engine on 127.0.0.1 --
    the same /api/code/projects/<id>/repo/... routes the console uses -- and
    the engine answers as the project's GitHub account. The agent can only
    ever get what the panel shows.
  * **Pinned to one project.** The project id comes from the command line
    MAGI wrote, not from the agent; there is no tool argument that names a
    repository.
  * **Read-only.** There is no tool that writes, because there is no route
    that writes.
  * Stdlib only, run with `-I`: nothing from the workspace (a hostile
    `sitecustomize.py`, say) is importable into it.

The protocol is MCP's JSON-RPC over newline-delimited stdio: initialize,
tools/list, tools/call, ping. Small enough to write out rather than pull in
a dependency for.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL = "2025-06-18"
MAX_TEXT = 24000

TOOLS = [
    {"name": "github_overview",
     "description": "The GitHub repository this project's folder points at: description, default "
                    "branch, the local branch and how far it is from its upstream, and the latest "
                    "workflow runs on that branch.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "github_branches",
     "description": "Local branches with ahead/behind against their upstream, and the branches on GitHub.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "github_commits",
     "description": "Recent commits on GitHub for a branch, tag or SHA (default branch if omitted).",
     "inputSchema": {"type": "object", "properties": {"ref": {"type": "string"}}}},
    {"name": "github_issues",
     "description": "Issues (not pull requests), newest activity first.",
     "inputSchema": {"type": "object", "properties": {
         "state": {"type": "string", "enum": ["open", "closed", "all"]}}}},
    {"name": "github_issue",
     "description": "One issue with its body and recent comments.",
     "inputSchema": {"type": "object", "properties": {"number": {"type": "integer"}},
                     "required": ["number"]}},
    {"name": "github_pulls",
     "description": "Pull requests, newest activity first.",
     "inputSchema": {"type": "object", "properties": {
         "state": {"type": "string", "enum": ["open", "closed", "all"]}}}},
    {"name": "github_pull",
     "description": "One pull request with its description, size, and the checks on its head commit.",
     "inputSchema": {"type": "object", "properties": {"number": {"type": "integer"}},
                     "required": ["number"]}},
    {"name": "github_actions_runs",
     "description": "GitHub Actions workflow runs, for a branch or one commit SHA.",
     "inputSchema": {"type": "object", "properties": {
         "branch": {"type": "string"}, "sha": {"type": "string"}}}},
    {"name": "github_run_failure",
     "description": "One workflow run's jobs; for the first failed job, the failing step and the "
                    "end of its log (the lines that say why it failed).",
     "inputSchema": {"type": "object", "properties": {"run_id": {"type": "integer"}},
                     "required": ["run_id"]}},
]
for _t in TOOLS:
    _t["annotations"] = {"readOnlyHint": True, "openWorldHint": False}


def route(name: str, args: dict) -> tuple[str, dict]:
    """Tool call -> (path under /repo, query). Raises ValueError on bad input."""
    def num(k: str) -> int:
        v = args.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, str)) or not str(v).strip().isdigit():
            raise ValueError(f"'{k}' must be a positive whole number.")
        return int(v)

    def state() -> dict:
        s = args.get("state") or "open"
        return {"state": s if s in ("open", "closed", "all") else "open"}

    if name == "github_overview":
        return "", {}
    if name == "github_branches":
        return "/branches", {}
    if name == "github_commits":
        return "/commits", {"ref": str(args.get("ref") or "")[:200]}
    if name == "github_issues":
        return "/issues", state()
    if name == "github_issue":
        return f"/issues/{num('number')}", {}
    if name == "github_pulls":
        return "/pulls", state()
    if name == "github_pull":
        return f"/pulls/{num('number')}", {}
    if name == "github_actions_runs":
        return "/actions", {"branch": str(args.get("branch") or "")[:200],
                            "sha": str(args.get("sha") or "")[:40]}
    if name == "github_run_failure":
        return f"/actions/{num('run_id')}", {}
    raise ValueError(f"Unknown tool {name!r}.")


class Server:
    def __init__(self, port: int, project: str, opener=None):
        self.base = f"http://127.0.0.1:{int(port)}/api/code/projects/{urllib.parse.quote(project)}/repo"
        self._open = opener or urllib.request.urlopen

    def call(self, name: str, args: dict) -> tuple[str, bool]:
        try:
            path, q = route(name, args or {})
        except ValueError as e:
            return str(e), True
        q = {k: v for k, v in q.items() if v}
        url = self.base + path + ("?" + urllib.parse.urlencode(q) if q else "")
        try:
            with self._open(urllib.request.Request(url, headers={"Accept": "application/json"}),
                            timeout=40) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, OSError, ValueError) as e:
            return f"Could not reach the MAGI engine: {type(e).__name__}", True
        if not d.get("ok"):
            return d.get("message") or d.get("error") or "GitHub refused.", True
        d.pop("rate", None)
        text = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT] + "…(truncated)"
        return text, False

    def handle(self, msg: dict) -> dict | None:
        mid = msg.get("id")
        method = msg.get("method")
        if mid is None:
            return None                        # a notification: no reply
        if method == "initialize":
            ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": ver, "capabilities": {"tools": {}},
                "serverInfo": {"name": "magi-github", "version": "1"}}}
        if method == "ping":
            return {"jsonrpc": "2.0", "id": mid, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
        if method == "tools/call":
            p = msg.get("params") or {}
            text, err = self.call(str(p.get("name") or ""), p.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": text}], "isError": err}}
        return {"jsonrpc": "2.0", "id": mid,
                "error": {"code": -32601, "message": f"Method not found: {method}"}}

    def serve(self, fin=None, fout=None) -> None:
        fin = fin or sys.stdin
        fout = fout or sys.stdout
        for line in fin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            reply = self.handle(msg) if isinstance(msg, dict) else None
            if reply is not None:
                fout.write(json.dumps(reply) + "\n")
                fout.flush()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--project", required=True)
    a = ap.parse_args(argv)
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    Server(a.port, a.project).serve()


if __name__ == "__main__":
    main()
