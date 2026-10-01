"""pytest plugin: harvest a trace corpus from a repository's own test suite.

Activate with ``-p services.module_registry.trace_plugin`` (in-repo) or
``-p gurucloud_kb.modreg.trace_plugin`` (gurucloud-kb wheel) and:

    MODULE_REGISTRY_TRACE_TARGETS="pkg.mod:func,pkg.other:helper"
    MODULE_REGISTRY_TRACE_OUT=/path/to/corpus.jsonl

Every listed module-level callable is wrapped at 100% sampling for the whole
session; the corpus file is flushed at session finish. Nothing happens when
the env vars are unset, so registering the plugin unconditionally is safe.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_STATE: dict[str, Any] = {"undo": [], "sink": None, "recorder": None}


def pytest_configure(config: Any) -> None:
    targets = [t.strip() for t in os.environ.get("MODULE_REGISTRY_TRACE_TARGETS", "").split(",") if t.strip()]
    out = os.environ.get("MODULE_REGISTRY_TRACE_OUT")
    if not targets or not out:
        return
    from .tracer import Budget, JsonlSink, Recorder, patch_target

    sink = JsonlSink(Path(out))
    recorder = Recorder(sink, sample_rate=1.0, budget=Budget(max_fraction=1.0, max_total_s=1e9, min_wall_s=1e9))
    _STATE["sink"], _STATE["recorder"] = sink, recorder
    for target in targets:
        _STATE["undo"].append(patch_target(target, recorder))


def pytest_collection_finish(session: Any) -> None:
    """Collection imports the test modules (and whatever they import); any
    ``from pkg.mod import func`` binding created since configure still holds
    the ORIGINAL, so rebind those aliases before the first test runs."""
    rebound = 0
    for patch in _STATE["undo"]:
        rebind = getattr(patch, "rebind_new_aliases", None)
        if rebind is not None:
            rebound += int(rebind())
    _STATE["rebound_after_collection"] = rebound


def pytest_sessionfinish(session: Any, exitstatus: Any) -> None:
    # count alias bindings BEFORE undo clears them (the summary line below reports them)
    _STATE["aliases"] = sum(max(0, len(getattr(p, "bindings", [])) - 1) for p in _STATE["undo"])
    for undo in _STATE["undo"]:
        undo()
    _STATE["undo"] = []
    sink = _STATE.get("sink")
    if sink is not None:
        sink.close()
        rec = _STATE["recorder"]
        aliases = _STATE.get("aliases", 0)
        print(f"\n[module_registry] corpus: {sink.written} records written, {sink.dropped} dropped, {rec.errors} tracer errors, "
              f"{aliases} from-import aliases rebound ({_STATE.get('rebound_after_collection', 0)} after collection) → {sink.path}")
