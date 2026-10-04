"""Pair state machine + run-DB ledger for the module_registry automation.

A *pair* is (duplicate symbol, canonical symbol). Its state records how far
the proof has gone; every transition is appended to ``pair_transitions`` with
its evidence (replay/fuzz reports, PR numbers, soak counters) — the audit
trail is complete and never truncated.

States and the ONLY legal moves (``TRANSITIONS``)::

    candidate ──classify──▶ classified ──(effectful/opaque)──▶ card
    classified ──record──▶ recording ──corpus gate──▶ corpus_ready
    corpus_ready ──replay──▶ replay_passed | replay_failed ─▶ card
    replay_passed ──fuzz──▶ fuzz_passed | fuzz_failed ─▶ card
    fuzz_passed ──open PR──▶ pr_open ──merge──▶ soaking
    pr_open ──closed/expired──▶ pr_expired ─▶ (re-enter fuzz_passed when the file changes)
    soaking ──clean 14d──▶ soak_passed ──cleanup PR──▶ reexported ──zero refs──▶ deleted
    soaking ──mismatch──▶ reverted ─▶ card
    deleted, card, reverted are terminal (card/reverted may be reopened by a human).

Consolidation GROUPS (owner refinement 2026-09-21): N originals compile into one
new version of the canonical module. Each member is a ``pairs`` row (original →
target) with its own ``route_symbol`` (how the target is invoked in place of that
original) and ``corpus_path`` (that original's recorded traffic); members share a
``consolidation_id``. Each member is PROVEN on its own traffic (replay + fuzz of
route vs original). The group moves to ``pr_open`` only when EVERY member is
``fuzz_passed``, through :meth:`Ledger.group_move`; a member of a group cannot
enter ``pr_open`` on its own. The PR budget counts openings (groups or
standalone pairs) via ``pr_openings``.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

PairState = Literal[
    "candidate", "classified", "recording", "corpus_ready",
    "replay_passed", "replay_failed", "fuzz_passed", "fuzz_failed",
    "pr_open", "pr_expired", "soaking", "soak_passed", "reverted",
    "reexported", "deleted", "card",
]

TRANSITIONS: dict[str, frozenset[str]] = {
    "candidate": frozenset({"classified", "card"}),
    "classified": frozenset({"recording", "card"}),
    "recording": frozenset({"corpus_ready", "card"}),
    "corpus_ready": frozenset({"replay_passed", "replay_failed", "card"}),
    "replay_failed": frozenset({"card"}),
    "replay_passed": frozenset({"fuzz_passed", "fuzz_failed", "card"}),
    "fuzz_failed": frozenset({"card"}),
    "fuzz_passed": frozenset({"pr_open", "card"}),
    "pr_open": frozenset({"soaking", "pr_expired", "card"}),
    "pr_expired": frozenset({"fuzz_passed", "card"}),
    "soaking": frozenset({"soak_passed", "reverted"}),
    "reverted": frozenset({"card"}),
    "soak_passed": frozenset({"reexported"}),
    "reexported": frozenset({"deleted"}),
    "deleted": frozenset(),
    "card": frozenset({"candidate"}),  # a human may reopen
}
TERMINAL: frozenset[str] = frozenset({"deleted"})
SCHEMA_PATH = Path(__file__).with_name("run_db_schema.sql")


class IllegalTransition(ValueError):
    pass


class PrCapExceeded(IllegalTransition):
    """The PR budget refuses another consolidation PR right now (owner
    question on the rollout review, 2026-09-21: bounded, never a sweep)."""


PR_STATES: frozenset[str] = frozenset({"pr_open"})
ENV_MAX_PRS_PER_DAY = "MODULE_REGISTRY_MAX_PRS_PER_DAY"
DEFAULT_MAX_PRS_PER_DAY = 1


def max_prs_per_day() -> int:
    raw = os.environ.get(ENV_MAX_PRS_PER_DAY, "").strip()
    try:
        return max(0, int(raw)) if raw else DEFAULT_MAX_PRS_PER_DAY
    except ValueError:
        return DEFAULT_MAX_PRS_PER_DAY


def check_transition(from_state: str, to_state: str) -> None:
    allowed = TRANSITIONS.get(from_state)
    if allowed is None:
        raise IllegalTransition(f"unknown state {from_state!r}")
    if to_state not in allowed:
        raise IllegalTransition(f"{from_state} → {to_state} is not allowed (allowed: {sorted(allowed)})")


def schema_sql() -> str:
    return SCHEMA_PATH.read_text(encoding="utf-8")


@dataclass
class RunRow:
    id: int
    vm_session_id: str
    mode: str
    resumed: bool


class Ledger:
    """psycopg2-backed access to the automation's run DB. The connection is
    injected so tests can use a throwaway database and the automation can
    pass the URI read from ``$HOME/.automation_run_db_uri``."""

    def __init__(self, conn: Any) -> None:
        self.conn = conn

    @classmethod
    def connect(cls, uri: str) -> "Ledger":
        import psycopg2  # local import: the harness must import without psycopg2 in the target repo

        return cls(psycopg2.connect(uri))

    def apply_schema(self) -> None:
        with self.conn.cursor() as cur:
            cur.execute(schema_sql())
        self.conn.commit()

    # ---- runs -----------------------------------------------------------
    def derive_mode(self) -> str:
        """The mode a new run is in: ``bootstrap`` until the
        ``bootstrap_complete_at`` watermark is set, ``incremental`` after."""
        return "incremental" if self.get_watermark("bootstrap_complete_at") else "bootstrap"

    def open_run(self, vm_session_id: str, mode: Optional[str] = None, head_sha: Optional[str] = None) -> RunRow:
        """Open a run row, or RESUME the open row for the same session id (a
        Claude relaunch inside the same VM must never open a second row).

        ``mode`` is recorded as given; when omitted it is derived from the
        bootstrap watermark (``derive_mode``) so ``runs.mode`` in the audit
        trail reflects the mode the run actually worked in (kanban 9351e0a3:
        a fixed 'bootstrap' default mislabeled every incremental run)."""
        if mode is None:
            mode = self.derive_mode()
        with self.conn.cursor() as cur:
            cur.execute("SELECT id, mode FROM runs WHERE vm_session_id = %s AND status = 'open' ORDER BY id DESC LIMIT 1", (vm_session_id,))
            row = cur.fetchone()
            if row:
                return RunRow(int(row[0]), vm_session_id, str(row[1]), True)
            cur.execute("INSERT INTO runs (vm_session_id, mode, head_sha) VALUES (%s, %s, %s) RETURNING id", (vm_session_id, mode, head_sha))
            new_id = int(cur.fetchone()[0])
        self.conn.commit()
        return RunRow(new_id, vm_session_id, mode, False)

    def close_run(self, run_id: int, outcome: str, counts: Optional[dict] = None, notes: Optional[str] = None) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE runs SET finished_at = now(), status = 'closed', outcome = %s, counts = %s::jsonb, notes = %s WHERE id = %s",
                (outcome, json.dumps(counts or {}), notes, run_id),
            )
        self.conn.commit()

    # ---- crawl items ----------------------------------------------------
    def upsert_crawl_item(self, run_id: int, *, path: str, language: str, blob_sha: str, fan_in: int, shared_path: bool, exports: list[str]) -> bool:
        """Insert a pending item, or refresh an existing one's inventory
        fields. Returns True when the row is new.

        Re-open rule (owner decision 2026-10-01, review vnhqnz): a
        ``cataloged`` or ``duplicate_of`` row goes back to ``pending`` when
        its blob changed (the registry entry may be stale); a
        ``not_a_module`` row goes back only when its EXPORT LIST changed,
        because an app module does not become a shared module by editing a
        body (18 such rows churned in pilot run 11). ``retired`` never
        re-opens here."""
        with self.conn.cursor() as cur:
            cur.execute("SELECT blob_sha, status, exports FROM crawl_items WHERE path = %s", (path,))
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    "INSERT INTO crawl_items (path, language, blob_sha, fan_in, shared_path, exports, first_seen_run) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)",
                    (path, language, blob_sha, fan_in, shared_path, json.dumps(exports), run_id),
                )
                self.conn.commit()
                return True
            old_sha, status, old_exports = row[0], str(row[1]), row[2]
            blob_changed = old_sha != blob_sha
            exports_changed = sorted(old_exports or []) != sorted(exports)
            reopen = (status in ("cataloged", "duplicate_of") and blob_changed) or (status == "not_a_module" and exports_changed)
            cur.execute(
                "UPDATE crawl_items SET language = %s, blob_sha = %s, fan_in = %s, shared_path = %s, exports = %s::jsonb, "
                "status = CASE WHEN %s THEN 'pending' ELSE status END, updated_at = now() WHERE path = %s",
                (language, blob_sha, fan_in, shared_path, json.dumps(exports), reopen, path),
            )
        self.conn.commit()
        return False

    def prune_pending_non_candidates(self, run_id: int, candidate_paths: set[str], *, reason: str) -> int:
        """Close every NEVER-decided ``pending`` row whose path is not a
        current scan candidate as ``not_a_module`` with ``reason`` (the
        scanner rules changed or the file fell below the threshold). Rows
        that carry an earlier decision are left alone: they re-enter only
        through the re-open rule and keep their history. Returns the count."""
        with self.conn.cursor() as cur:
            cur.execute("SELECT path FROM crawl_items WHERE status = 'pending' AND decided_in_run IS NULL")
            stale = [str(r[0]) for r in cur.fetchall() if str(r[0]) not in candidate_paths]
            if stale:
                cur.execute(
                    "UPDATE crawl_items SET status = 'not_a_module', reason = %s, decided_in_run = %s, decided_at = now(), updated_at = now() WHERE path = ANY(%s)",
                    (reason, run_id, stale),
                )
        self.conn.commit()
        return len(stale)

    def decide_crawl_item(self, run_id: int, path: str, status: str, *, purity: Optional[str] = None, kb_entry_id: Optional[str] = None, duplicate_of: Optional[str] = None, reason: Optional[str] = None, kb_id_pending: bool = False) -> None:
        """``kb_id_pending`` marks ``kb_entry_id`` as a report_learning pending
        id that may never materialize; it applies only when an id is passed
        (a decide without ``kb_entry_id`` keeps both the id and its flag)."""
        if status not in {"cataloged", "not_a_module", "duplicate_of", "retired"}:
            raise ValueError(f"invalid decision {status!r}")
        if kb_id_pending and not kb_entry_id:
            raise ValueError("kb_id_pending needs the kb_entry_id it marks")
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE crawl_items SET status = %s, purity = COALESCE(%s, purity), kb_entry_id = COALESCE(%s, kb_entry_id), "
                "kb_id_pending = CASE WHEN %s THEN %s ELSE kb_id_pending END, duplicate_of = %s, reason = %s, decided_in_run = %s, decided_at = now(), updated_at = now() WHERE path = %s",
                (status, purity, kb_entry_id, kb_entry_id is not None, kb_id_pending, duplicate_of, reason, run_id, path),
            )
            if cur.rowcount == 0:
                raise KeyError(path)
        self.conn.commit()

    def kb_id_rows(self) -> list[dict]:
        """Every cataloged row's kb_entry_id, for the agent to resolve against
        the KB (get_kb_entry) before ``verify_kb_ids``."""
        with self.conn.cursor() as cur:
            cur.execute("SELECT path, kb_entry_id, kb_id_pending, decided_in_run FROM crawl_items WHERE status = 'cataloged' AND kb_entry_id IS NOT NULL ORDER BY path")
            cols = ["path", "kb_entry_id", "kb_id_pending", "decided_in_run"]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    def verify_kb_ids(self, run_id: int, resolved: dict[str, bool]) -> dict:
        """Apply the agent's KB resolution (``{kb_entry_id: found}``) to every
        cataloged row. A live id clears ``kb_id_pending``; a dead id records a
        carry-forward ``dead_kb_entry_id`` finding; an id missing from
        ``resolved`` is reported as unchecked (nothing is written for it; a
        still-pending one is flagged again at close)."""
        live: list[str] = []
        dead: list[dict] = []
        unchecked: list[dict] = []
        for row in self.kb_id_rows():
            found = resolved.get(row["kb_entry_id"])
            if found is True:
                live.append(row["path"])
            elif found is False:
                dead.append(row)
            else:
                unchecked.append({"path": row["path"], "kb_entry_id": row["kb_entry_id"]})
        if live:
            with self.conn.cursor() as cur:
                cur.execute("UPDATE crawl_items SET kb_id_pending = false, updated_at = now() WHERE path = ANY(%s) AND kb_id_pending", (live,))
            self.conn.commit()
        dead_out = []
        for row in dead:
            fid = self.add_finding(run_id, "dead_kb_entry_id", path=row["path"], action="repoint", carry_forward=True,
                                   note="kb_entry_id resolves to no KB entry; re-point with ledger decide --kb-entry-id <live id>",
                                   detail={"kb_entry_id": row["kb_entry_id"], "kb_id_pending": row["kb_id_pending"], "decided_in_run": row["decided_in_run"]})
            dead_out.append({"path": row["path"], "kb_entry_id": row["kb_entry_id"], "finding_id": fid})
        return {"ok": not dead_out, "live": len(live), "dead": dead_out, "unchecked": unchecked}

    def flag_pending_kb_ids(self, run_id: int) -> list[dict]:
        """Record a carry-forward ``pending_kb_entry_id`` finding for every
        cataloged row still holding an unconfirmed pending id (called at close)."""
        out = []
        for row in self.kb_id_rows():
            if not row["kb_id_pending"]:
                continue
            fid = self.add_finding(run_id, "pending_kb_entry_id", path=row["path"], action="repoint", carry_forward=True,
                                   note="kb_entry_id is still an unconfirmed report_learning pending id",
                                   detail={"kb_entry_id": row["kb_entry_id"], "decided_in_run": row["decided_in_run"]})
            out.append({"path": row["path"], "kb_entry_id": row["kb_entry_id"], "finding_id": fid})
        return out

    def pending_items(self, limit: int) -> list[dict]:
        """Pending rows, highest value first. ``reopened`` is true when the
        row carries an earlier decision (kb_entry_id / purity / reason /
        decided_in_run are that decision's), so the agent edits the existing
        registry entry instead of writing a second one (KB 318c795c)."""
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT path, language, blob_sha, fan_in, shared_path, exports, kb_entry_id, purity, reason, decided_in_run, (decided_in_run IS NOT NULL) AS reopened "
                "FROM crawl_items WHERE status = 'pending' ORDER BY shared_path DESC, fan_in DESC, path LIMIT %s", (limit,))
            cols = ["path", "language", "blob_sha", "fan_in", "shared_path", "exports", "kb_entry_id", "purity", "reason", "decided_in_run", "reopened"]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    # ---- pairs ----------------------------------------------------------
    def ensure_pair(self, run_id: int, *, duplicate_path: str, duplicate_symbol: str, canonical_path: str, canonical_symbol: str, purity: str, duplicate_blob_sha: Optional[str] = None, canonical_blob_sha: Optional[str] = None) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO pairs (duplicate_path, duplicate_symbol, canonical_path, canonical_symbol, purity, duplicate_blob_sha, canonical_blob_sha, created_in_run, updated_in_run) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (duplicate_path, duplicate_symbol, canonical_path, canonical_symbol) DO UPDATE SET updated_at = now() RETURNING id",
                (duplicate_path, duplicate_symbol, canonical_path, canonical_symbol, purity, duplicate_blob_sha, canonical_blob_sha, run_id, run_id),
            )
            pair_id = int(cur.fetchone()[0])
        self.conn.commit()
        return pair_id

    def pair_state(self, pair_id: int) -> str:
        with self.conn.cursor() as cur:
            cur.execute("SELECT state FROM pairs WHERE id = %s", (pair_id,))
            row = cur.fetchone()
        if row is None:
            raise KeyError(pair_id)
        return str(row[0])

    def transition_pair(self, run_id: Optional[int], pair_id: int, to_state: str, evidence: Optional[dict] = None, _group_member_move: bool = False, **columns: Any) -> None:
        """Move a pair, validating against TRANSITIONS, and append the
        evidence row atomically. Extra ``columns`` (pr_number, card_id,
        corpus_size, soak_started_at, soak_calls) are updated in the same
        statement."""
        allowed_cols = {"pr_number", "card_id", "corpus_size", "soak_started_at", "soak_calls", "duplicate_blob_sha", "canonical_blob_sha", "route_symbol", "corpus_path"}
        bad = set(columns) - allowed_cols
        if bad:
            raise ValueError(f"unknown pair columns: {sorted(bad)}")
        with self.conn.cursor() as cur:
            cur.execute("SELECT state FROM pairs WHERE id = %s FOR UPDATE", (pair_id,))
            row = cur.fetchone()
            if row is None:
                self.conn.rollback()
                raise KeyError(pair_id)
            from_state = str(row[0])
            try:
                check_transition(from_state, to_state)
                if to_state in PR_STATES and not _group_member_move:
                    cur.execute("SELECT consolidation_id FROM pairs WHERE id = %s", (pair_id,))
                    if cur.fetchone()[0] is not None:
                        raise IllegalTransition("this pair belongs to a consolidation group; open the PR with group_move (all members together)")
                    self._check_pr_cap(cur, pair_id)
            except IllegalTransition:
                self.conn.rollback()
                raise
            sets = ["state = %s", "updated_in_run = %s", "updated_at = now()"]
            params: list[Any] = [to_state, run_id]
            for col, val in columns.items():
                sets.append(f"{col} = %s")
                params.append(val)
            params.append(pair_id)
            cur.execute(f"UPDATE pairs SET {', '.join(sets)} WHERE id = %s", params)
            cur.execute(
                "INSERT INTO pair_transitions (pair_id, run_id, from_state, to_state, evidence) VALUES (%s, %s, %s, %s, %s::jsonb)",
                (pair_id, run_id, from_state, to_state, json.dumps(evidence or {})),
            )
            if to_state in PR_STATES and not _group_member_move:
                cur.execute("INSERT INTO pr_openings (pair_id, pr_number, run_id) VALUES (%s, %s, %s)", (pair_id, columns.get("pr_number"), run_id))
        if not _group_member_move:
            self.conn.commit()

    def _check_pr_cap(self, cur: Any, pair_id: int) -> None:
        """Deterministic PR budget: bootstrap must be complete, at most one
        pair may sit in ``pr_open``, and at most ``max_prs_per_day()`` pairs
        may ENTER ``pr_open`` per UTC calendar day (0 disables PRs)."""
        cur.execute("SELECT value FROM watermarks WHERE key = 'bootstrap_complete_at'")
        if cur.fetchone() is None:
            raise PrCapExceeded("no consolidation PR until bootstrap_complete_at is set (registry first)")
        cur.execute("SELECT consolidation_id FROM pairs WHERE id = %s", (pair_id,))
        row = cur.fetchone()
        own_group = row[0] if row else None
        cur.execute(
            "SELECT id FROM pairs WHERE state = ANY(%s) AND id <> %s AND (consolidation_id IS NULL OR consolidation_id IS DISTINCT FROM %s) ORDER BY id LIMIT 1",
            (list(PR_STATES), pair_id, own_group),
        )
        other = cur.fetchone()
        if other is not None:
            raise PrCapExceeded(f"pair {int(other[0])} already has a consolidation PR open; one at a time")
        cap = max_prs_per_day()
        cur.execute("SELECT count(*) FROM pr_openings WHERE opened_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")
        opened_today = int(cur.fetchone()[0])
        if opened_today >= cap:
            raise PrCapExceeded(f"{opened_today} consolidation PR(s) already opened today; cap is {cap} per day ({ENV_MAX_PRS_PER_DAY})")

    def pr_budget(self) -> dict:
        """What the cap would say right now (for the agent's planning)."""
        with self.conn.cursor() as cur:
            cur.execute("SELECT value FROM watermarks WHERE key = 'bootstrap_complete_at'")
            bootstrap_done = cur.fetchone() is not None
            cur.execute("SELECT count(*) FROM pr_openings WHERE opened_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")
            opened_today = int(cur.fetchone()[0])
            cur.execute("SELECT count(DISTINCT coalesce(consolidation_id::text, 'pair:' || id::text)) FROM pairs WHERE state = ANY(%s)", (list(PR_STATES),))
            open_prs = int(cur.fetchone()[0])
        cap = max_prs_per_day()
        return {"bootstrap_complete": bootstrap_done, "open_prs": open_prs, "opened_today": opened_today, "max_per_day": cap,
                "can_open_pr": bootstrap_done and open_prs == 0 and opened_today < cap}

    def pairs_in_state(self, *states: str) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute("SELECT id, duplicate_path, duplicate_symbol, canonical_path, canonical_symbol, purity, state, pr_number, card_id, soak_started_at, soak_calls, consolidation_id, route_symbol, corpus_path FROM pairs WHERE state = ANY(%s) ORDER BY id", (list(states),))
            cols = ["id", "duplicate_path", "duplicate_symbol", "canonical_path", "canonical_symbol", "purity", "state", "pr_number", "card_id", "soak_started_at", "soak_calls", "consolidation_id", "route_symbol", "corpus_path"]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    # ---- consolidation groups ------------------------------------------
    GROUP_KINDS = ("adopt_canonical", "merged_version")

    def ensure_consolidation(self, run_id: int, *, target_path: str, target_symbol: str, kind: str, note: Optional[str] = None) -> int:
        if kind not in self.GROUP_KINDS:
            raise ValueError(f"kind must be one of {self.GROUP_KINDS}")
        with self.conn.cursor() as cur:
            cur.execute("SELECT id FROM consolidations WHERE target_path = %s AND target_symbol = %s AND state NOT IN ('deleted', 'card', 'reverted') ORDER BY id DESC LIMIT 1", (target_path, target_symbol))
            row = cur.fetchone()
            if row is not None:
                return int(row[0])
            cur.execute(
                "INSERT INTO consolidations (target_path, target_symbol, kind, note, created_in_run, updated_in_run) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (target_path, target_symbol, kind, note, run_id, run_id),
            )
            cid = int(cur.fetchone()[0])
        self.conn.commit()
        return cid

    def attach_member(self, pair_id: int, consolidation_id: int, *, route_symbol: Optional[str] = None, corpus_path: Optional[str] = None) -> None:
        with self.conn.cursor() as cur:
            cur.execute("SELECT state FROM consolidations WHERE id = %s", (consolidation_id,))
            row = cur.fetchone()
            if row is None:
                raise KeyError(consolidation_id)
            if str(row[0]) != "open":
                self.conn.rollback()
                raise IllegalTransition(f"consolidation {consolidation_id} is {row[0]}; members can only be attached while it is open")
            cur.execute(
                "UPDATE pairs SET consolidation_id = %s, route_symbol = COALESCE(%s, route_symbol), corpus_path = COALESCE(%s, corpus_path), updated_at = now() WHERE id = %s",
                (consolidation_id, route_symbol, corpus_path, pair_id),
            )
            if cur.rowcount == 0:
                self.conn.rollback()
                raise KeyError(pair_id)
        self.conn.commit()

    def group_members(self, consolidation_id: int) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute("SELECT id, duplicate_path, duplicate_symbol, state, route_symbol, corpus_path FROM pairs WHERE consolidation_id = %s ORDER BY id", (consolidation_id,))
            cols = ["id", "duplicate_path", "duplicate_symbol", "state", "route_symbol", "corpus_path"]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    def groups_in_state(self, *states: str) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute("SELECT id, target_path, target_symbol, kind, state, pr_number, card_id FROM consolidations WHERE state = ANY(%s) ORDER BY id", (list(states),))
            cols = ["id", "target_path", "target_symbol", "kind", "state", "pr_number", "card_id"]
            out = [dict(zip(cols, r)) for r in cur.fetchall()]
        for g in out:
            g["members"] = self.group_members(g["id"])
        return out

    def group_move(self, run_id: Optional[int], consolidation_id: int, to_state: str, evidence: Optional[dict] = None, **columns: Any) -> None:
        """Move every member of a group together (each member transition is
        validated; one refusal rolls the whole move back). Entering
        ``pr_open`` additionally requires every member to be ``fuzz_passed``
        and passes the PR budget once for the group."""
        members = self.group_members(consolidation_id)
        if not members:
            raise IllegalTransition(f"consolidation {consolidation_id} has no members")
        if to_state in PR_STATES:
            not_ready = [m for m in members if m["state"] != "fuzz_passed"]
            if not_ready:
                raise IllegalTransition("every member must be fuzz_passed before the group PR opens; not ready: " + ", ".join(f"{m['duplicate_path']}:{m['duplicate_symbol']}={m['state']}" for m in not_ready))
            if any(not m["route_symbol"] for m in members):
                raise IllegalTransition("every member needs a route_symbol before the group PR opens")
            with self.conn.cursor() as cur:
                try:
                    self._check_pr_cap(cur, members[0]["id"])
                except IllegalTransition:
                    self.conn.rollback()
                    raise
        try:
            for m in members:
                self.transition_pair(run_id, int(m["id"]), to_state, evidence, _group_member_move=True, **columns)
            with self.conn.cursor() as cur:
                cur.execute(
                    "UPDATE consolidations SET state = %s, pr_number = COALESCE(%s, pr_number), card_id = COALESCE(%s, card_id), updated_in_run = %s, updated_at = now() WHERE id = %s",
                    (to_state, columns.get("pr_number"), columns.get("card_id"), run_id, consolidation_id),
                )
                if to_state in PR_STATES:
                    cur.execute("INSERT INTO pr_openings (consolidation_id, pr_number, run_id) VALUES (%s, %s, %s)", (consolidation_id, columns.get("pr_number"), run_id))
        except Exception:
            self.conn.rollback()
            raise
        self.conn.commit()

    # ---- findings / watermarks -----------------------------------------
    def add_finding(self, run_id: int, kind: str, *, path: Optional[str] = None, canonical_path: Optional[str] = None, pair_id: Optional[int] = None, action: Optional[str] = None, card_id: Optional[str] = None, pr_number: Optional[int] = None, note: Optional[str] = None, carry_forward: bool = False, detail: Optional[dict] = None) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO findings (run_id, kind, path, canonical_path, pair_id, action, card_id, pr_number, note, carry_forward, detail) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb) RETURNING id",
                (run_id, kind, path, canonical_path, pair_id, action, card_id, pr_number, note, carry_forward, json.dumps(detail or {})),
            )
            fid = int(cur.fetchone()[0])
        self.conn.commit()
        return fid

    def add_shadow_observation(self, pair_id: int, *, calls: int, shadowed: int, mismatched: int, shadow_time_s: float = 0.0, detail: Optional[dict] = None) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO shadow_observations (pair_id, calls, shadowed, mismatched, shadow_time_s, detail) VALUES (%s, %s, %s, %s, %s, %s::jsonb) RETURNING id",
                (pair_id, calls, shadowed, mismatched, shadow_time_s, json.dumps(detail or {})),
            )
            oid = int(cur.fetchone()[0])
            cur.execute("UPDATE pairs SET soak_calls = soak_calls + %s, updated_at = now() WHERE id = %s", (shadowed, pair_id))
        self.conn.commit()
        return oid

    def set_watermark(self, key: str, value: str) -> None:
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO watermarks (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", (key, value))
        self.conn.commit()

    def get_watermark(self, key: str) -> Optional[str]:
        with self.conn.cursor() as cur:
            cur.execute("SELECT value FROM watermarks WHERE key = %s", (key,))
            row = cur.fetchone()
        return None if row is None else str(row[0])

    def summary(self) -> dict:
        with self.conn.cursor() as cur:
            cur.execute("SELECT status, count(*) FROM crawl_items GROUP BY status")
            crawl = {r[0]: int(r[1]) for r in cur.fetchall()}
            cur.execute("SELECT state, count(*) FROM pairs GROUP BY state")
            pairs = {r[0]: int(r[1]) for r in cur.fetchall()}
            cur.execute("SELECT count(*) FROM runs WHERE status = 'open'")
            open_runs = int(cur.fetchone()[0])
            cur.execute("SELECT state, count(*) FROM consolidations GROUP BY state")
            groups = {r[0]: int(r[1]) for r in cur.fetchall()}
        return {"crawl_items": crawl, "pairs": pairs, "groups": groups, "open_runs": open_runs,
                "bootstrap_complete": crawl.get("pending", 0) == 0 and bool(crawl),
                "pr_budget": self.pr_budget()}
