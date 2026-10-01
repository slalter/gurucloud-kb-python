"""AST purity classifier.

Decides which proof path a candidate module (or one function in it) can take:

* ``pure``            — no I/O, no ambient state, no nondeterminism seen. Full
                        automatic pipeline (record → replay → fuzz → shadow).
* ``nondeterministic``— pure apart from clock / random / uuid / env reads.
                        Replay and fuzz still work under the frozen-nondeterminism
                        harness (``replay.frozen``); production shadow is allowed
                        because both sides see the same ambient values per call.
* ``effectful``       — touches databases, network, filesystem, subprocesses,
                        cloud SDKs, or framework request state. Phase 1: card.

The classifier is deliberately conservative: an unknown import that looks like
I/O counts as effectful, and any ``global``/``nonlocal`` write or module-level
mutable state access marks the function effectful. A false "effectful" costs a
card; a false "pure" could cost a wrong merge.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal, Optional

Purity = Literal["pure", "nondeterministic", "effectful"]

EFFECTFUL_MODULES: frozenset[str] = frozenset({
    "requests", "httpx", "aiohttp", "urllib", "urllib3", "socket", "ssl",
    "redis", "aioredis", "sqlalchemy", "sqlmodel", "psycopg2", "psycopg", "asyncpg",
    "pymongo", "boto3", "botocore", "google", "openai", "anthropic",
    "subprocess", "shutil", "os", "io", "tempfile", "pathlib", "glob",
    "fastapi", "flask", "starlette", "celery", "threading", "multiprocessing",
    "asyncio", "logging", "smtplib", "imaplib", "ftplib", "paramiko",
    "db", "models", "tasks", "services",  # repo-local layers that reach I/O
})
# Names on module-level imports that are pure despite living in an effectful
# package (e.g. `from pathlib import PurePosixPath` only manipulates strings).
PURE_IMPORT_EXCEPTIONS: frozenset[str] = frozenset({
    "pathlib.PurePath", "pathlib.PurePosixPath", "pathlib.PureWindowsPath",
    "os.path",
})
NONDETERMINISTIC_MODULES: frozenset[str] = frozenset({
    "random", "secrets", "uuid", "time", "datetime",
})
NONDETERMINISTIC_CALLS: frozenset[str] = frozenset({
    "datetime.now", "datetime.utcnow", "datetime.today", "date.today",
    "time.time", "time.monotonic", "time.perf_counter", "uuid.uuid4", "uuid.uuid1",
    "random.random", "random.randint", "random.choice", "random.shuffle",
    "secrets.token_hex", "secrets.token_urlsafe", "os.urandom", "os.getenv",
    "os.environ.get",
})
EFFECTFUL_BUILTINS: frozenset[str] = frozenset({"open", "input", "print", "exec", "eval", "__import__"})


@dataclass
class PurityVerdict:
    path: str
    symbol: Optional[str]
    purity: Purity
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"path": self.path, "symbol": self.symbol, "purity": self.purity, "reasons": list(self.reasons)}


def _dotted(node: ast.AST) -> Optional[str]:
    """`a.b.c` for an Attribute/Name chain, else None."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def _module_root(name: str) -> str:
    return name.split(".", 1)[0]


def _import_names(tree: ast.AST) -> tuple[set[str], set[str]]:
    """Return (effectful_imports, nondeterministic_imports) seen at module level."""
    effectful: set[str] = set()
    nondet: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = _module_root(alias.name)
                if root in EFFECTFUL_MODULES and alias.name not in PURE_IMPORT_EXCEPTIONS:
                    effectful.add(alias.name)
                elif root in NONDETERMINISTIC_MODULES:
                    nondet.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            root = _module_root(node.module)
            for alias in node.names:
                full = f"{node.module}.{alias.name}"
                if root in EFFECTFUL_MODULES and full not in PURE_IMPORT_EXCEPTIONS and node.module not in PURE_IMPORT_EXCEPTIONS:
                    effectful.add(full)
                elif root in NONDETERMINISTIC_MODULES:
                    nondet.add(full)
    return effectful, nondet


def _function_reasons(fn: ast.AST) -> tuple[list[str], list[str]]:
    """(effectful_reasons, nondeterministic_reasons) for one function body."""
    effectful: list[str] = []
    nondet: list[str] = []
    for node in ast.walk(fn):
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            effectful.append(f"{type(node).__name__.lower()} statement")
        elif isinstance(node, ast.Call):
            name = _dotted(node.func)
            if name is None:
                continue
            if name in EFFECTFUL_BUILTINS:
                effectful.append(f"call {name}()")
            elif name in NONDETERMINISTIC_CALLS or any(name.endswith("." + c.split(".", 1)[-1]) and name.startswith(c.split(".", 1)[0]) for c in NONDETERMINISTIC_CALLS):
                nondet.append(f"call {name}()")
            elif _module_root(name) in EFFECTFUL_MODULES and name not in PURE_IMPORT_EXCEPTIONS and not name.startswith("os.path"):
                effectful.append(f"call {name}()")
        elif isinstance(node, (ast.Await, ast.AsyncFor, ast.AsyncWith)):
            effectful.append("async I/O construct")
        elif isinstance(node, ast.With):
            effectful.append("context manager (assumed resource)")
    return effectful, nondet


def classify_source(source: str, path: str = "<memory>", symbol: Optional[str] = None) -> PurityVerdict:
    """Classify a whole module, or one top-level function/class named ``symbol``."""
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        return PurityVerdict(path, symbol, "effectful", [f"unparseable: {exc.msg}"])

    eff_imports, nd_imports = _import_names(tree)
    reasons: list[str] = []
    nondet_reasons: list[str] = []

    targets: Iterable[ast.AST]
    if symbol is None:
        targets = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        if eff_imports:
            reasons.append("imports: " + ", ".join(sorted(eff_imports)))
        if nd_imports:
            nondet_reasons.append("imports: " + ", ".join(sorted(nd_imports)))
    else:
        targets = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == symbol]
        if not targets:
            return PurityVerdict(path, symbol, "effectful", [f"symbol {symbol!r} not found at module top level"])

    for node in targets:
        if isinstance(node, ast.AsyncFunctionDef):
            reasons.append(f"{node.name}: async def")
        e, n = _function_reasons(node)
        reasons.extend(f"{getattr(node, 'name', '?')}: {r}" for r in e)
        nondet_reasons.extend(f"{getattr(node, 'name', '?')}: {r}" for r in n)
        if symbol is not None:
            # A single symbol inherits effectful imports only if it uses them.
            used = {_module_root(_dotted(c.func) or "") for c in ast.walk(node) if isinstance(c, ast.Call)}
            used_eff = sorted(i for i in eff_imports if _module_root(i) in used or i.split(".")[-1] in used)
            if used_eff:
                reasons.append(f"{node.name}: uses " + ", ".join(used_eff))

    if reasons:
        return PurityVerdict(path, symbol, "effectful", reasons + nondet_reasons)
    if nondet_reasons:
        return PurityVerdict(path, symbol, "nondeterministic", nondet_reasons)
    return PurityVerdict(path, symbol, "pure", [])


def classify_file(path: Path, symbol: Optional[str] = None) -> PurityVerdict:
    return classify_source(path.read_text(encoding="utf-8"), str(path), symbol)
