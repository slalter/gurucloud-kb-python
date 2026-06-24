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

- **Embedding dimensions** (`content`, `useful_for`, …) → **vector** clustering
  (KMeans / Agglomerative / HDBSCAN over the stored vectors).
- **Anything else** (`metadata.customer`, `source`, a `text_only` dimension) →
  **fuzzy** string grouping, so near-duplicate values ("Acme Inc" ≈ "Acme,
  Inc.") merge.

```python
result = kb.cluster(
    fields=["content", "metadata.customer"],
    method="auto",              # vector for content, fuzzy for metadata.customer
    algorithm="auto",           # vector: HDBSCAN when k omitted, else KMeans
    similarity_threshold=0.85,  # fuzzy cutoff (1.0 = exact grouping)
    label=True,                 # opt-in names; all clusters named in ONE batched call
    label_sample_size=5,        # representatives per cluster fed to the namer
)

for field_result in result["results"]:
    print(field_result["field"], field_result["method"], field_result["cluster_count"])
    for group in field_result["clusters"]:
        print("  ", group.get("key") or group.get("keywords"), "→", group["size"])
```

Cluster only the results of a search by passing the same shape as `kb.search`:

```python
result = kb.cluster(
    fields=["content"],
    search={"dimensions": {"content": {"query_text": "billing error"}}, "k": 500},
)
```

### Cluster request reference

| Field | Type | Notes |
|---|---|---|
| `fields` | `[str]` | Fields to cluster (default `["content"]`). `metadata.<key>` reads a metadata value; a bare name resolves to a dimension or metadata key. |
| `method` | `auto` \| `vector` \| `fuzzy` | `auto` picks by field type (single embedding dim → vector, else fuzzy). |
| `algorithm` | `auto` \| `kmeans` \| `agglomerative` \| `hdbscan` | Vector only. `kmeans`/`agglomerative` require `k`. |
| `k` | `int` | Cluster count for kmeans/agglomerative. Omit for `auto`/`hdbscan`. |
| `min_cluster_size` | `int` | HDBSCAN minimum cluster size (default 5). |
| `metric` | `cosine` \| `euclidean` | Vector distance (default `cosine`). |
| `similarity_threshold` | `float` | Fuzzy cutoff 0..1 (default 0.85; `1.0` = exact). |
| `search` | `SearchRequest` | Optional — cluster only matching entries. |
| `scope_limit` | `int` | Max entries clustered when no `search` (default 2000). |
| `include_members` / `max_members_per_cluster` | `bool` / `int` | Per-cluster member output. |
| `label` | `bool` | Generate a short label per cluster (off by default — free & deterministic). When on, **all** clusters of a field are named in a single batched LLM call (fast, mutually distinct), not one call per cluster. |
| `label_sample_size` | `int` | When `label=True`, representatives per cluster fed to the namer — nearest-centroid for vector, most-distinct values for fuzzy (default 5). |

Each result is a `FieldClusterResult` with `clusters: [ClusterGroup]`; vector
results carry a `silhouette_score`, fuzzy results carry each group's `key` and
distinct `values`.

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
