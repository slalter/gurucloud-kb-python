# GuruCloud KB SDK

Python SDK for the GuruCloud Knowledge Bank API — a multi-dimensional,
**semantic** vector store. Every Knowledge Bank has a configurable *dimension
schema*: each dimension is its own embedding space, and search is a weighted
combination across the dimensions you choose.

```bash
pip install gurucloud-kb
```

## Authenticate

```python
from gurucloud_kb import GuruCloudClient

client = GuruCloudClient(api_key="kb_your_api_key")   # keys start with "kb_"
```

API keys carry scopes: `read` (search, list), `write` (add/update entries),
`admin` (create/delete KBs, change the schema).

---

## Mental model (read this first)

A Knowledge Bank is **not** a single vector index. It is a set of named
**dimensions**, each of which is embedded separately:

| Concept | What it is |
|---|---|
| **Dimension** | A named field that gets its own embedding(s). The default KB has `content`, `useful_for`, `relevant_systems`, `relevant_tasks`. |
| **`single` dimension** | One vector per entry (e.g. `content`). |
| **`multi` dimension** | A list of values, each embedded; matches ANY value (e.g. `relevant_systems`). |
| **`text_only` dimension** | Stored (in entry metadata) but NOT embedded; non-semantic **exact-match** filtering of IDs / tags / enums. Searching it applies an exact-match filter rather than ranking. |
| **Weighted search** | You query several dimensions at once; each has a `weight`; scores combine into one ranked result. |
| **`metadata_filters`** | Exact (non-semantic) JSONB filtering layered on top of the semantic ranking. |

You can use the 4 default dimensions, or define **your own** semantic
dimensions when you create a KB.

---

## Create a KB with custom semantic dimensions

Pass a `dimension_schema` to `create_kb`. Each dimension becomes its own
embedding space and is automatically searchable.

```python
kb = client.create_kb(
    name="support-kb",
    description="Resolved support tickets",
    dimension_schema={
        "version": 1,
        "combination_mode": "weighted_sum",
        "dimensions": [
            # one vector per entry, required
            {"name": "symptom", "display_name": "Symptom",
             "description": "What the user reported",
             "dimension_type": "single", "required": True, "default_weight": 1.5},

            {"name": "resolution", "display_name": "Resolution",
             "description": "How it was fixed",
             "dimension_type": "single", "required": True},

            # a list field — each value embedded, matches ANY
            {"name": "products", "display_name": "Products",
             "description": "Affected products",
             "dimension_type": "multi", "max_items": 8},

            # stored but NOT embedded — exact-match filter only (e.g. region code)
            {"name": "region", "display_name": "Region",
             "description": "Data-center region (exact match)",
             "dimension_type": "text_only"},
        ],
    },
)
print(kb.id, kb.name)
```

If you omit `dimension_schema`, you get the default 4-dimension schema
(`content`, `useful_for`, `relevant_systems`, `relevant_tasks`).

> **Embedding model.** Every dimension in a KB shares one model
> (`text-embedding-3-small`, 1536-dim). The model is not currently
> selectable through the SDK.

### Update the name / description (and the agent-facing instructions)

A KB's **description** is its canonical "what is this / when should I use it"
text. It is not just metadata: it's the text agents receive at the MCP handshake
as `initialize.instructions`, and it's the `description` field returned by
`get_mcp_server_definition()`. Update it in place — there is no separate setter
for those agent-facing surfaces, and they refresh from this one field:

```python
kb.update(description="Resolved support tickets. Query before triage; cite ticket IDs.")
kb.update(name="Support KB", description="...")     # both at once (write scope)
client.update_kb(kb.id, description="...")          # equivalent, by id
```

After an update, the next agent that connects sees the new text as
`initialize.instructions`, and `get_mcp_server_definition()["description"]`
returns it too. Pass `description=""` to clear it (the server-def description
then falls back to the KB name).

> **REST API.** `PATCH /api/v1/kb/banks/{id}` with `{"description": "..."}`.

### Accumulate-only KBs (never overwrite or delete)

By default, deduplication may **merge** a near-duplicate into an existing entry
(`update`) or merge-and-replace conflicting entries (`conflict`). For an
*observation* / "connect-the-dots" KB — where every signal should be kept and a
later rollup should **coexist** with the entries it summarizes — set
`allow_updates=False`:

```python
kb = client.create_kb("signals", allow_updates=False)   # at creation
kb.set_allow_updates(False)                              # or toggle later (write scope)
```

With `allow_updates=False` the dedup LLM's `update`/`conflict` verdicts are
**downgraded to `new`**, so existing entries are never overwritten or deleted —
the KB only accumulates. Exact duplicates are still skipped (`redundant`). The
flag lives on the KB's schema (round-trips through `get_schema()`/`update_schema()`);
the default is `True`, which preserves the historical merge behavior.

> **REST API.** The same control is available without the SDK:
> `POST /api/v1/kb/banks` accepts `"allow_updates": false`, and
> `PATCH /api/v1/kb/banks/{id}` with `{"allow_updates": false}` toggles it.

### Choose which fields the MCP tools return (`response_fields`)

By default a KB's MCP tools (`query_knowledge_bank`, `narrate`) return only
**`id` + `content`** per result, to keep agent context lean. Opt a KB into
returning extra keys on every result:

```python
kb = client.create_kb("curated", response_fields=["useful_for", "source"])  # at creation
kb.set_response_fields(["useful_for", "relevant_systems", "source"])         # or set later (write scope)
kb.set_response_fields(None)                                                 # reset to id + content only
```

`response_fields` is **additive**: `id` + `content` are always present and the
listed keys are added when an entry carries them. Allowed values are the
standard result fields (`useful_for`, `relevant_systems`, `relevant_tasks`,
`relevant_file_paths`, `source`, `metadata`, `combined_score`, `created_at`,
`updated_at`) plus the KB's own dimension names; unknown keys are rejected. The
list lives on the KB's schema and only affects the **MCP** response shape — the
REST API and stored data always carry every field.

> **REST API.** `POST /api/v1/kb/banks` accepts `"mcp_response_fields": [...]`,
> and `PATCH /api/v1/kb/banks/{id}` with `{"mcp_response_fields": [...]}` (or
> `null` to reset) toggles it.

### Evolve the schema later (admin scope)

```python
kb.get_schema()                       # current KBDimensionSchema
kb.validate_schema(new_schema)        # returns warnings, applies nothing
kb.update_schema(new_schema)          # replace the whole schema
kb.add_dimension({"name": "severity_notes", "display_name": "Severity",
                  "description": "Severity context", "dimension_type": "single"})
kb.remove_dimension("severity_notes")
```

---

## Add entries

Provide a value for each dimension. `single` dimensions take a string;
`multi` dimensions take a list of strings.

```python
kb.add_entry({
    "dimensions": {
        "symptom": "Login loops back to the sign-in page after SSO",
        "resolution": "Cleared the stale SAML session cookie on the gateway",
        "products": ["web app", "mobile app"],
        "region": "us-east-1",   # text_only — stored in metadata, exact-match only
    },
    "metadata": {"status": "resolved", "severity": "high"},
})

# Batch ingest (deduplicates by default)
kb.ingest([{ "dimensions": {...} }, { "dimensions": {...} }])
```

`add_entry` / `ingest` are **synchronous** — they return the stored entry (or
raise on failure), so the call itself tells you the write landed. This differs
from the agent-facing MCP `report_learning` tool, which **queues** the write
(it becomes searchable shortly after). An optional `check_learning_status` tool
to confirm a queued write landed is configurable per deployment (off by
default).

---

## Search

### Simple — one string against `content`

```python
results = kb.search("how does authentication work?")
```

### Multi-dimensional weighted search

Map each dimension to a query. The required per-dimension key is
**`query_text`**, and `weight` scales that dimension's contribution. Scores
are combined per `combination_mode`.

```python
results = kb.search({
    "dimensions": {
        "symptom":  {"query_text": "login loops after SSO", "weight": 2.0},
        "products": {"query_text": "mobile app",            "weight": 0.5},
    },
    "combination_mode": "weighted_sum",
    "metadata_filters": {"status": "resolved"},   # exact, non-semantic
    "k": 10,
    "threshold": 0.35,
})

for r in results:
    print(r["combined_score"], r["dimensions"] if "dimensions" in r else r)
```

Per-dimension you can also override `aggregation`, `top_k`, and
`min_threshold`:

```python
"products": {"query_text": "mobile", "weight": 1.0,
             "aggregation": "max", "min_threshold": 0.2}
```

### Exact-match filtering with `text_only` dimensions

A `text_only` dimension is matched **exactly**, not ranked. Pass it alongside
at least one semantic (`single`/`multi`) dimension; its `query_text` folds into
an exact-match filter (equivalent to a `metadata_filters` entry) and never
contributes to the score:

```python
results = kb.search({
    "dimensions": {
        "symptom": {"query_text": "login loops after SSO"},
        "region":  {"query_text": "us-east-1"},   # text_only → exact match
    },
})
```

A search containing **only** `text_only` dimensions is rejected (there is
nothing to rank) — add a semantic (`single`/`multi`) dimension. The same is
true of `metadata_filters` (below): it is an exact post-filter layered on the
ranking, so every search still needs at least one semantic dimension. A
`text_only` dimension defined with `searchable=False` is stored but cannot be
used as a search filter.

### Exact filtering with `metadata_filters`

`metadata_filters` is an exact (non-semantic) JSONB-containment filter applied
**on top of** the semantic ranking — only entries whose `metadata` contains all
the given key/values survive. Pair it with at least one semantic dimension:

```python
results = kb.search({
    "dimensions": {"observation": {"query_text": "late delivery"}},
    "metadata_filters": {"order_id": "SO-1234", "type": "quality_issue"},
})
```

It narrows the ranked results; it does not rank on its own. To gather *every*
entry for a key regardless of relevance, widen `k` and pass a broad semantic
query alongside the filter.

### Filter by time

Restrict results to a time window with a **hard filter** on entry timestamps
(UTC) — it removes out-of-window entries without affecting the ranking. Bounds
accept an ISO-8601 string or a `datetime`. For a **string** query they're
keyword args:

```python
from datetime import datetime, timedelta, timezone

# Only knowledge created in the last 30 days
recent = kb.search(
    "deployment pipeline",
    created_after=datetime.now(timezone.utc) - timedelta(days=30),
)
```

For a **dict** query, set the same keys inline:

```python
results = kb.search({
    "dimensions": {"content": {"query_text": "deployment pipeline"}},
    "created_after": "2026-05-01T00:00:00Z",
    "created_before": "2026-06-01",          # bare date == 00:00:00Z
    "k": 10,
})
```

Available bounds: `created_after`, `created_before`, `updated_after`,
`updated_before`. Each result includes `created_at` / `updated_at` so you can
verify the window and sort by recency client-side.

### Search request reference

| Field | Type | Notes |
|---|---|---|
| `dimensions` | `{name: {query_text, weight, aggregation?, top_k?, min_threshold?}}` | At least one **searchable** dimension required. A `text_only` dimension here folds into an exact-match filter (and needs a `single`/`multi` dimension alongside it). |
| `combination_mode` | `weighted_sum` \| `weighted_product` \| `max` \| `min` \| `custom` | How dimension scores combine. |
| `custom_formula` | `str` | Required when `combination_mode="custom"`; SQL over `<dim>_score`. |
| `metadata_filters` | `dict` | Exact JSONB containment, e.g. `{"status": "resolved"}`. |
| `category_filters` | `[{tag, max_results, min_score}]` | Bucket results by metadata tag. |
| `created_after` / `created_before` | `str` \| `datetime` | Hard filter on entry creation time (UTC, ISO-8601). |
| `updated_after` / `updated_before` | `str` \| `datetime` | Hard filter on entry last-modified time (UTC, ISO-8601). |
| `k`, `threshold` | `int`, `float` | Result count / minimum combined score. |

`aggregation` (for `multi` dimensions): `max`, `avg`, `min`, `top_k_avg`,
`sum`, `count`.

The SDK also accepts the older spellings `query` (per dimension) and
`filters` (top level) and rewrites them to `query_text` / `metadata_filters`
for you — but prefer the canonical names above.

---

## Cluster entries

Group a KB's entries by any field. Each field is clustered **independently** and
returned keyed by field, so one call can group "by topic" and "by customer" at
once. The engine is chosen per field (`method="auto"`):

- **Single embedding dimensions** (`content`, `observation`, …) → **vector**
  clustering (KMeans / Agglomerative / HDBSCAN over the stored vectors). When
  `algorithm="auto"` and no `k` is given, HDBSCAN runs first; if it degenerates
  (fewer than 3 clusters or >40% noise — common on single-domain KBs) the
  engine automatically re-runs KMeans with a heuristic k and says so in the
  field's `note`.
- **Multi-valued dimensions** (tags, products, accounts, …) → entries are
  grouped **by their values**; an entry carrying two tags appears in both
  groups. Near-duplicate values merge per `similarity_threshold`.
- **Anything else** (`metadata.customer`, `source`, a `text_only` dimension) →
  **fuzzy** string grouping, so near-duplicate values ("Acme Inc" ≈ "Acme,
  Inc.") merge. **Exception:** values that look like codes or IDs
  (`WHITE12`, `SKU-4471`) are grouped **exactly** and labeled by their dominant
  value — fuzzy-matching identifiers would merge distinct codes. Pass an
  explicit `similarity_threshold` to override.

Omit `fields` to cluster the KB's **primary embedding dimension** (its first
required single dimension) — the right default for custom-schema KBs, whose
`content` column has no embedding.

```python
result = kb.cluster(
    fields=["observation", "themes", "metadata.customer_no"],
    method="auto",              # vector / value-grouping / fuzzy per field
    algorithm="auto",           # vector: HDBSCAN, KMeans fallback on collapse
    similarity_threshold=0.85,  # fuzzy cutoff (1.0 = exact grouping)
    label=True,                 # opt-in names; one batched LLM call per field
    label_sample_size=5,        # representatives per cluster fed to the namer
)

for field_result in result["results"]:
    print(field_result["field"], field_result["method"], field_result["cluster_count"])
    if field_result.get("note"):
        print("  note:", field_result["note"])   # engine advisories land here
    for group in field_result["clusters"]:
        print("  ", group.get("label") or group.get("key"), "→", group["size"])
```

Labeling: the **30 largest** clusters of a field are named in a single batched
LLM call; smaller clusters fall back to their dominant value (fuzzy) or keyword
terms (vector). The tokens spent are reported per field in
`field_result["label_usage"]` (`model`, `input_tokens`, `output_tokens`) so
labeling cost is always visible. ID-like fields skip the LLM entirely.

Cap how large any one cluster may grow with `max_cluster_size` (absolute entry
count) and/or `max_cluster_fraction` (share of the clustered scope, `0..1]`) —
when both are given the stricter cap wins. Oversized vector clusters are
recursively split server-side (KMeans within the cluster) until every cluster
fits; oversized fuzzy groups split into exact-value groups (a single value
repeated past the cap cannot be split — the field's `note` says so); groups of
a multi-valued dimension are never split, since their size is the value's usage
count. Fields in one call are clustered **concurrently** server-side, so one
three-field request beats three single-field requests on wall-clock.

```python
result = kb.cluster(
    fields=["observation"],
    algorithm="kmeans", k=8,
    max_cluster_size=50,        # no cluster larger than 50 entries…
    max_cluster_fraction=0.2,   # …or 20% of the scope, whichever is stricter
)
```

Outliers (HDBSCAN noise) don't have to stay a catch-all. `outlier_strategy`
controls what happens to them on vector fields: `"keep"` (default) leaves them
uncategorized; `"reassign"` absorbs each noise entry into its nearest cluster
when it lies within that cluster's own spread; `"subcluster"` re-clusters the
noise into new clusters flagged `from_noise` so nothing is left uncategorized.
Every vector cluster also reports `mean_member_distance` and a `low_cohesion`
flag marking clusters whose spread is an outlier vs their peers — likely
catch-alls worth a follow-up `subcluster` pass.

```python
result = kb.cluster(fields=["observation"], outlier_strategy="subcluster")
for group in result["results"][0]["clusters"]:
    if group.get("from_noise") or group.get("low_cohesion"):
        print("refined:", group["size"], group.get("keywords"))
```

By default a cluster's returned `members` are its most central entries.
Pass `member_sample="diverse"` to get the nearest-centroid anchor plus greedy
farthest-point picks instead, so fringe sub-themes reach the sample — useful
when members feed a namer or summarizer that should see the whole cluster,
not just its dense core (vector fields only):

```python
result = kb.cluster(
    fields=["observation"],
    max_members_per_cluster=12,
    member_sample="diverse",
)
```

Cluster only the results of a search by passing the same shape as `kb.search`:

```python
result = kb.cluster(
    fields=["observation"],
    search={"dimensions": {"observation": {"query_text": "billing error"}}, "k": 500},
)
```

### Cluster request reference

| Field | Type | Notes |
|---|---|---|
| `fields` | `[str]` | Fields to cluster. Omit → the KB's primary embedding dimension. `metadata.<key>` reads a metadata value; a bare name resolves to a dimension or metadata key. |
| `method` | `auto` \| `vector` \| `fuzzy` | `auto` picks by field type (single embedding dim → vector, multi dim → value grouping, else fuzzy). `vector` on a non-embedding or multi field is a 400. |
| `algorithm` | `auto` \| `kmeans` \| `agglomerative` \| `hdbscan` | Vector only. `kmeans`/`agglomerative` require `k`. `auto` without `k` = HDBSCAN with automatic KMeans fallback on degenerate results; explicit `hdbscan` never falls back. |
| `k` | `int` | Cluster count for kmeans/agglomerative. Omit for `auto`/`hdbscan`. |
| `min_cluster_size` | `int` | HDBSCAN minimum cluster size (default 5). Low values fragment single-domain KBs into many tiny clusters. |
| `metric` | `cosine` \| `euclidean` | Vector distance (default `cosine`). |
| `similarity_threshold` | `float` | Fuzzy cutoff 0..1 (default 0.85; `1.0` = exact). ID-like values force exact grouping unless you pass this explicitly. |
| `search` | `SearchRequest` | Optional — cluster only matching entries. |
| `scope_limit` | `int` | Max entries clustered when no `search` (default 2000). |
| `include_members` / `max_members_per_cluster` | `bool` / `int` | Per-cluster member output. |
| `label` | `bool` | Generate a short label per cluster (off by default — free & deterministic). When on, the 30 largest clusters of a field are named in ONE batched LLM call; the tail gets dominant-value/keyword labels. |
| `label_sample_size` | `int` | When `label=True`, representatives per cluster fed to the namer — nearest-centroid for vector, most-distinct values for fuzzy (default 5). |

Each result is a `FieldClusterResult` with `clusters: [ClusterGroup]`, plus:
`note` (engine advisories: algorithm fallback, exact ID grouping, un-embedded
field warnings), `label_usage` (LLM token accounting when labeling ran),
`silhouette_score` (vector), and each fuzzy group's `key` (dominant value) and
distinct `values`.

---

## Retrieval assertions (search-quality regression tests)

Pin queries that MUST retrieve a given entry, then re-check them any time —
your KB's retrieval quality becomes testable instead of vibes:

```python
# "This query should find this entry" — baseline rank/score captured now.
kb.add_assertion(entry_id=entry["id"], query="how do we handle refunds?",
                 notes="core support flow")

kb.list_assertions()                  # all assertions + their baselines
report = kb.run_retrieval_eval()      # re-run every assertion against live search
# → per-assertion current rank/score vs baseline, pass/fail, regressions

kb.get_assertion(assertion_id)        # one assertion's detail
kb.delete_assertion(assertion_id)     # retire it
```

`query` accepts a plain string (searches the primary dimension) or the same
per-dimension shape as `kb.search`. Run the eval after schema changes, bulk
ingests, or dedup sweeps to catch retrieval regressions. Requires `write`
scope to create/delete; `read` to list and evaluate.

---

## Playbooks (procedures returned whole)

Entries are atomic facts found by semantic top-k. A **playbook** is the other
contract: a distinct, named, ordered procedure that is matched as a whole on
its `title` + `when_to_use` and then returned **complete** — every step, in
order — so an agent never runs a runbook with a step missing. A bank keeps one
playbook per task.

```python
# Discover: rank the bank's playbooks by fit to the task at hand
hits = kb.list_playbooks("file kanban cards during the hourly PM sweep")
slug = hits["playbooks"][0]["slug"]

# Fetch the whole procedure (steps in order; cited entries inlined)
playbook = kb.get_playbook(slug)
for step in playbook["steps"]:
    print(step["position"], step["title"], step["body"])

# Write / replace (versioned; every write is snapshotted)
kb.upsert_playbook(
    "pm-hourly-sweep-filing",
    title="PM hourly sweep: filing cards under workstreams",
    when_to_use="Running the hourly PM sweep on a board and deciding which "
                "workstream and milestone each unfiled card belongs to",
    steps=[
        {"title": "List unfiled cards", "body": "kanban_search_tasks(unfiled=true)"},
        {"title": "Assign each card", "body": "kanban_assign_task_to_phase …",
         "kb_entry_id": "<entry holding the filing rule>"},   # optional citation
    ],
    change_note="initial version",
)

kb.list_playbook_versions("pm-hourly-sweep-filing")   # newest first, full snapshots
kb.get_playbook_stats()                                # {"active": n, "draft": n, "superseded": n}
kb.delete_playbook("pm-hourly-sweep-filing")           # snapshots are retained
```

**Overlap guard.** An `upsert_playbook` whose `when_to_use` scores at or above
the bank's threshold (default 0.82 cosine) against another *active* playbook
raises `PlaybookOverlapError` with `.candidates`. Extend the existing slug
instead, give yours a genuinely different trigger, retire the old one with
`supersedes_slug="old-slug"`, or pass `force=True` when the tasks really are
distinct.

Slugs are kebab-case (2–80 chars). Step `position`s are assigned from list
order. The same three operations are exposed to agents as the MCP tools
`list_playbooks` / `get_playbook` / `upsert_playbook`, and `query_knowledge_bank`
names matching playbooks under `matched_playbooks`.

---

## Manage KBs and API keys (client scope)

```python
client.list_kbs()                     # every KB your key can reach → [KBInfo]
kb = client.get_kb("kb-uuid")         # bind a handle (fetches info)
client.update_kb("kb-uuid", name="Support KB", description="...")
client.delete_kb("kb-uuid")           # admin scope — irreversible

# API keys (admin scope): mint scoped keys for services / teammates.
key = client.create_api_key(name="reporting-bot", scopes=["read"])
client.list_api_keys()
client.delete_api_key(key["id"])

client.get_mcp_server_definition("kb-uuid")   # same payload as kb.get_mcp_server_definition()
client.close()                        # or use `with GuruCloudClient(...) as client:`
```

---

## Use the KB as an MCP server (agent injection)

```python
mcp_def = kb.get_mcp_server_definition()
agent_config = {
    "mcpServers": {
        mcp_def["server_name"]: {
            "type": mcp_def["type"],
            "url": mcp_def["url"],
            "headers": {"Authorization": f"Bearer {api_key}"},
        }
    }
}
# Or mint a dedicated never-expiring token (admin scope):
pat = kb.generate_pat(token_name="My Agent")
```

The MCP tools (`query_knowledge_bank`, `report_learning`) are generated from
your schema — every searchable dimension becomes a `<dimension>_query`
parameter automatically.

### Self-hosted platform

A licensed in-tenant deployment of the Knowledge Bank platform (the
`kb-platform` container image, >= 1.1.0) serves the same API and the same
per-bank MCP servers itself. Point the client at it with the platform's
service token — no `kb_` key is involved:

```python
client = GuruCloudClient(
    api_key=platform_service_token,
    base_url="https://kb-platform.<your-container-apps-domain>",
)
kb = client.get_kb("spog-desk-prod-tx")          # bank NAME or UUID
mcp_def = kb.get_mcp_server_definition()         # url = <platform>/kb/<id>/mcp
```

The definition is the platform's own MCP server for that bank: mount it as
is (the Bearer token is the same service token). Its `available_tools` is
exactly what the server's `tools/list` returns — `query_knowledge_bank`,
`report_learning`, `get_kb_entry`, `edit_kb_entry`, `delete_kb_entry`,
generated from the bank's schema — so a gateway that passes the definition
through never needs to hard-code tool names. Platform images >= 1.2.0 also
serve `list_playbooks` / `get_playbook` / `upsert_playbook`.

For a consumer that keeps one server attached and picks the bank per call,
`client.get_platform_mcp_server_definition()` returns the bank-addressed
server (`<platform>/mcp`; every tool takes `kb` = bank name or UUID, plus
`list_knowledge_banks` / `get_knowledge_bank_info`).

Not available on a self-hosted platform (the call raises `APIError` 501):
`generate_pat()`, API-key management, retrieval assertions / evaluation runs,
and deduplication events.

---

## Async

The async client mirrors the sync API exactly — every method is awaitable.

```python
from gurucloud_kb import AsyncGuruCloudClient

async with AsyncGuruCloudClient(api_key="kb_...") as client:
    kb = await client.get_kb("your-kb-uuid")
    results = await kb.search({
        "dimensions": {"content": {"query_text": "JWT", "weight": 1.0}},
        "k": 5,
    })
```

---

## Typed contracts

All request/response shapes are exported as `TypedDict`s / `Literal`s for
editor + agent autocompletion:

```python
from gurucloud_kb import (
    DimensionConfig, DimensionSchema, DimensionType,
    DimensionQuery, SearchRequest, CombinationMode, Aggregation,
    CategoryFilter, EntryInput, EntryResult, KBInfo,
)
```

---

## Changelog

### 0.1.17

- **Playbooks** — `kb.list_playbooks(query=None, status="active", limit=25,
  min_score=0.0)`, `kb.get_playbook(slug)`, `kb.upsert_playbook(slug, title=,
  when_to_use=, steps=, …)`, `kb.delete_playbook(slug)`,
  `kb.list_playbook_versions(slug)`, `kb.get_playbook_stats()` (sync + async).
  A playbook is a distinct, named, ordered procedure stored beside a bank's
  entries and returned whole; `upsert_playbook` is versioned and raises the
  new `PlaybookOverlapError` (409 `playbook_overlap`, `.candidates`) when it
  collides with another active playbook. New typed contracts: `Playbook`,
  `PlaybookList`, `PlaybookSummary`, `PlaybookStep`, `PlaybookStepInput`,
  `PlaybookWriteResult`, `PlaybookVersion`, `PlaybookStats`, `LinkedEntry`,
  `OverlapCandidate`, `PlaybookStatus`. Requires the hosted API of 2026-09-08
  or a self-hosted platform image >= 1.2.0.

### 0.1.16

- **Self-hosted platform support** — `GuruCloudClient(base_url=<your
  platform>, api_key=<platform service token>)` works against a licensed
  in-tenant Knowledge Bank platform (kb-platform image >= 1.1.0). The
  `kb_` key-prefix rule now applies only to the hosted `base_url`; a
  self-hosted deployment authenticates with its own service token.
  `kb.get_mcp_server_definition()` returns the platform's own MCP server
  URL for the bank (`<platform>/kb/{kb_id}/mcp`), and the new
  `client.get_platform_mcp_server_definition()` returns the bank-addressed
  server (`<platform>/mcp`, tools take `kb`). See "Self-hosted platform".

### 0.1.15

- **Tunable reassign radius** — `cluster()` (sync + async) accepts
  `reassign_percentile` (50-100) controlling how far outside a cluster's
  core `outlier_strategy="reassign"` will absorb noise (a noise entry joins
  its nearest cluster only within that percentile of the cluster's own
  member-to-centroid distances). The server default also moved from p90 to
  p99, measured to absorb most genuinely-belonging noise while staying shy
  on corpora whose noise is truly off-topic. Omitted from the request when
  not set, so older servers keep working.

### 0.1.14

- **Diverse member sampling** — `cluster()` (sync + async) accepts
  `member_sample` (`"nearest"` | `"diverse"`). `"diverse"` returns the
  nearest-centroid anchor plus greedy farthest-point picks so fringe
  sub-themes reach the member sample instead of only the cluster core.
  Requires the 2026-09-01 server deploy; omitted from the request at its
  default, so older servers keep working.

### 0.1.13

- **Outlier refinement** — `cluster()` (sync + async) accepts
  `outlier_strategy` (`"keep"` | `"reassign"` | `"subcluster"`) so vector
  noise can be absorbed into nearby clusters or re-clustered into its own
  `from_noise` clusters instead of staying a catch-all. Vector clusters also
  report `mean_member_distance` and a `low_cohesion` flag marking likely
  catch-all clusters. Requires the 2026-09-01 server deploy; the parameter is
  omitted from the request at its default, so older servers keep working.

### 0.1.12

- **Cluster-size caps** — `cluster()` (sync + async) accepts
  `max_cluster_size` (absolute entries per cluster) and
  `max_cluster_fraction` (share of the clustered scope, `0..1]`; stricter
  wins). Oversized vector clusters are recursively split server-side so the
  caps always hold; fuzzy groups split into exact-value groups; multi-valued
  dimension groups are exempt (noted). Requires the 2026-08-31 server deploy.
- Multiple `fields` in one `cluster()` call are now clustered concurrently
  server-side — one three-field request beats three single-field requests.
- `__version__` re-synced with `pyproject.toml` (had been stuck at 0.1.8).

### 0.1.11

- **Batch ingest returns created entry ids** — `ingest()` responses carry
  `entry_ids`: one created id per input position (`None` for rows that
  errored), so callers can map inputs to created entries. Typing/docs only on
  the client; requires the 2026-08-24 server deploy (PR #3402).

### 0.1.10

- **Entry reads now carry custom dimension values and timestamps** — the API's
  `list_entries()`, `get_entry()`, and `search()` results include a
  `dimensions` object with every non-default embedded dimension's value(s)
  (SINGLE → str, MULTI → list[str]; empty `{}` on default-schema KBs), and
  `created_at` / `updated_at` are populated on list/get responses (previously
  null). `EntryResult` documents the new key. No client behavior change —
  typing/docs only; requires the 2026-07-03 server deploy or later.

### 0.1.9

- **`kb.cluster()` / `await kb.cluster()` omit `fields` when not given** — the
  server now picks the KB's primary embedding dimension (first required SINGLE
  dimension), so custom-schema KBs no longer degrade to fuzzy grouping over a
  raw `content` column that has no embedding. Server-side improvements shipped
  alongside: MULTI dimensions (tags, products, ...) are now clusterable (entries
  grouped by their values), degenerate auto-HDBSCAN results fall back to KMeans
  with a heuristic k, ID-like values are grouped exactly with dominant-value
  labels, and each field result carries an optional `note` plus `label_usage`
  token accounting.

### 0.1.8

- **Removed `DimensionConfig.show_in_results`** — the deprecated, inert
  per-dimension flag (deprecated in 0.1.3) has been removed. It never controlled
  MCP output; use `response_fields` (`mcp_response_fields`) to choose the keys
  the MCP tools return. Stored schemas that still carry the key keep parsing —
  the unknown field is ignored.

### 0.1.7

- **`label_sample_size` on `kb.cluster()` / `await kb.cluster()`** — when
  `label=True`, how many representative entries per cluster are sent to the
  labeler (default 5). Server-side, cluster naming became one batched LLM call
  per field instead of one call per cluster, so labeled clustering no longer
  slows linearly with cluster count and names come out mutually distinct.

### 0.1.6

- **`kb.update()` / `await kb.update()`** — update a KB's name and/or
  description in place (`write` scope; also `client.update_kb(kb_id, ...)`).
  The description drives both the agent-facing `initialize.instructions` and
  the `description` returned by `get_mcp_server_definition()` (see *Update the
  name / description* above) — there is no separate setter for those surfaces.
- Corrected stale docstrings that claimed KB-management methods "return a
  token".

### 0.1.5

- Restore the `py.typed` marker (PEP 561) so type checkers pick up the SDK's
  inline types. It was inadvertently dropped in 0.1.2–0.1.4; the `Typing ::
  Typed` classifier had been advertised without it. No API changes.

### 0.1.4

- **`kb.cluster()` / `await kb.cluster()`** — group a KB's entries by any
  field. Embedding dimensions cluster by vector similarity (KMeans /
  Agglomerative / HDBSCAN); metadata/text fields cluster by fuzzy string match.
  Cluster the whole KB or a search result set; results are returned keyed per
  field. New typed contracts: `ClusteringResult`, `FieldClusterResult`,
  `ClusterGroup`, `ClusterMember`, `ClusterScope`, `ClusterMethod`,
  `ClusterAlgorithm`. Backed by `POST /api/v1/kb/banks/{id}/cluster`.

### 0.1.3

- **`response_fields` / `kb.set_response_fields()`** — choose which extra keys a
  KB's MCP tools return beyond `id` + `content` (see *Choose which fields the
  MCP tools return* above). Set on `create_kb(...)` or later via
  `kb.set_response_fields([...])`; needs `write` scope. Backed by
  `mcp_response_fields` on `DimensionSchema`.
- **`allow_updates` / `kb.set_allow_updates()`** — accumulate-only KBs (dedup
  never merges/overwrites).
- **Deprecated `DimensionConfig.show_in_results`** — this per-dimension flag is
  not enforced and never controlled MCP output; use `response_fields`
  (`mcp_response_fields`) instead. The field is kept only for backward
  compatibility of stored schemas.
