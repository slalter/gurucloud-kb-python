# GuruCloud KB SDK

Python SDK for the [GuruCloud Knowledge Bank API](https://www.gurucloudai.com/docs/kb).

**Full documentation**: [gurucloudai.com/docs/kb](https://www.gurucloudai.com/docs/kb)
**OpenAPI spec**: [gurucloudai.com/docs/kb/openapi.json](https://www.gurucloudai.com/docs/kb/openapi.json)

## Installation

```bash
pip install gurucloud-kb
```

## Quick Start

```python
from gurucloud_kb import GuruCloudClient

client = GuruCloudClient(api_key="kb_your_api_key")

# List your Knowledge Banks
kbs = client.list_kbs()

# Work with a specific KB
kb = client.get_kb("your-kb-uuid")

# Search
results = kb.search("how does authentication work?")
for r in results:
    print(r["content"], r["combined_score"])

# Add an entry
kb.add_entry({
    "dimensions": {
        "content": "The auth service uses JWT tokens with RS256 signing.",
        "useful_for": "Understanding authentication architecture",
    }
})
```

## Async Support

```python
from gurucloud_kb import AsyncGuruCloudClient

async with AsyncGuruCloudClient(api_key="kb_your_api_key") as client:
    kb = await client.get_kb("your-kb-uuid")
    results = await kb.search("deployment process")
```

## Key Features

- **Sync & async clients** — `GuruCloudClient` and `AsyncGuruCloudClient`
- **Knowledge Bank CRUD** — create, list, update, delete KBs
- **Entry management** — add, update, delete, batch ingest entries
- **Semantic search** — single-query or multi-dimensional weighted search
- **Schema management** — get, update, validate dimension schemas
- **MCP integration** — get MCP server definitions for agent injection
- **Deduplication events** — inspect how entries were deduplicated
- **Event logs** — trace entry processing lifecycle
- **API key management** — create, list, delete API keys
- **Typed responses** — all methods return TypedDict types for IDE autocomplete

## Entry Management

```python
# List entries
entries = kb.list_entries(limit=20, offset=0)

# Get a single entry
entry = kb.get_entry("entry-uuid")

# Update an entry
kb.update_entry("entry-uuid", {"dimensions": {"content": "Updated content"}})

# Delete
kb.delete_entry("entry-uuid")

# Batch ingest with deduplication
result = kb.ingest([
    {"dimensions": {"content": "Fact 1", "useful_for": "Context 1"}},
    {"dimensions": {"content": "Fact 2", "useful_for": "Context 2"}},
], deduplicate=True)
print(f"Ingested: {result['ingested']}")
```

## Search

```python
# Simple string search (searches the "content" dimension)
results = kb.search("authentication flow", k=5, threshold=0.6)

# Multi-dimensional weighted search
results = kb.search({
    "dimensions": {
        "content": {"query_text": "JWT tokens", "weight": 0.7},
        "useful_for": {"query_text": "security audit", "weight": 0.3},
    },
    "k": 10,
    "threshold": 0.5,
})
```

## MCP Integration

```python
# Get MCP server definition for agent injection
mcp_def = kb.get_mcp_server_definition()

# Use in agent config:
mcp_config = {
    "type": "http",
    "url": mcp_def["url"],
    "headers": {"Authorization": f"Bearer {mcp_def['token']}"}
}
```

## Deduplication Events

```python
# List dedup events
events = kb.list_events(action="conflict", limit=20)

# Get full event details
event = kb.get_event("event-uuid")
print(event["reasoning"], event["action"])

# Entry processing logs
logs = kb.list_event_logs(event_type="dedup", limit=50)
```

## Error Handling

```python
from gurucloud_kb import (
    GuruCloudError,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
)

try:
    kb = client.get_kb("bad-uuid")
except NotFoundError:
    print("KB not found")
except AuthenticationError:
    print("Invalid API key")
except RateLimitError:
    print("Rate limited — slow down")
except GuruCloudError as e:
    print(f"API error: {e.message}")
```

## Requirements

- Python 3.10+
- `httpx` >= 0.25.0

## License

MIT
