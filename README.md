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
    },
    "metadata": {"status": "resolved", "severity": "high"},
})

# Batch ingest (deduplicates by default)
kb.ingest([{ "dimensions": {...} }, { "dimensions": {...} }])
```

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

### Search request reference

| Field | Type | Notes |
|---|---|---|
| `dimensions` | `{name: {query_text, weight, aggregation?, top_k?, min_threshold?}}` | At least one dimension required. Must be **searchable**. |
| `combination_mode` | `weighted_sum` \| `weighted_product` \| `max` \| `min` \| `custom` | How dimension scores combine. |
| `custom_formula` | `str` | Required when `combination_mode="custom"`; SQL over `<dim>_score`. |
| `metadata_filters` | `dict` | Exact JSONB containment, e.g. `{"status": "resolved"}`. |
| `category_filters` | `[{tag, max_results, min_score}]` | Bucket results by metadata tag. |
| `k`, `threshold` | `int`, `float` | Result count / minimum combined score. |

`aggregation` (for `multi` dimensions): `max`, `avg`, `min`, `top_k_avg`,
`sum`, `count`.

The SDK also accepts the older spellings `query` (per dimension) and
`filters` (top level) and rewrites them to `query_text` / `metadata_filters`
for you — but prefer the canonical names above.

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
