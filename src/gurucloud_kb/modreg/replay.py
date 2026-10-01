"""Replay a recorded corpus and compare outcomes byte for byte.

Two modes:
* **corpus mode** (pure functions): call the *candidate* on each recorded
  input and compare against the *recorded* outcome.
* **differential mode** (pure or nondeterministic): call *old* and *new* on
  each recorded input inside the same :func:`frozen` context and compare the
  two live outcomes. This is also what the fuzzer uses.

A single mismatch fails the pair; the report keeps every mismatch verbatim
(inputs, expected, actual) — never truncated, per the audit-trail rule.
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import json
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional

from .serialize import NotReplayable, from_canonical, outcome_bytes
from .tracer import TraceRecord

FROZEN_EPOCH = 1_700_000_000.0
FROZEN_UUID = uuid.UUID("00000000-0000-4000-8000-000000000000")
FROZEN_DT = _dt.datetime(2023, 11, 14, 22, 13, 20)
# Captured at import: inside frozen() the module attribute is the fake class.
_REAL_DATETIME = _dt.datetime


class _FrozenDatetimeMeta(type):
    """``isinstance(real_datetime, _FrozenDatetime)`` must stay True while the
    class is swapped in, or type checks inside the code under test change
    behaviour (the harness would then hide or invent divergences)."""

    def __instancecheck__(cls, obj: Any) -> bool:
        return isinstance(obj, _REAL_DATETIME)


class _FrozenDatetime(_REAL_DATETIME, metaclass=_FrozenDatetimeMeta):
    @classmethod
    def now(cls, tz: Optional[_dt.tzinfo] = None) -> "_FrozenDatetime":  # type: ignore[override]
        base = FROZEN_DT if tz is None else FROZEN_DT.replace(tzinfo=_dt.timezone.utc).astimezone(tz)
        return cls(base.year, base.month, base.day, base.hour, base.minute, base.second, base.microsecond, base.tzinfo)

    @classmethod
    def utcnow(cls) -> "_FrozenDatetime":  # type: ignore[override]
        return cls(FROZEN_DT.year, FROZEN_DT.month, FROZEN_DT.day, FROZEN_DT.hour, FROZEN_DT.minute, FROZEN_DT.second)

    @classmethod
    def today(cls) -> "_FrozenDatetime":  # type: ignore[override]
        return cls.now()


@contextlib.contextmanager
def frozen(*targets: Callable[..., Any], seed: int = 1234) -> Iterator[None]:
    """Freeze random / time / uuid4 globally and ``datetime`` in each target's
    module globals for the duration. Both sides of a differential run see
    identical ambient values, so nondeterministic-but-otherwise-pure functions
    compare cleanly."""
    saved: list[tuple[Any, str, Any]] = []

    def _patch(obj: Any, name: str, value: Any) -> None:
        saved.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    _patch(time, "time", lambda: FROZEN_EPOCH)
    _patch(time, "monotonic", lambda: FROZEN_EPOCH)
    _patch(time, "perf_counter", lambda: FROZEN_EPOCH)
    _patch(uuid, "uuid4", lambda: FROZEN_UUID)
    _patch(uuid, "uuid1", lambda *a, **k: FROZEN_UUID)
    dt_module = sys.modules["datetime"]
    _patch(dt_module, "datetime", _FrozenDatetime)
    for fn in targets:
        g = getattr(fn, "__globals__", None)
        if isinstance(g, dict) and isinstance(g.get("datetime"), type) and issubclass(g["datetime"], _REAL_DATETIME):
            saved.append((g, "datetime", g["datetime"]))
            g["datetime"] = _FrozenDatetime
    state = random.getstate()
    random.seed(seed)
    try:
        yield
    finally:
        random.setstate(state)
        for obj, name, old in reversed(saved):
            if isinstance(obj, dict):
                obj[name] = old
            else:
                setattr(obj, name, old)


def _run(fn: Callable[..., Any], args: tuple, kwargs: dict) -> bytes:
    try:
        return outcome_bytes(result=fn(*args, **kwargs))
    except BaseException as exc:  # noqa: BLE001 - the exception IS the outcome
        return outcome_bytes(error=exc)


@dataclass
class Mismatch:
    index: int
    args: str
    kwargs: str
    expected: str
    actual: str


@dataclass
class ReplayReport:
    mode: str
    total: int = 0
    compared: int = 0
    matched: int = 0
    skipped_not_replayable: int = 0
    skipped_hashed: int = 0
    mismatches: list[Mismatch] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        if self.compared == 0:
            return "no_evidence"
        return "pass" if not self.mismatches else "fail"

    def as_dict(self) -> dict:
        return {
            "mode": self.mode, "verdict": self.verdict, "total": self.total, "compared": self.compared,
            "matched": self.matched, "skipped_not_replayable": self.skipped_not_replayable,
            "skipped_hashed": self.skipped_hashed,
            "mismatches": [m.__dict__ for m in self.mismatches],
        }


def _inputs(rec: TraceRecord) -> Optional[tuple[tuple, dict]]:
    if rec.hashed or rec.opaque:
        return None
    args = from_canonical(json.loads(rec.args))
    kwargs = from_canonical(json.loads(rec.kwargs))
    return tuple(args), dict(kwargs)


def replay_corpus(candidate: Callable[..., Any], corpus: list[TraceRecord], *, max_mismatches: int = 1_000_000) -> ReplayReport:
    """Corpus mode: candidate vs the RECORDED outcome (pure functions only)."""
    report = ReplayReport(mode="corpus", total=len(corpus))
    for i, rec in enumerate(corpus):
        if rec.hashed or rec.opaque:
            report.skipped_hashed += 1
            continue
        try:
            inputs = _inputs(rec)
        except NotReplayable:
            report.skipped_not_replayable += 1
            continue
        assert inputs is not None
        args, kwargs = inputs
        actual = _run(candidate, args, kwargs)
        report.compared += 1
        expected = rec.outcome.encode("utf-8")
        if actual == expected:
            report.matched += 1
        elif len(report.mismatches) < max_mismatches:
            report.mismatches.append(Mismatch(i, rec.args, rec.kwargs, rec.outcome, actual.decode("utf-8")))
    return report


def replay_differential(old: Callable[..., Any], new: Callable[..., Any], corpus: list[TraceRecord], *, seed: int = 1234) -> ReplayReport:
    """Differential mode: old vs new on the recorded INPUTS under one frozen
    context (works for nondeterministic-but-pure functions)."""
    report = ReplayReport(mode="differential", total=len(corpus))
    for i, rec in enumerate(corpus):
        if rec.hashed or rec.opaque:
            report.skipped_hashed += 1
            continue
        try:
            inputs = _inputs(rec)
        except NotReplayable:
            report.skipped_not_replayable += 1
            continue
        assert inputs is not None
        args, kwargs = inputs
        with frozen(old, new, seed=seed):
            expected = _run(old, args, kwargs)
        with frozen(old, new, seed=seed):
            actual = _run(new, args, kwargs)
        report.compared += 1
        if expected == actual:
            report.matched += 1
        else:
            report.mismatches.append(Mismatch(i, rec.args, rec.kwargs, expected.decode("utf-8"), actual.decode("utf-8")))
    return report
