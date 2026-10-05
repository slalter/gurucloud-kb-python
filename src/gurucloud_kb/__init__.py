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
from gurucloud_kb._credentials import AsyncClientCredentials, ClientCredentials
from gurucloud_kb.client import GuruCloudClient
from gurucloud_kb.errors import (
    APIError,
    AuthenticationError,
    ConnectionError,
    GuruCloudError,
    NotFoundError,
    PermissionError,
    PlaybookOverlapError,
    PlaybookRunError,
    RateLimitError,
)
from gurucloud_kb.kb import KnowledgeBank
from gurucloud_kb.ui_server import serve_ui, start_ui_server
from gurucloud_kb.types import (
    Aggregation,
    APIKeyInfo,
    BatchIngestResult,
    CategoryConfig,
    ClusterAlgorithm,
    ClusterGroup,
    ClusteringResult,
    ClusterMember,
    ClusterLabelSample,
    ClusterMemberSample,
    ClusterMethod,
    ClusterOutlierStrategy,
    ClusterScope,
    FieldClusterResult,
    CategoryFilter,
    ClientCredentialInfo,
    CredentialProvider,
    CredentialSource,
    CredentialStoreStatus,
    ExpandedSearchResult,
    ExpansionInfo,
    ExpansionSpeed,
    ExpansionStatus,
    ReasoningEffort,
    LexicalOptions,
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
    MCPServerAuth,
    MCPServerDefinition,
    SchemaWarning,
    SearchRequest,
    SearchResult,
    LinkedEntry,
    OverlapCandidate,
    Playbook,
    PlaybookList,
    PlaybookStats,
    PlaybookStatus,
    PlaybookStep,
    PlaybookStepInput,
    PlaybookSummary,
    PlaybookRun,
    PlaybookVersion,
    PlaybookWriteResult,
    RunList,
    RunState,
    RunStepRecord,
    RunStepView,
    RunSummary,
    RunTransition,
    RecentQuery,
    RecentQueryList,
)

__all__ = [
    # Sync client
    "GuruCloudClient",
    "KnowledgeBank",
    # Async client
    "AsyncGuruCloudClient",
    "AsyncKnowledgeBank",
    # Client credentials
    "ClientCredentials",
    "AsyncClientCredentials",
    # Explorer UI
    "serve_ui",
    "start_ui_server",
    # Errors
    "GuruCloudError",
    "APIError",
    "AuthenticationError",
    "PermissionError",
    "NotFoundError",
    "RateLimitError",
    "PlaybookOverlapError",
    "PlaybookRunError",
    "ConnectionError",
    # Types
    "KBInfo",
    "DimensionConfig",
    "DimensionType",
    "Aggregation",
    "CombinationMode",
    "CategoryConfig",
    "CategoryFilter",
    "LexicalOptions",
    "ClientCredentialInfo",
    "CredentialProvider",
    "CredentialSource",
    "CredentialStoreStatus",
    "ExpandedSearchResult",
    "ExpansionInfo",
    "ExpansionSpeed",
    "ExpansionStatus",
    "ReasoningEffort",
    "DimensionSchema",
    "SchemaWarning",
    "EntryInput",
    "EntryResult",
    "DimensionQuery",
    "SearchRequest",
    "SearchResult",
    "MCPServerAuth",
    "MCPServerDefinition",
    "APIKeyInfo",
    "BatchIngestResult",
    "ClusterMethod",
    "ClusterAlgorithm",
    "ClusterOutlierStrategy",
    "ClusterLabelSample",
    "ClusterMemberSample",
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
    # Playbooks
    "Playbook",
    "PlaybookList",
    "PlaybookStats",
    "PlaybookStatus",
    "PlaybookStep",
    "PlaybookStepInput",
    "PlaybookSummary",
    "PlaybookVersion",
    "PlaybookWriteResult",
    # Playbook runs
    "PlaybookRun",
    "RunList",
    "RunState",
    "RunStepRecord",
    "RunStepView",
    "RunSummary",
    "RunTransition",
    "RecentQuery",
    "RecentQueryList",
    "LinkedEntry",
    "OverlapCandidate",
]

__version__ = "0.5.3"
