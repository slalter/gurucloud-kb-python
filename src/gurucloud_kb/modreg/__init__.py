"""Module registry: per-repository catalog of canonical shared modules and
the proof harness that lets the ``module_registry`` automation consolidate
duplicates fully automatically.

Owner-approved design (review thread wjwruy, 2026-09-21; kanban 0eefe289):

* The catalog agents see is the repository's engineering Knowledge Bank —
  one entry per canonical module with ``metadata.kind == "module"``, its path
  verified on main. Nothing is committed to the target repository.
* "What is left" lives in the automation's private run-log database
  (``get_automation_run_db``): ``crawl_items`` for the bootstrap inventory,
  ``pairs`` for the duplicate → canonical state machine, ``findings`` and
  ``runs`` for the ledger. The DDL is prescribed (``run_db_schema.sql``) so
  every repository's ledger is queryable the same way.
* The same source ships inside the ``gurucloud-kb`` PyPI package as
  ``gurucloud_kb.modreg`` (``pip install "gurucloud-kb[modreg]"``) so foreign
  repositories run the identical harness; ``scripts/check_modreg_mirror.py``
  keeps the two trees byte-identical (``repo_flag.py`` is platform-only and
  stays out of the wheel).
* A duplicate is replaced only when it is PROVEN equivalent: recorded real
  inputs/outputs (``tracer``) replayed byte for byte (``replay``), extended by
  differential fuzzing (``fuzz``), then verified in production by a shadow
  shim (``shadow``) before the old code is deleted.

Modules:
    scan       export scanner + import fan-in ranking (Python AST, TS regex)
    purity     AST purity classifier (pure / effectful / nondeterministic)
    serialize  canonical byte-stable serialization of args / results / errors
    tracer     record real calls (decorator, queued non-blocking sink, caps)
    trace_plugin  pytest plugin: harvest a corpus from the repo's own test suite
    replay     replay a recorded corpus against a candidate, compare bytes
    fuzz       Hypothesis-driven differential fuzzing from hints + corpus
    shadow     production shadow-compare shim (sampled, self-budgeting)
    pairs      pair FSM + run-DB access (psycopg2), prescribed schema
    cli        ``python -m services.module_registry <command>`` (``python -m gurucloud_kb.modreg`` from the wheel)
"""
