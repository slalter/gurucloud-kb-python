"""Ask the bank step by step: the client half of ``kb.ask`` (kanban b3cb2a1b).

The service runs one model turn per ``POST /banks/{kb}/ask/step`` and hands
back the tool calls the model wants; the CLIENT executes them against the
bank's ordinary routes (search, entry + connections, graph) and posts the
outputs back. The shapes built here are the shapes the model's tool
descriptions promise (kb_service/ask_agent.py) and are the same ones the
Explorer's Ask tab builds in JavaScript (ui/js/ask_model.js), so a run looks
identical whichever client drove it.

Pure helpers only: no HTTP here, so they are testable without a server.
"""
from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

TOOL_SEARCH = "search_knowledge_bank"
TOOL_READ = "read_entry"
TOOL_WALK = "walk_graph"
DEFAULT_K = 8
MAX_K = 20
MAX_WALK_DEPTH = 3
WALK_NODE_LIMIT = 80
CONTENT_MAX_CHARS = 6000
SEARCH_CONTENT_MAX_CHARS = 800  # per search row: k=10 must fit the service's search cap (read_entry has the full text)


def start_body(
    question: str,
    *,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    max_steps: Optional[int] = None,
    requested_by: Optional[str] = None,
) -> dict[str, Any]:
    q = (question or "").strip()
    if not q:
        raise ValueError("question must not be empty")
    body: dict[str, Any] = {"question": q}
    for key, value in (("model", model), ("reasoning_effort", reasoning_effort), ("max_steps", max_steps), ("requested_by", requested_by)):
        if value is not None:
            body[key] = value
    return body


def continue_body(run_id: str, previous_response_id: str, tool_outputs: list[dict[str, Any]]) -> dict[str, Any]:
    if not run_id or not previous_response_id:
        raise ValueError("run_id and previous_response_id are required to continue a run")
    return {"run_id": run_id, "previous_response_id": previous_response_id, "tool_outputs": list(tool_outputs)}


def _short(text: Any, n: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _label(e: Mapping[str, Any]) -> str:
    md = _mapping(e.get("metadata"))
    return _short(md.get("summary") or e.get("summary") or e.get("useful_for") or e.get("text") or e.get("snippet") or e.get("content") or "", 200)


# ── tool arguments -> request parameters ────────────────────────────────────

def search_k(arguments: Mapping[str, Any]) -> int:
    try:
        k = int(arguments.get("k") or DEFAULT_K)
    except (TypeError, ValueError):
        k = DEFAULT_K
    return max(1, min(MAX_K, k))


def walk_params(arguments: Mapping[str, Any]) -> dict[str, Any]:
    root = str(arguments.get("root") or "").strip()
    if len(root) < 4:
        raise ValueError("walk_graph needs a root entry id (4+ characters)")
    try:
        depth = int(arguments.get("depth") or 1)
    except (TypeError, ValueError):
        depth = 1
    return {"root": root, "depth": max(1, min(MAX_WALK_DEPTH, depth)), "limit": WALK_NODE_LIMIT}


def entry_id_of(arguments: Mapping[str, Any]) -> str:
    entry_id = str(arguments.get("entry_id") or arguments.get("id") or "").strip()
    if len(entry_id) < 4:
        raise ValueError("read_entry needs an entry id (4+ characters)")
    return entry_id


# ── API responses -> what the model reads ───────────────────────────────────

def compact_pointer(p: Mapping[str, Any]) -> dict[str, Any]:
    """One `related` pointer the way the hosted query tool prints it."""
    out: dict[str, Any] = {"id": p.get("id"), "relation": p.get("relation") or "connected", "direction": p.get("direction") or "outgoing"}
    if p.get("via"):
        out["via"] = p["via"]
    if p.get("text"):
        out["text"] = p["text"]
    if p.get("score"):
        out["score"] = p["score"]
    if p.get("note"):
        out["note"] = p["note"]
    if p.get("kind") and p.get("kind") != "folded":
        out["kind"] = p["kind"]
    return out


def search_output(results: Any) -> dict[str, Any]:
    """``{results, collapse}``: ranked rows with compact pointers plus the
    collapse summary (groups / folded / neighbors)."""
    rows_in = results.get("results") if isinstance(results, Mapping) else results
    rows: list[dict[str, Any]] = []
    for i, r in enumerate(rows_in or []):
        md = _mapping(r.get("metadata"))
        row: dict[str, Any] = {
            "rank": i + 1, "id": r.get("id"), "score": round(float(r.get("combined_score") or 0), 4),
            "useful_for": r.get("useful_for") or "", "content": _short(r.get("content") or "", SEARCH_CONTENT_MAX_CHARS),
        }
        if md.get("summary"):
            row["summary"] = md["summary"]
        related = [compact_pointer(p) for p in (r.get("related") or [])]
        if related:
            row["related"] = related
        if r.get("related_truncated"):
            row["related_truncated"] = int(r["related_truncated"])
        rows.append(row)
    pointers = [p for row in rows for p in row.get("related", [])]
    neighbors = [p for p in pointers if p.get("kind") == "neighbor"]
    folded = len(pointers) - len(neighbors) + sum(int(row.get("related_truncated") or 0) for row in rows)
    groups = sum(1 for row in rows if any(p.get("kind") != "neighbor" for p in row.get("related", [])))
    return {"results": rows, "collapse": {"groups": groups, "folded": folded, "neighbors": len(neighbors)}}


def _connection(edge: Mapping[str, Any], direction: str) -> dict[str, Any]:
    other = _mapping(edge.get("other"))
    out: dict[str, Any] = {
        "id": other.get("id") or (edge.get("to_entry_id") if direction == "outgoing" else edge.get("from_entry_id")),
        "relation": edge.get("edge_type") or "connected", "direction": direction, "text": _label(other),
    }
    if edge.get("note"):
        out["note"] = edge["note"]
    if other.get("kind") == "playbook_step":
        out["kind"] = "playbook_step"
        out["playbook"] = other.get("playbook_slug")
        out["step"] = other.get("step_key")
    return out


def entry_output(entry: Mapping[str, Any], connections: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    """The entry in full plus its typed connections with the other ends' text and the edge notes."""
    md = _mapping(entry.get("metadata"))
    meta = {k: v for k, v in md.items() if isinstance(v, (str, int, float, bool)) or (isinstance(v, list) and len(v) <= 20)}
    conns: list[dict[str, Any]] = []
    conn_map = _mapping(connections)
    for direction in ("outgoing", "incoming"):
        for edge in conn_map.get(direction) or []:
            conns.append(_connection(_mapping(edge), direction))
    return {
        "id": entry.get("id"), "content": _short(entry.get("content") or "", CONTENT_MAX_CHARS), "useful_for": entry.get("useful_for") or "",
        "summary": md.get("summary") or "", "relevant_systems": entry.get("relevant_systems") or [], "relevant_tasks": entry.get("relevant_tasks") or [],
        "metadata": meta, "created_at": entry.get("created_at"), "connections": conns,
    }


def walk_output(graph: Mapping[str, Any]) -> dict[str, Any]:
    """The neighbourhood as the model reads it: nodes with depth and text, edges with relation and note."""
    nodes: list[dict[str, Any]] = []
    for raw_node in graph.get("nodes") or []:
        n = _mapping(raw_node)
        node: dict[str, Any] = {"id": n.get("id"), "depth": n.get("depth", 0), "text": _label(n)}
        if n.get("kind") == "playbook_step":
            node["kind"] = "playbook_step"
            node["text"] = f"step {n.get('playbook_slug')}/{n.get('step_key')}"
        nodes.append(node)
    edges: list[dict[str, Any]] = []
    for raw_edge in graph.get("edges") or []:
        e = _mapping(raw_edge)
        edge: dict[str, Any] = {"from": e.get("from_entry_id"), "to": e.get("to_entry_id") or e.get("to_step_key"), "relation": e.get("edge_type")}
        if e.get("note"):
            edge["note"] = e["note"]
        edges.append(edge)
    return {"root": graph.get("root"), "depth": graph.get("depth"), "truncated": bool(graph.get("truncated")), "nodes": nodes, "edges": edges}


# ── the loop ────────────────────────────────────────────────────────────────

ToolExecutor = Callable[[str, Mapping[str, Any]], Any]


def execute_tool(name: str, arguments: Mapping[str, Any], *, search: Callable[..., Any], get_entry: Callable[[str], Any],
                 connections: Callable[[str], Any], graph: Callable[..., Any]) -> Any:
    """Run one tool call through the bank's ordinary read methods and shape
    the result for the model; raises ValueError for arguments the tool
    cannot use and for a tool it was never given."""
    if name == TOOL_SEARCH:
        query = str(arguments.get("query") or "").strip()
        if not query:
            raise ValueError("search_knowledge_bank needs a query")
        return search_output(search(query, k=search_k(arguments), threshold=0.0, collapse=True))
    if name == TOOL_READ:
        entry_id = entry_id_of(arguments)
        entry = get_entry(entry_id)
        try:
            conns = connections(str(entry.get("id") or entry_id))
        except Exception:  # noqa: BLE001 - connections are a bonus; the entry itself is the answer
            conns = None
        return entry_output(entry, conns)
    if name == TOOL_WALK:
        params = walk_params(arguments)
        return walk_output(graph(params["root"], depth=params["depth"], limit=params["limit"]))
    raise ValueError(f"unknown tool: {name}")


def tool_output_item(call: Mapping[str, Any], output: Any = None, *, error: Optional[str] = None, duration_ms: Optional[float] = None) -> dict[str, Any]:
    item: dict[str, Any] = {"call_id": call.get("call_id"), "name": call.get("name"), "output": None if error else output}
    if error:
        item["error"] = error[:2000]
    if duration_ms is not None:
        item["duration_ms"] = duration_ms
    return item
