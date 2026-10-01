"""Record real calls of a target function: canonical arguments + outcome.

Production-safe by construction (owner question on overhead, review thread
wjwruy):
* sampling decision is one ``random.random() < rate`` per call;
* a sampled call serialises args/outcome (size-capped → digest) and pushes a
  record onto a bounded queue drained by a daemon thread — the caller never
  blocks and never sees a tracer exception;
* a :class:`Budget` tracks cumulative tracer time against wall time and
  disables the recorder for the rest of the process when exceeded;
* ``MODULE_REGISTRY_TRACE=off`` kills all recording without a deploy.

The pytest plugin (``services.module_registry.trace_plugin``) uses the same
recorder at rate 1.0 to harvest a corpus from a repository's own test suite,
which is the preferred, zero-production-risk source.
"""
from __future__ import annotations

import functools
import importlib
import json
import os
import queue
import random
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from .serialize import canonical_or_hash, outcome_bytes, is_opaque

ENV_KILL_SWITCH = "MODULE_REGISTRY_TRACE"
DEFAULT_QUEUE_SIZE = 10_000


@dataclass
class TraceRecord:
    target: str
    args: str            # canonical JSON (or <hashed:...>)
    kwargs: str
    outcome: str         # canonical JSON of {"result": ...} or {"error": ...}
    hashed: bool         # any of args/kwargs/outcome replaced by a digest
    opaque: bool         # any non-comparable value seen
    duration_ns: int
    recorded_at: float

    def to_json(self) -> str:
        return json.dumps(self.__dict__, sort_keys=True)

    @classmethod
    def from_json(cls, line: str) -> "TraceRecord":
        return cls(**json.loads(line))


class Sink(Protocol):
    def write(self, record: TraceRecord) -> None: ...
    def close(self) -> None: ...


class MemorySink:
    def __init__(self) -> None:
        self.records: list[TraceRecord] = []

    def write(self, record: TraceRecord) -> None:
        self.records.append(record)

    def close(self) -> None:  # pragma: no cover - nothing to release
        return None


class JsonlSink:
    """Non-blocking JSONL writer: bounded queue + daemon drain thread. A full
    queue DROPS the sample (counted), never the caller."""

    def __init__(self, path: Path, *, queue_size: int = DEFAULT_QUEUE_SIZE) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._q: "queue.Queue[Optional[TraceRecord]]" = queue.Queue(maxsize=queue_size)
        self.dropped = 0
        self.written = 0
        self._thread = threading.Thread(target=self._drain, name="module-registry-trace-sink", daemon=True)
        self._thread.start()

    def write(self, record: TraceRecord) -> None:
        try:
            self._q.put_nowait(record)
        except queue.Full:
            self.dropped += 1

    def _drain(self) -> None:
        with self.path.open("a", encoding="utf-8") as fh:
            while True:
                item = self._q.get()
                if item is None:
                    fh.flush()
                    return
                fh.write(item.to_json() + "\n")
                self.written += 1
                if self._q.empty():
                    fh.flush()

    def close(self) -> None:
        self._q.put(None)
        self._thread.join(timeout=10)


@dataclass
class Budget:
    """Self-limiting overhead budget: cumulative tracer seconds must stay under
    ``max_fraction`` of wall time since the budget started (after a warm-up
    of ``min_wall_s``) and under ``max_total_s`` absolute."""
    max_fraction: float = 0.005
    max_total_s: float = 30.0
    min_wall_s: float = 5.0
    started: float = field(default_factory=time.monotonic)
    spent_s: float = 0.0
    tripped: bool = False
    trip_reason: Optional[str] = None

    def charge(self, seconds: float) -> None:
        self.spent_s += seconds
        if self.tripped:
            return
        if self.spent_s > self.max_total_s:
            self.tripped, self.trip_reason = True, f"total {self.spent_s:.3f}s > {self.max_total_s}s"
            return
        wall = time.monotonic() - self.started
        if wall >= self.min_wall_s and self.spent_s / wall > self.max_fraction:
            self.tripped, self.trip_reason = True, f"fraction {self.spent_s / wall:.4f} > {self.max_fraction}"


def kill_switch_on() -> bool:
    return os.environ.get(ENV_KILL_SWITCH, "").strip().lower() in {"off", "0", "false", "no"}


class Recorder:
    def __init__(self, sink: Sink, *, sample_rate: float = 0.01, budget: Optional[Budget] = None, rng: Optional[random.Random] = None) -> None:
        if not 0.0 <= sample_rate <= 1.0:
            raise ValueError("sample_rate must be within [0, 1]")
        self.sink = sink
        self.sample_rate = sample_rate
        self.budget = budget or Budget()
        self._rng = rng or random.Random()
        self.sampled = 0
        self.errors = 0

    @property
    def enabled(self) -> bool:
        return not self.budget.tripped and not kill_switch_on()

    def wrap(self, func: Callable[..., Any], *, target: Optional[str] = None) -> Callable[..., Any]:
        name = target or f"{func.__module__}:{func.__qualname__}"

        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not self.enabled or (self.sample_rate < 1.0 and self._rng.random() >= self.sample_rate):
                return func(*args, **kwargs)
            t0 = time.perf_counter()
            try:
                args_b, h1 = canonical_or_hash(args)
                kwargs_b, h2 = canonical_or_hash(kwargs)
                opaque = is_opaque(args) or is_opaque(kwargs)
            except Exception:
                self.errors += 1
                return func(*args, **kwargs)
            pre = time.perf_counter() - t0
            t1 = time.perf_counter()
            try:
                result = func(*args, **kwargs)
            except BaseException as exc:  # record, then re-raise unchanged
                dur = time.perf_counter() - t1
                self._emit(name, args_b, kwargs_b, outcome_bytes(error=exc), h1 or h2, opaque, dur, pre)
                raise
            dur = time.perf_counter() - t1
            self._emit(name, args_b, kwargs_b, None, h1 or h2, opaque, dur, pre, result=result)
            return result

        setattr(wrapper, "__module_registry_wrapped__", func)
        return wrapper

    def _emit(self, name: str, args_b: bytes, kwargs_b: bytes, outcome: Optional[bytes], hashed: bool, opaque: bool, dur: float, pre: float, *, result: Any = None) -> None:
        t0 = time.perf_counter()
        try:
            if outcome is None:
                outcome, h3 = canonical_or_hash({"result": result})
                hashed = hashed or h3
                opaque = opaque or is_opaque(result)
            self.sink.write(TraceRecord(
                target=name, args=args_b.decode("utf-8"), kwargs=kwargs_b.decode("utf-8"),
                outcome=outcome.decode("utf-8"), hashed=hashed, opaque=opaque,
                duration_ns=int(dur * 1e9), recorded_at=time.time(),
            ))
            self.sampled += 1
        except Exception:
            self.errors += 1
        finally:
            self.budget.charge(pre + (time.perf_counter() - t0))


def resolve_target(dotted: str) -> tuple[Any, str, Callable[..., Any]]:
    """``pkg.mod:func`` → (module, attr, func). Nested attrs (``Cls.method``)
    are not supported in phase 1 — module-level callables only."""
    if ":" not in dotted:
        raise ValueError(f"target must be 'package.module:function', got {dotted!r}")
    mod_name, attr = dotted.split(":", 1)
    if "." in attr:
        raise ValueError(f"nested targets are not supported in phase 1: {dotted!r}")
    module = importlib.import_module(mod_name)
    func = getattr(module, attr)
    if not callable(func):
        raise TypeError(f"{dotted} is not callable")
    return module, attr, func


def _alias_bindings(func: Callable[..., Any], *, skip: Any = None) -> list[tuple[Any, str]]:
    """Every ``(module, name)`` in ``sys.modules`` whose global IS ``func``.

    A call site that did ``from pkg.mod import func`` holds its own
    reference, so rebinding only the defining module leaves that caller on
    the original and the recorder never sees its calls (kanban e285be58:
    three group-1 members stayed at 0-9 corpus records for that reason).
    Modules are inspected through ``__dict__`` only; anything exotic (lazy
    modules, broken ``__getattr__``) is skipped rather than imported."""
    out: list[tuple[Any, str]] = []
    for mod in list(sys.modules.values()):
        if mod is None or mod is skip:
            continue
        ns = getattr(mod, "__dict__", None)
        if not isinstance(ns, dict):
            continue
        for name, value in list(ns.items()):
            if value is func:
                out.append((mod, name))
    return out


class TargetPatch:
    """A live patch of ``pkg.mod:func``: the defining module AND every
    already-imported alias are rebound to the recording wrapper. Call
    :meth:`rebind_new_aliases` after more modules were imported (the pytest
    plugin does this once collection is complete) and :meth:`undo` to
    restore every binding."""

    def __init__(self, dotted: str, recorder: Recorder) -> None:
        self.dotted = dotted
        self.module, self.attr, self.func = resolve_target(dotted)
        self.wrapped = recorder.wrap(self.func, target=dotted)
        self._bound: list[tuple[Any, str]] = []
        setattr(self.module, self.attr, self.wrapped)
        self._bound.append((self.module, self.attr))
        self.rebind_new_aliases()

    @property
    def bindings(self) -> list[tuple[Any, str]]:
        return list(self._bound)

    def rebind_new_aliases(self) -> int:
        """Rebind aliases imported since the last call. Returns how many."""
        added = 0
        for mod, name in _alias_bindings(self.func):
            try:
                setattr(mod, name, self.wrapped)
            except Exception:  # noqa: BLE001 - read-only namespaces are skipped
                continue
            self._bound.append((mod, name))
            added += 1
        return added

    def undo(self) -> None:
        for mod, name in reversed(self._bound):
            try:
                if getattr(mod, name, None) is self.wrapped:
                    setattr(mod, name, self.func)
            except Exception:  # noqa: BLE001
                continue
        self._bound.clear()

    def __call__(self) -> None:  # backwards compatible with the old undo callable
        self.undo()


def patch_target(dotted: str, recorder: Recorder) -> TargetPatch:
    """Replace ``pkg.mod:func`` with its recording wrapper everywhere it is
    currently bound (defining module + from-imported aliases). The returned
    patch is callable as an undo and exposes ``rebind_new_aliases()``."""
    return TargetPatch(dotted, recorder)


def load_corpus(path: Path) -> list[TraceRecord]:
    out: list[TraceRecord] = []
    with Path(path).open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(TraceRecord.from_json(line))
    return out
