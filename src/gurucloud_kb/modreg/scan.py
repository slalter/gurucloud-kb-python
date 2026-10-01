"""Export scanner + import fan-in ranking.

Generalised from ChemMasters' ``scripts/generate_shared_modules.py`` (PR #808)
but it never writes a manifest into the target repository: the output is the
automation's crawl inventory (``crawl_items`` rows) and, for a fresh agent, a
JSON report on stdout.

Candidate = a source file that either lives under a conventional shared path
(``services/shared``, ``utils``, ``hooks``, ``components/common``, CSS token
files, …) or is imported from ``fan_in_threshold`` or more other files. Fan-in
is computed with per-language regexes over the whole tree; it ranks
candidates, it does not decide anything — the agent reads the file.
"""
from __future__ import annotations

import ast
import json
import re
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Optional

DEFAULT_SHARED_PATTERNS: tuple[str, ...] = (
    r"(^|/)services/shared/", r"(^|/)shared/", r"(^|/)utils?/", r"(^|/)helpers?/",
    r"(^|/)lib/", r"(^|/)common/", r"(^|/)hooks/", r"(^|/)components/common/",
    r"(^|/)clients?/", r"(^|/)static/css/.*tokens.*\.css$", r"(^|/)prompts/.*_section\.py$",
)
# Import fan-in needed for a file OUTSIDE the shared paths to become a candidate.
# 3 flooded the pilot ledger with ORM models and route modules that the agent
# decided not_a_module every night (owner choice 2026-10-01, review vnhqnz: raise
# the threshold rather than exclude db/models, because widely-shared models matter).
DEFAULT_FAN_IN_THRESHOLD = 6
DEFAULT_EXCLUDE_PATTERNS: tuple[str, ...] = (
    r"(^|/)(tests?|__tests__|spec|node_modules|\.venv|venv|dist|build|migrations|\.git|\.playwright-mcp)/",
    # the harness itself and its corpora are off limits to the automation (prompt ground rule 6)
    r"(^|/)services/module_registry/", r"(^|/)\.module_registry/", r"(^|/)gurucloud_kb/modreg/",
    r"\.(test|spec)\.(ts|tsx|js|jsx)$", r"(^|/)test_.*\.py$", r"(^|/)conftest\.py$",
    r"(^|/)__init__\.py$", r"(^|/)__main__\.py$",
)
PY_EXT = {".py"}
TS_EXT = {".ts", ".tsx", ".js", ".jsx"}
CSS_EXT = {".css"}

TS_EXPORT_RE = re.compile(r"^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)", re.MULTILINE)
TS_IMPORT_RE = re.compile(r"""(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]""")
TS_REQUIRE_RE = re.compile(r"""require\(\s*['"]([^'"]+)['"]\s*\)""")
CSS_TOKEN_DEF_RE = re.compile(r"(--[a-zA-Z0-9_-]+)\s*:")
CSS_TOKEN_USE_RE = re.compile(r"var\(\s*(--[a-zA-Z0-9_-]+)")


@dataclass
class Candidate:
    path: str
    language: str
    exports: list[str]
    fan_in: int
    importers: list[str] = field(default_factory=list)
    shared_path: bool = False
    lines: int = 0

    def as_dict(self) -> dict:
        return asdict(self)


def _matches_any(rel: str, patterns: Iterable[str]) -> bool:
    return any(re.search(p, rel) for p in patterns)


def extract_python_exports(source: str) -> list[str]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    out: list[str] = []
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if not node.name.startswith("_"):
                out.append(node.name)
        elif isinstance(node, ast.Assign):
            if isinstance(node.value, ast.Call):
                fn = node.value.func
                fname = getattr(fn, "id", None) or getattr(fn, "attr", None)
                if fname in {"TypeVar", "ParamSpec", "TypeAlias"}:
                    continue
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id.isupper() and not t.id.startswith("_"):
                    out.append(t.id)
    return out


def extract_ts_exports(source: str) -> list[str]:
    return [e for e in TS_EXPORT_RE.findall(source) if not e.startswith("_")]


def extract_css_tokens(source: str) -> list[str]:
    return sorted(set(CSS_TOKEN_DEF_RE.findall(source)))


def _python_module_names(rel: str) -> set[str]:
    """Dotted names under which a Python file can be imported."""
    p = Path(rel)
    parts = list(p.with_suffix("").parts)
    names = {".".join(parts)}
    if parts and parts[-1] == "__init__":
        names.add(".".join(parts[:-1]))
    return names


def _python_imports(source: str) -> set[str]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            out.add(node.module)
            out.update(f"{node.module}.{a.name}" for a in node.names)
    return out


def _resolve_ts_import(importer_rel: str, spec: str, all_files: set[str]) -> Optional[str]:
    if not spec.startswith("."):
        # bare specifier: try common aliases (@/, src/) — resolve by suffix match
        tail = spec.lstrip("@/").lstrip("~/")
        for cand in all_files:
            if cand.endswith("/" + tail) or cand.endswith("/" + tail + "/index.ts") or cand.endswith("/" + tail + "/index.tsx"):
                return cand
            for ext in (".ts", ".tsx", ".js", ".jsx"):
                if cand.endswith("/" + tail + ext) or cand == tail + ext:
                    return cand
        return None
    base = (Path(importer_rel).parent / spec).as_posix()
    base = Path(base).resolve().relative_to(Path(".").resolve()).as_posix() if base.startswith("..") else Path(base).as_posix()
    # normalise ./ and ../ segments
    parts: list[str] = []
    for seg in base.split("/"):
        if seg == "..":
            if parts:
                parts.pop()
        elif seg and seg != ".":
            parts.append(seg)
    base = "/".join(parts)
    for cand in (base, *[f"{base}{ext}" for ext in (".ts", ".tsx", ".js", ".jsx")], *[f"{base}/index{ext}" for ext in (".ts", ".tsx", ".js", ".jsx")]):
        if cand in all_files:
            return cand
    return None


def scan_repository(
    root: Path,
    *,
    fan_in_threshold: int = DEFAULT_FAN_IN_THRESHOLD,
    shared_patterns: Iterable[str] = DEFAULT_SHARED_PATTERNS,
    exclude_patterns: Iterable[str] = DEFAULT_EXCLUDE_PATTERNS,
    max_file_bytes: int = 400_000,
) -> list[Candidate]:
    """Walk ``root`` and return candidates sorted by (shared_path desc, fan_in desc, path)."""
    root = root.resolve()
    files: dict[str, str] = {}
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix not in (PY_EXT | TS_EXT | CSS_EXT):
            continue
        rel = p.relative_to(root).as_posix()
        if _matches_any(rel, exclude_patterns) or p.stat().st_size > max_file_bytes:
            continue
        try:
            files[rel] = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

    all_ts = {r for r in files if Path(r).suffix in TS_EXT}
    py_name_index: dict[str, str] = {}
    for rel in files:
        if Path(rel).suffix in PY_EXT:
            for name in _python_module_names(rel):
                py_name_index[name] = rel
    css_token_owner: dict[str, str] = {}
    for rel, src in files.items():
        if Path(rel).suffix in CSS_EXT:
            for tok in extract_css_tokens(src):
                css_token_owner.setdefault(tok, rel)

    importers: dict[str, set[str]] = defaultdict(set)
    for rel, src in files.items():
        suffix = Path(rel).suffix
        if suffix in PY_EXT:
            for name in _python_imports(src):
                target = py_name_index.get(name) or py_name_index.get(name.rsplit(".", 1)[0]) if "." in name else py_name_index.get(name)
                if target and target != rel:
                    importers[target].add(rel)
        elif suffix in TS_EXT:
            for spec in set(TS_IMPORT_RE.findall(src)) | set(TS_REQUIRE_RE.findall(src)):
                target = _resolve_ts_import(rel, spec, all_ts)
                if target and target != rel:
                    importers[target].add(rel)
        elif suffix in CSS_EXT:
            for tok in set(CSS_TOKEN_USE_RE.findall(src)):
                owner = css_token_owner.get(tok)
                if owner and owner != rel:
                    importers[owner].add(rel)
        if suffix in TS_EXT | PY_EXT:
            # CSS tokens used from templates/JS via var(--x)
            for tok in set(CSS_TOKEN_USE_RE.findall(src)):
                owner = css_token_owner.get(tok)
                if owner and owner != rel:
                    importers[owner].add(rel)

    candidates: list[Candidate] = []
    for rel, src in files.items():
        suffix = Path(rel).suffix
        shared = _matches_any(rel, shared_patterns)
        fan_in = len(importers.get(rel, ()))
        if not shared and fan_in < fan_in_threshold:
            continue
        if suffix in PY_EXT:
            exports, lang = extract_python_exports(src), "python"
        elif suffix in TS_EXT:
            exports, lang = extract_ts_exports(src), "typescript"
        else:
            exports, lang = extract_css_tokens(src), "css"
        if not exports:
            continue
        candidates.append(Candidate(
            path=rel, language=lang, exports=sorted(exports), fan_in=fan_in,
            importers=sorted(importers.get(rel, ())), shared_path=shared,
            lines=src.count("\n") + 1,
        ))
    candidates.sort(key=lambda c: (not c.shared_path, -c.fan_in, c.path))
    return candidates


def scan_to_json(root: Path, **kwargs) -> str:
    return json.dumps([c.as_dict() for c in scan_repository(root, **kwargs)], indent=2)
