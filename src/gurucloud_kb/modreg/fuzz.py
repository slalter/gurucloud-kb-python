"""Differential fuzzing with Hypothesis: generate inputs from type hints
(and from the shapes seen in a recorded corpus), run OLD and NEW under the
same frozen context, compare outcomes byte for byte. Hypothesis shrinks the
first failing input to a minimal counter-example, which the report keeps.
"""
from __future__ import annotations

import inspect
import json
import typing
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from hypothesis import HealthCheck, Phase, given, settings
from hypothesis import strategies as st
from hypothesis.errors import Unsatisfiable

# ``HealthCheck.all()`` is deprecated, and two members (``return_value``,
# ``not_a_test_method``) are deprecated aliases that warn when listed; every
# other check is suppressed because the property is a differential probe, not
# a test (filter-heavy strategies and slow examples are expected).
_DEPRECATED_HEALTH_CHECKS = frozenset({"return_value", "not_a_test_method"})
_SUPPRESSED_HEALTH_CHECKS: list[HealthCheck] = [
    hc for name, hc in HealthCheck.__members__.items() if name not in _DEPRECATED_HEALTH_CHECKS
]

from .replay import _run, frozen
from .serialize import NotReplayable, canonical_bytes, from_canonical
from .tracer import TraceRecord

_SCALARS = st.one_of(
    st.none(), st.booleans(), st.integers(min_value=-(2**63), max_value=2**63 - 1),
    st.floats(allow_nan=True, allow_infinity=True), st.text(max_size=64),
)


class _Stop(Exception):
    """Raised inside the property once ``max_mismatches`` is reached."""


def _strategy_for_annotation(ann: Any) -> Optional[st.SearchStrategy[Any]]:
    if ann is inspect.Parameter.empty or ann is Any:
        return None
    try:
        return st.from_type(ann)
    except Exception:
        return None


def _strategy_from_examples(values: list[Any]) -> st.SearchStrategy[Any]:
    """Strategy shaped like the recorded argument values: same scalar kinds,
    lists/dicts of them, plus mutations (empty, unicode, boundaries)."""
    kinds: set[str] = set()
    for v in values:
        if v is None:
            kinds.add("none")
        elif isinstance(v, bool):
            kinds.add("bool")
        elif isinstance(v, int):
            kinds.add("int")
        elif isinstance(v, float):
            kinds.add("float")
        elif isinstance(v, str):
            kinds.add("str")
        elif isinstance(v, (list, tuple)):
            kinds.add("list")
        elif isinstance(v, dict):
            kinds.add("dict")
    parts: list[st.SearchStrategy[Any]] = []
    if "none" in kinds:
        parts.append(st.none())
    if "bool" in kinds:
        parts.append(st.booleans())
    if "int" in kinds:
        parts.append(st.integers())
    if "float" in kinds:
        parts.append(st.floats(allow_nan=True, allow_infinity=True))
    if "str" in kinds:
        parts.append(st.text(max_size=128))
    if "list" in kinds:
        parts.append(st.lists(_SCALARS, max_size=16))
    if "dict" in kinds:
        parts.append(st.dictionaries(st.text(max_size=16), _SCALARS, max_size=16))
    if values:
        parts.append(st.sampled_from(values))
    return st.one_of(*parts) if parts else _SCALARS


def build_strategies(func: Callable[..., Any], corpus: Optional[list[TraceRecord]] = None) -> dict[str, st.SearchStrategy[Any]]:
    """One strategy per positional-or-keyword parameter of ``func``."""
    sig = inspect.signature(func)
    hints: dict[str, Any] = {}
    try:
        hints = typing.get_type_hints(func)
    except Exception:
        hints = {}
    examples: dict[str, list[Any]] = {name: [] for name in sig.parameters}
    for rec in corpus or []:
        if rec.hashed or rec.opaque:
            continue
        try:
            args = from_canonical(json.loads(rec.args))
            kwargs = from_canonical(json.loads(rec.kwargs))
            bound = sig.bind_partial(*args, **kwargs)
        except (NotReplayable, TypeError):
            continue
        for name, val in bound.arguments.items():
            examples.setdefault(name, []).append(val)
    out: dict[str, st.SearchStrategy[Any]] = {}
    for name, param in sig.parameters.items():
        if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        strat = _strategy_for_annotation(hints.get(name, param.annotation))
        if strat is None:
            strat = _strategy_from_examples(examples.get(name, []))
        elif examples.get(name):
            strat = st.one_of(strat, st.sampled_from(examples[name]))
        if param.default is not inspect.Parameter.empty:
            strat = st.one_of(st.just(param.default), strat)
        out[name] = strat
    return out


@dataclass
class FuzzMismatch:
    kwargs: str
    expected: str
    actual: str


@dataclass
class FuzzReport:
    examples_run: int = 0
    mismatches: list[FuzzMismatch] = field(default_factory=list)
    error: Optional[str] = None

    @property
    def verdict(self) -> str:
        if self.error:
            return "error"
        if self.examples_run == 0:
            return "no_evidence"
        return "pass" if not self.mismatches else "fail"

    def as_dict(self) -> dict:
        return {"verdict": self.verdict, "examples_run": self.examples_run, "error": self.error,
                "mismatches": [m.__dict__ for m in self.mismatches]}


def differential_fuzz(
    old: Callable[..., Any],
    new: Callable[..., Any],
    *,
    corpus: Optional[list[TraceRecord]] = None,
    max_examples: int = 500,
    seed: int = 1234,
    max_mismatches: int = 25,
) -> FuzzReport:
    report = FuzzReport()
    strategies = build_strategies(old, corpus)
    if not strategies:
        # zero-arg function: one differential call is the whole space
        with frozen(old, new, seed=seed):
            a = _run(old, (), {})
        with frozen(old, new, seed=seed):
            b = _run(new, (), {})
        report.examples_run = 1
        if a != b:
            report.mismatches.append(FuzzMismatch("{}", a.decode(), b.decode()))
        return report

    seen_failures: dict[bytes, FuzzMismatch] = {}

    @settings(max_examples=max_examples, deadline=None, database=None, derandomize=True,
              suppress_health_check=_SUPPRESSED_HEALTH_CHECKS, phases=(Phase.generate, Phase.shrink))
    @given(st.fixed_dictionaries(strategies))
    def prop(kwargs: dict[str, Any]) -> None:
        report.examples_run += 1
        with frozen(old, new, seed=seed):
            a = _run(old, (), kwargs)
        with frozen(old, new, seed=seed):
            b = _run(new, (), kwargs)
        if a != b:
            key = canonical_bytes(kwargs)
            seen_failures[key] = FuzzMismatch(key.decode("utf-8"), a.decode("utf-8"), b.decode("utf-8"))
            if len(seen_failures) >= max_mismatches:
                raise _Stop()
            raise AssertionError("differential mismatch")

    try:
        prop()
    except (AssertionError, _Stop):
        pass
    except Unsatisfiable as exc:
        report.error = f"unsatisfiable strategies: {exc}"
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim in the report
        report.error = f"{type(exc).__name__}: {exc}"
    # Hypothesis shrinks toward the minimal example; keep the SMALLEST kwargs
    # first so the report leads with the clearest counter-example.
    report.mismatches = sorted(seen_failures.values(), key=lambda m: len(m.kwargs))
    return report
