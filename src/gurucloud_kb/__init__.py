"""GuruCloud Knowledge Bank SDK.

Example::

    from gurucloud_kb import GuruCloudClient

    client = GuruCloudClient(api_key="kb_abc123...")

    # List all KBs
    kbs = client.list_kbs()

    # Work with a specific KB
    kb = client.get_kb("my-kb-uuid")
    results = kb.search("how does auth work?")

    # Get MCP server definition for agent injection
    mcp_def = kb.get_mcp_server_definition()
"""

from gurucloud_kb.async_client import AsyncGuruCloudClient
from gurucloud_kb.async_kb import AsyncKnowledgeBank
from gurucloud_kb.client import GuruCloudClient
from gurucloud_kb.errors import (
    APIError,
    AuthenticationError,
    ConnectionError,
    GuruCloudError,
    NotFoundError,
    PermissionError,
    RateLimitError,
)
from gurucloud_kb.kb import KnowledgeBank
from gurucloud_kb.types import (
    Aggregation,
    APIKeyInfo,
    BatchIngestResult,
    CategoryConfig,
    ClusterAlgorithm,
    ClusterGroup,
    ClusteringResult,
    ClusterMember,
    ClusterMethod,
    ClusterScope,
    FieldClusterResult,
    CategoryFilter,
    CombinationMode,
    DeduplicationEvent,
    DeduplicationEventList,
    DeduplicationEventSummary,
    DimensionConfig,
    DimensionQuery,
    DimensionSchema,
    DimensionType,
    EntryEventLog,
    EntryEventLogList,
    EntryInput,
    EntryResult,
    KBInfo,
    MCPServerDefinition,
    SchemaWarning,
    SearchRequest,
    SearchResult,
)

__all__ = [
    # Sync client
    "GuruCloudClient",
    "KnowledgeBank",
    # Async client
    "AsyncGuruCloudClient",
    "AsyncKnowledgeBank",
    # Errors
    "GuruCloudError",
    "APIError",
    "AuthenticationError",
    "PermissionError",
    "NotFoundError",
    "RateLimitError",
    "ConnectionError",
    # Types
    "KBInfo",
    "DimensionConfig",
    "DimensionType",
    "Aggregation",
    "CombinationMode",
    "CategoryConfig",
    "CategoryFilter",
    "DimensionSchema",
    "SchemaWarning",
    "EntryInput",
    "EntryResult",
    "DimensionQuery",
    "SearchRequest",
    "SearchResult",
    "MCPServerDefinition",
    "APIKeyInfo",
    "BatchIngestResult",
    "ClusterMethod",
    "ClusterAlgorithm",
    "ClusterMember",
    "ClusterGroup",
    "FieldClusterResult",
    "ClusterScope",
    "ClusteringResult",
    "DeduplicationEvent",
    "DeduplicationEventSummary",
    "DeduplicationEventList",
    "EntryEventLog",
    "EntryEventLogList",
]

__version__ = "0.1.6"
