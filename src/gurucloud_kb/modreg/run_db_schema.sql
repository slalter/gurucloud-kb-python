-- Prescribed run-DB schema for the module_registry automation (idempotent).
-- One database per automation (get_automation_run_db); same shape on every
-- repository so bootstrap progress and pair state are queryable fleet-wide.

CREATE TABLE IF NOT EXISTS runs (
    id              BIGSERIAL PRIMARY KEY,
    vm_session_id   TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    mode            TEXT NOT NULL CHECK (mode IN ('bootstrap', 'incremental')),
    head_sha        TEXT,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    outcome         TEXT,
    counts          JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS runs_open_idx ON runs (vm_session_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS crawl_items (
    path            TEXT PRIMARY KEY,
    language        TEXT NOT NULL,
    blob_sha        TEXT NOT NULL,
    fan_in          INTEGER NOT NULL DEFAULT 0,
    shared_path     BOOLEAN NOT NULL DEFAULT false,
    exports         JSONB NOT NULL DEFAULT '[]'::jsonb,
    purity          TEXT CHECK (purity IN ('pure', 'nondeterministic', 'effectful')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'cataloged', 'not_a_module', 'duplicate_of', 'retired')),
    kb_entry_id     TEXT,
    duplicate_of    TEXT,
    reason          TEXT,
    first_seen_run  BIGINT REFERENCES runs(id),
    decided_in_run  BIGINT REFERENCES runs(id),
    decided_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crawl_items_status_idx ON crawl_items (status);
-- true while kb_entry_id is a report_learning pending id not yet re-pointed to the
-- materialized entry; `ledger close` reports these and `ledger verify-kb-ids` clears them.
ALTER TABLE crawl_items ADD COLUMN IF NOT EXISTS kb_id_pending BOOLEAN NOT NULL DEFAULT false;

-- Duplicate → canonical pairs and their proof state machine (services/module_registry/pairs.py).
CREATE TABLE IF NOT EXISTS pairs (
    id              BIGSERIAL PRIMARY KEY,
    duplicate_path  TEXT NOT NULL,
    duplicate_symbol TEXT NOT NULL,
    canonical_path  TEXT NOT NULL,
    canonical_symbol TEXT NOT NULL,
    purity          TEXT NOT NULL CHECK (purity IN ('pure', 'nondeterministic', 'effectful')),
    state           TEXT NOT NULL DEFAULT 'candidate',
    duplicate_blob_sha TEXT,
    canonical_blob_sha TEXT,
    corpus_size     INTEGER NOT NULL DEFAULT 0,
    pr_number       INTEGER,
    card_id         TEXT,
    soak_started_at TIMESTAMPTZ,
    soak_calls      INTEGER NOT NULL DEFAULT 0,
    created_in_run  BIGINT REFERENCES runs(id),
    updated_in_run  BIGINT REFERENCES runs(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (duplicate_path, duplicate_symbol, canonical_path, canonical_symbol)
);
CREATE INDEX IF NOT EXISTS pairs_state_idx ON pairs (state);

-- Append-only transition log: every state change with its full evidence.
CREATE TABLE IF NOT EXISTS pair_transitions (
    id              BIGSERIAL PRIMARY KEY,
    pair_id         BIGINT NOT NULL REFERENCES pairs(id),
    run_id          BIGINT REFERENCES runs(id),
    from_state      TEXT NOT NULL,
    to_state        TEXT NOT NULL,
    evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pair_transitions_pair_idx ON pair_transitions (pair_id, created_at);

CREATE TABLE IF NOT EXISTS findings (
    id              BIGSERIAL PRIMARY KEY,
    run_id          BIGINT REFERENCES runs(id),
    kind            TEXT NOT NULL,
    path            TEXT,
    canonical_path  TEXT,
    pair_id         BIGINT REFERENCES pairs(id),
    action          TEXT,
    card_id         TEXT,
    pr_number       INTEGER,
    expires_at      TIMESTAMPTZ,
    carry_forward   BOOLEAN NOT NULL DEFAULT false,
    note            TEXT,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watermarks (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shadow-soak observations pulled back from production logs, one row per mismatch or per daily rollup.
CREATE TABLE IF NOT EXISTS shadow_observations (
    id              BIGSERIAL PRIMARY KEY,
    pair_id         BIGINT NOT NULL REFERENCES pairs(id),
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    calls           INTEGER NOT NULL DEFAULT 0,
    shadowed        INTEGER NOT NULL DEFAULT 0,
    mismatched      INTEGER NOT NULL DEFAULT 0,
    shadow_time_s   DOUBLE PRECISION NOT NULL DEFAULT 0,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Consolidation GROUPS (owner refinement 2026-09-21, review 97646626): N originals compile into ONE
-- new version of the canonical module; each original keeps a route into it and is validated on
-- its own recorded traffic. Members are `pairs` rows (original → target) sharing a consolidation_id.
CREATE TABLE IF NOT EXISTS consolidations (
    id              BIGSERIAL PRIMARY KEY,
    target_path     TEXT NOT NULL,
    target_symbol   TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('adopt_canonical', 'merged_version')),
    state           TEXT NOT NULL DEFAULT 'open',
    pr_number       INTEGER,
    card_id         TEXT,
    note            TEXT,
    created_in_run  BIGINT REFERENCES runs(id),
    updated_in_run  BIGINT REFERENCES runs(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS consolidation_id BIGINT REFERENCES consolidations(id);
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS route_symbol TEXT;   -- pkg.mod:fn that invokes the target in place of this original
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS corpus_path TEXT;    -- recorded traffic of THIS original
CREATE INDEX IF NOT EXISTS pairs_consolidation_idx ON pairs (consolidation_id);

-- Every consolidation PR opening (the unit the daily cap counts): a group or a standalone pair.
CREATE TABLE IF NOT EXISTS pr_openings (
    id              BIGSERIAL PRIMARY KEY,
    consolidation_id BIGINT REFERENCES consolidations(id),
    pair_id         BIGINT REFERENCES pairs(id),
    pr_number       INTEGER,
    run_id          BIGINT REFERENCES runs(id),
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
