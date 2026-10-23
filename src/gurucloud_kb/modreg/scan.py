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

Python module names are indexed relative to every *source root* of the
repository (``python_source_roots``): the root itself plus whatever a
src-layout declares (``[tool.setuptools.packages.find] where``,
``package-dir``, poetry ``packages[].from``, hatch wheel ``packages``, pytest
``pythonpath``, ``setup.cfg`` ``package_dir``) or a top-level ``src/`` holding
packages. ``src/airsa/domain/enums.py`` is therefore reachable as both
``src.airsa.domain.enums`` and ``airsa.domain.enums``, while the emitted
``Candidate.path`` stays repo-relative (the ledger keys rows by it).
"""
from __future__ import annotations

import ast
import configparser
import json
import re
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional, Sequence

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


# ---------------------------------------------------------------------------
# Python source roots (src layout)
# ---------------------------------------------------------------------------
_TOML_SECTION_RE = re.compile(r"^\s*\[([^\[\]]+)\]\s*(?:#.*)?$")
_TOML_KEY_RE = re.compile(r'^\s*(?:"(?P<quoted>[^"]*)"|(?P<bare>[A-Za-z0-9_.-]+))\s*=\s*(?P<rest>.*)$')
_TOML_STRING_RE = re.compile(r'"([^"]*)"|\'([^\']*)\'')
_TOML_PAIR_RE = re.compile(r'(?:"(?P<quoted>[^"]*)"|(?P<bare>[A-Za-z0-9_.-]+))\s*=\s*(?:"(?P<value>[^"]*)"|\'(?P<value_sq>[^\']*)\')')
_TOML_FROM_RE = re.compile(r'\bfrom\s*=\s*(?:"([^"]*)"|\'([^\']*)\')')


def _toml_strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def _dig(table: object, *keys: str) -> object:
    for key in keys:
        if not isinstance(table, dict):
            return None
        table = table.get(key)
    return table


def _roots_from_package_dir(mapping: dict[str, str]) -> list[str]:
    """``{"" : "src"}`` names a root outright; ``{"pkg": "src/pkg"}`` implies ``src``."""
    out: list[str] = []
    for key, value in mapping.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        if key == "":
            out.append(value)
            continue
        tail = "/" + key.replace(".", "/")
        v = value.replace("\\", "/").rstrip("/")
        if v.endswith(tail):
            out.append(v[: -len(tail)] or ".")
    return out


def _roots_from_pyproject_data(data: dict) -> list[str]:
    out: list[str] = []
    out += _toml_strings(_dig(data, "tool", "setuptools", "packages", "find", "where"))
    package_dir = _dig(data, "tool", "setuptools", "package-dir")
    if isinstance(package_dir, dict):
        out += _roots_from_package_dir(package_dir)
    poetry_packages = _dig(data, "tool", "poetry", "packages")
    if isinstance(poetry_packages, list):
        for entry in poetry_packages:
            if isinstance(entry, dict) and isinstance(entry.get("from"), str):
                out.append(entry["from"])
    for pkg in _toml_strings(_dig(data, "tool", "hatch", "build", "targets", "wheel", "packages")):
        out.append(PurePosixPath(pkg.replace("\\", "/")).parent.as_posix())
    pythonpath = _dig(data, "tool", "pytest", "ini_options", "pythonpath")
    out += pythonpath.split() if isinstance(pythonpath, str) else _toml_strings(pythonpath)
    return out


def _toml_fallback_entries(text: str) -> list[tuple[str, str, str]]:
    """``(section, key, raw_value)`` per top-level assignment, arrays/tables joined
    across lines. A line-oriented subset reader for Python 3.10, which has no tomllib."""
    entries: list[tuple[str, str, str]] = []
    section = ""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        sec = _TOML_SECTION_RE.match(line)
        if sec:
            section = sec.group(1).strip().replace('"', "").replace("'", "")
            continue
        km = _TOML_KEY_RE.match(line)
        if not km:
            continue
        key = km.group("quoted") if km.group("quoted") is not None else km.group("bare")
        rest = km.group("rest")
        depth = rest.count("[") + rest.count("{") - rest.count("]") - rest.count("}")
        while depth > 0 and i < len(lines):
            rest += "\n" + lines[i]
            depth += lines[i].count("[") + lines[i].count("{") - lines[i].count("]") - lines[i].count("}")
            i += 1
        entries.append((section, key, rest))
    return entries


def _roots_from_pyproject_fallback(text: str) -> list[str]:
    """Rebuild just the tables ``_roots_from_pyproject_data`` reads, then derive the
    roots through that one function so both readers agree on order and semantics."""
    where: list[str] = []
    package_dir: dict[str, str] = {}
    poetry: list[dict[str, str]] = []
    hatch: list[str] = []
    pythonpath: list[str] = []
    for section, key, raw in _toml_fallback_entries(text):
        full = f"{section}.{key}" if section else key
        strings = [a or b for a, b in _TOML_STRING_RE.findall(raw)]
        if full == "tool.setuptools.packages.find.where":
            where += strings
        elif full == "tool.setuptools.package-dir":
            for m in _TOML_PAIR_RE.finditer(raw):
                k = m.group("quoted") if m.group("quoted") is not None else m.group("bare")
                package_dir[k] = m.group("value") if m.group("value") is not None else (m.group("value_sq") or "")
        elif section == "tool.setuptools.package-dir" and strings:
            package_dir[key] = strings[0]
        elif full == "tool.poetry.packages":
            poetry += [{"from": a or b} for a, b in _TOML_FROM_RE.findall(raw)]
        elif full == "tool.hatch.build.targets.wheel.packages":
            hatch += strings
        elif full == "tool.pytest.ini_options.pythonpath":
            pythonpath += strings
    data = {"tool": {
        "setuptools": {"packages": {"find": {"where": where}}, "package-dir": package_dir},
        "poetry": {"packages": poetry},
        "hatch": {"build": {"targets": {"wheel": {"packages": hatch}}}},
        "pytest": {"ini_options": {"pythonpath": pythonpath}},
    }}
    return _roots_from_pyproject_data(data)


def _roots_from_pyproject_text(text: str, *, prefer_tomllib: bool = True) -> list[str]:
    if prefer_tomllib:
        try:
            import tomllib  # Python 3.11+
        except ImportError:  # pragma: no cover - depends on the interpreter
            tomllib = None
        if tomllib is not None:
            try:
                return _roots_from_pyproject_data(tomllib.loads(text))
            except (tomllib.TOMLDecodeError, ValueError):
                return []
    return _roots_from_pyproject_fallback(text)


def _ini_parser(text: str) -> Optional[configparser.ConfigParser]:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        parser.read_string(text)
    except configparser.Error:
        return None
    return parser


def _roots_from_setup_cfg_text(text: str) -> list[str]:
    parser = _ini_parser(text)
    if parser is None:
        return []
    out: list[str] = []
    if parser.has_option("options.packages.find", "where"):
        out += parser.get("options.packages.find", "where").replace(",", " ").split()
    if parser.has_option("options", "package_dir"):
        mapping: dict[str, str] = {}
        for line in parser.get("options", "package_dir").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                mapping[k.strip()] = v.strip()
        out += _roots_from_package_dir(mapping)
    if parser.has_option("tool:pytest", "pythonpath"):
        out += parser.get("tool:pytest", "pythonpath").split()
    return out


def _roots_from_pytest_ini_text(text: str) -> list[str]:
    parser = _ini_parser(text)
    if parser is None or not parser.has_option("pytest", "pythonpath"):
        return []
    return parser.get("pytest", "pythonpath").split()


def _normalise_root(raw: str) -> Optional[str]:
    s = raw.strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    s = s.strip("/")
    if s in ("", "."):
        return ""
    if raw.strip().startswith("/") or ".." in s.split("/"):
        return None  # outside the repository
    return s


def python_source_roots(root: Path) -> list[str]:
    """Repo-relative directories Python imports resolve against, ``""`` (the root) first.

    Declared roots come from ``pyproject.toml`` (setuptools ``where`` /
    ``package-dir``, poetry ``packages[].from``, hatch wheel ``packages``, pytest
    ``pythonpath``), ``setup.cfg`` (``package_dir``, ``options.packages.find``,
    ``tool:pytest pythonpath``) and ``pytest.ini`` / ``tox.ini`` (``pythonpath``);
    a top-level ``src/`` whose immediate children are packages counts without any
    declaration. Only existing directories inside the repository are kept, in
    detection order, deduplicated.
    """
    raw: list[str] = []
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            raw += _roots_from_pyproject_text(pyproject.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, OSError):
            pass
    setup_cfg = root / "setup.cfg"
    if setup_cfg.is_file():
        try:
            raw += _roots_from_setup_cfg_text(setup_cfg.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, OSError):
            pass
    for ini in ("pytest.ini", "tox.ini"):
        ini_path = root / ini
        if ini_path.is_file():
            try:
                raw += _roots_from_pytest_ini_text(ini_path.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, OSError):
                pass
    src = root / "src"
    if src.is_dir() and any((child / "__init__.py").is_file() for child in src.iterdir() if child.is_dir()):
        raw.append("src")
    roots = [""]
    for r in raw:
        n = _normalise_root(r)
        if n is not None and n not in roots and (root / n).is_dir():
            roots.append(n)
    return roots


def _module_names_by_source_root(rel: str, source_roots: Sequence[str]) -> Iterable[str]:
    for sr in source_roots:
        if sr == "":
            yield from _python_module_names(rel)
        elif rel.startswith(sr + "/"):
            yield from _python_module_names(rel[len(sr) + 1:])


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
    source_roots: Optional[Sequence[str]] = None,
) -> list[Candidate]:
    """Walk ``root`` and return candidates sorted by (shared_path desc, fan_in desc, path).

    ``source_roots`` overrides ``python_source_roots(root)`` (repo-relative dirs Python
    imports resolve against; ``""`` is the root). Paths in the result are always
    repo-relative whatever the roots are.
    """
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
    roots = list(source_roots) if source_roots is not None else python_source_roots(root)
    if "" not in roots:
        roots.insert(0, "")
    # root-relative names first, then each declared source root in detection order,
    # files in path order: the first owner of a dotted name wins (setdefault), so a
    # root-layout repository indexes exactly as before and ``from src.x import`` keeps
    # resolving next to ``from x import`` in a src-layout one.
    py_files = sorted(r for r in files if Path(r).suffix in PY_EXT)
    py_name_index: dict[str, str] = {}
    for sr in roots:
        for rel in py_files:
            for name in _module_names_by_source_root(rel, (sr,)):
                py_name_index.setdefault(name, rel)
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
