"""Production shadow-compare shim.

During the soak the duplicate's old location is replaced by::

    from .shadow import shadow_compare
    from services.shared.canonical import slugify as _canonical
    def slugify(*a, **k):          # kept until the soak passes
        ...old body...
    slugify = shadow_compare(_canonical, slugify, name="services.old:slugify")

Every call returns the CANONICAL result. On a sampled fraction the old body
also runs and the two canonical outcomes are compared; a mismatch goes to the
sink (default: an ERROR log line with marker ``module_registry.shadow_mismatch``
that the automation reads back from Cloud Logging and turns into an automatic
revert). Guarantees, per the owner's overhead question (review thread wjwruy):

* sampling is one random draw per call; the shadow never runs otherwise;
* the shadow body runs AFTER the primary result exists and cannot change it;
  any exception inside the shadow path or the sink is swallowed and counted;
* a process-wide :class:`ShadowBudget` disables shadowing when cumulative
  shadow time exceeds a fraction of wall time or an absolute cap;
* ``MODULE_REGISTRY_SHADOW=off`` disables every shim without a deploy;
* effectful functions must never be shimmed (double side effects) — the
  purity classifier gates that upstream; :func:`shadow_compare` only sees
  callables the pipeline already proved pure.
"""
from __future__ import annotations

import functools
import logging
import os
import random
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .serialize import outcome_bytes

ENV_KILL_SWITCH = "MODULE_REGISTRY_SHADOW"
MISMATCH_MARKER = "module_registry.shadow_mismatch"
ROLLUP_MARKER = "module_registry.shadow_rollup"
ROLLUP_EVERY = 1000
logger = logging.getLogger("module_registry.shadow")


def kill_switch_on() -> bool:
    return os.environ.get(ENV_KILL_SWITCH, "").strip().lower() in {"off", "0", "false", "no"}


@dataclass
class ShadowBudget:
    max_fraction: float = 0.005
    max_total_s: float = 30.0
    min_wall_s: float = 5.0
    started: float = field(default_factory=time.monotonic)
    spent_s: float = 0.0
    tripped: bool = False
    trip_reason: Optional[str] = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def charge(self, seconds: float) -> None:
        with self._lock:
            self.spent_s += seconds
            if self.tripped:
                return
            if self.spent_s > self.max_total_s:
                self.tripped, self.trip_reason = True, f"total {self.spent_s:.3f}s > {self.max_total_s}s"
                return
            wall = time.monotonic() - self.started
            if wall >= self.min_wall_s and self.spent_s / wall > self.max_fraction:
                self.tripped, self.trip_reason = True, f"fraction {self.spent_s / wall:.4f} > {self.max_fraction}"


GLOBAL_BUDGET = ShadowBudget()


@dataclass
class ShadowStats:
    name: str
    calls: int = 0
    shadowed: int = 0
    matched: int = 0
    mismatched: int = 0
    shadow_errors: int = 0
    shadow_time_s: float = 0.0

    def as_dict(self) -> dict:
        return dict(self.__dict__)


_REGISTRY: dict[str, ShadowStats] = {}


def all_stats() -> dict[str, dict]:
    return {k: v.as_dict() for k, v in _REGISTRY.items()}


def log_sink(name: str, args: tuple, kwargs: dict, primary: bytes, shadow: bytes) -> None:
    logger.error(
        "%s name=%s", MISMATCH_MARKER, name,
        extra={"marker": MISMATCH_MARKER, "shim": name, "primary": primary.decode("utf-8", "replace"),
               "shadow": shadow.decode("utf-8", "replace"), "argc": len(args), "kwarg_keys": sorted(kwargs)},
    )


def shadow_compare(
    primary: Callable[..., Any],
    shadow: Callable[..., Any],
    *,
    name: str,
    sample_rate: float = 0.01,
    budget: Optional[ShadowBudget] = None,
    sink: Callable[[str, tuple, dict, bytes, bytes], None] = log_sink,
    rng: Optional[random.Random] = None,
) -> Callable[..., Any]:
    if not 0.0 <= sample_rate <= 1.0:
        raise ValueError("sample_rate must be within [0, 1]")
    budget = budget or GLOBAL_BUDGET
    draw = (rng or random.Random()).random
    stats = _REGISTRY.setdefault(name, ShadowStats(name=name))

    @functools.wraps(primary)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        stats.calls += 1
        try:
            result = primary(*args, **kwargs)
        except BaseException as exc:
            primary_outcome: Optional[bytes] = None
            if budget.tripped or kill_switch_on() or draw() >= sample_rate:
                raise
            primary_outcome = _safe_outcome(error=exc)
            _shadow(args, kwargs, primary_outcome)
            raise
        if budget.tripped or kill_switch_on() or draw() >= sample_rate:
            return result
        _shadow(args, kwargs, _safe_outcome(result=result))
        return result

    def _safe_outcome(*, result: Any = None, error: Optional[BaseException] = None) -> Optional[bytes]:
        try:
            return outcome_bytes(result=result, error=error)
        except Exception:
            return None

    def _shadow(args: tuple, kwargs: dict, primary_outcome: Optional[bytes]) -> None:
        t0 = time.perf_counter()
        stats.shadowed += 1
        try:
            if primary_outcome is None:
                stats.shadow_errors += 1
                return
            try:
                shadow_outcome = outcome_bytes(result=shadow(*args, **kwargs))
            except BaseException as exc:  # noqa: BLE001 - the exception IS the outcome
                shadow_outcome = outcome_bytes(error=exc)
            if shadow_outcome == primary_outcome:
                stats.matched += 1
            else:
                stats.mismatched += 1
                try:
                    sink(name, args, kwargs, primary_outcome, shadow_outcome)
                except Exception:
                    stats.shadow_errors += 1
            if stats.shadowed == 1 or stats.shadowed % ROLLUP_EVERY == 0:
                rollup = {f"shim_{k}": v for k, v in stats.as_dict().items() if k != "name"}
                logger.info("%s name=%s", ROLLUP_MARKER, name, extra={"marker": ROLLUP_MARKER, "shim": name, **rollup})
        except Exception:
            stats.shadow_errors += 1
        finally:
            spent = time.perf_counter() - t0
            stats.shadow_time_s += spent
            budget.charge(spent)

    setattr(wrapper, "__module_registry_shadow__", (primary, shadow, stats))
    return wrapper
