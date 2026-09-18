"""The bundled explorer server (gurucloud_kb.ui_server).

Pins: the explorer→public-API path translation table, the proxy's error
envelope mapping (typed SDK errors → the {"error", "details"} shape api.js
renders), and the real HTTP server over a socket: host page rendering, static
assets with traversal protection, the bank list, and a proxied call that
carries the API key server-side and unwraps the {"data": …} envelope.
"""
from __future__ import annotations

import json
import urllib.request
from urllib.error import HTTPError

import httpx
import pytest
import respx

from gurucloud_kb import GuruCloudClient, start_ui_server
from gurucloud_kb.ui_server import (
    BANKS_PATH,
    STATS_PATH,
    EXPLORER_PREFIX,
    ExplorerProxy,
    Translation,
    render_index,
    translate,
    ui_dir,
)

BASE_URL = "https://test.gurucloudai.com"
API = f"{BASE_URL}/api/v1/kb"
API_KEY = "kb_test_key_abc123"
KB = "11111111-1111-4111-8111-111111111111"


# ─────────────────────────────────────────────────────────── translation


@pytest.mark.parametrize(
    "method,sub,expected",
    [
        ("GET", "/info", Translation("GET", f"/banks/{KB}", composite="info")),
        ("GET", "/mcp-server-definition", Translation("POST", f"/banks/{KB}/mcp-server-definition")),
        ("POST", "/dimensions", Translation("POST", f"/banks/{KB}/schema/dimensions")),
        ("DELETE", "/dimensions/kind", Translation("DELETE", f"/banks/{KB}/schema/dimensions/kind")),
        ("GET", "/entries", Translation("GET", f"/banks/{KB}/entries")),
        ("PUT", "/playbooks/deploy", Translation("PUT", f"/banks/{KB}/playbooks/deploy")),
        ("GET", "playbooks/deploy/versions/", Translation("GET", f"/banks/{KB}/playbooks/deploy/versions")),
        ("GET", "/queries", Translation("GET", f"/banks/{KB}/queries")),
        ("GET", "", Translation("GET", f"/banks/{KB}")),
    ],
)
def test_translate_table(method, sub, expected):
    assert translate(method, KB, sub) == expected


def test_translate_quotes_bank_names():
    t = translate("GET", "My KB", "/schema")
    assert t.path == "/banks/My%20KB/schema"


# ───────────────────────────────────────────────────────────────── proxy


def _proxy() -> ExplorerProxy:
    client = GuruCloudClient(API_KEY, base_url=BASE_URL)
    return ExplorerProxy(client._http)


@respx.mock
def test_info_merges_schema_and_tolerates_schema_failure():
    respx.get(f"{API}/banks/{KB}").mock(return_value=httpx.Response(200, json={"data": {"kb_id": KB, "name": "X"}}))
    respx.get(f"{API}/banks/{KB}/schema").mock(return_value=httpx.Response(200, json={"data": {"dimensions": [{"name": "content"}]}}))
    status, body = _proxy().handle("GET", KB, "/info")
    assert status == 200
    assert body["name"] == "X" and body["dimension_schema"]["dimensions"][0]["name"] == "content"

    respx.get(f"{API}/banks/{KB}/schema").mock(return_value=httpx.Response(500, json={"error": {"code": "boom", "message": "x"}}))
    status, body = _proxy().handle("GET", KB, "/info")
    assert status == 200 and body["dimension_schema"] is None


@respx.mock
def test_passthrough_carries_query_and_body_and_unwraps_envelope():
    route = respx.put(f"{API}/banks/{KB}/playbooks/deploy").mock(return_value=httpx.Response(200, json={"data": {"slug": "deploy", "version": 2}}))
    status, body = _proxy().handle("PUT", KB, "/playbooks/deploy", query="force=true", body={"title": "Deploy"})
    assert status == 200 and body == {"slug": "deploy", "version": 2}
    req = route.calls.last.request
    assert req.url.params["force"] == "true"
    assert json.loads(req.content) == {"title": "Deploy"}
    assert req.headers["Authorization"] == f"Bearer {API_KEY}"


@respx.mock
def test_get_mcp_server_definition_becomes_post():
    route = respx.post(f"{API}/banks/{KB}/mcp-server-definition").mock(return_value=httpx.Response(200, json={"data": {"url": "u"}}))
    status, body = _proxy().handle("GET", KB, "/mcp-server-definition")
    assert status == 200 and body == {"url": "u"} and route.called


@respx.mock
def test_playbook_overlap_maps_to_409_with_candidates():
    respx.put(f"{API}/banks/{KB}/playbooks/x").mock(return_value=httpx.Response(409, json={"error": {"code": "playbook_overlap", "message": "overlaps", "details": {"candidates": [{"slug": "y", "similarity": 0.9}]}}}))
    status, body = _proxy().handle("PUT", KB, "/playbooks/x", body={"title": "t"})
    assert status == 409
    assert body["details"]["candidates"][0]["slug"] == "y"
    assert "message" in body["details"]


@respx.mock
def test_api_errors_keep_status_and_message():
    respx.get(f"{API}/banks/{KB}/entries/nope").mock(return_value=httpx.Response(404, json={"error": {"code": "not_found", "message": "Entry not found"}}))
    status, body = _proxy().handle("GET", KB, "/entries/nope")
    assert status == 404 and "Entry not found" in body["error"] and body["details"] is None


@respx.mock
def test_connection_failure_is_502():
    respx.get(f"{API}/banks/{KB}/stats").mock(side_effect=httpx.ConnectError("refused"))
    status, body = _proxy().handle("GET", KB, "/stats")
    assert status == 502 and "refused" in body["error"]


@respx.mock
def test_list_banks_wraps_list():
    respx.get(f"{API}/banks").mock(return_value=httpx.Response(200, json={"data": [{"kb_id": KB, "name": "X"}]}))
    status, body = _proxy().list_banks()
    assert status == 200 and body == {"banks": [{"kb_id": KB, "name": "X"}]}


@respx.mock
def test_list_bank_stats_passes_the_keyed_map_through():
    respx.get(f"{API}/bank-stats").mock(return_value=httpx.Response(200, json={"data": {"generated_at": "2026-09-18T19:00:00", "stats": {KB: {"entry_count": 2, "playbooks_active": 1}}}}))
    status, body = _proxy().list_bank_stats()
    assert status == 200 and body["stats"][KB]["playbooks_active"] == 1 and body["generated_at"].startswith("2026-09-18")


@respx.mock
def test_list_bank_stats_failure_is_the_explorer_error_envelope():
    respx.get(f"{API}/bank-stats").mock(return_value=httpx.Response(503, json={"error": {"code": "kb_service_unavailable", "message": "down"}}))
    status, body = _proxy().list_bank_stats()
    assert status == 503 and "down" in body["error"] and body["details"] is None


# ───────────────────────────────────────────────────────────── host page


def test_render_index_fills_placeholders():
    html = render_index(mode="sdk")
    assert 'data-mode="sdk"' in html
    assert f'data-api-base="{EXPLORER_PREFIX}{{kb}}"' in html
    assert f'data-banks-url="{BANKS_PATH}"' in html
    assert f'data-stats-url="{STATS_PATH}"' in html
    assert "data-token-gate" not in html and "{{" not in html
    assert 'data-token-gate="1"' in render_index(mode="platform", token_gate=True)


def test_bundle_is_complete():
    d = ui_dir()
    for rel in ("index.html", "kb-explorer.css", "js/main.js", "js/host.js", "js/map.js", "js/map_layout.js",
                "vendor/cytoscape.min.js", "vendor/dagre.min.js", "vendor/cytoscape-dagre.js",
                "vendor/bootstrap-icons.min.css", "vendor/fonts/bootstrap-icons.woff2"):
        assert (d / rel).is_file(), rel


# ─────────────────────────────────────────────────────────── real server


def _get(url: str):
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.headers, resp.read()
    except HTTPError as e:
        return e.code, e.headers, e.read()


@pytest.fixture
def server():
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{API}/banks").mock(return_value=httpx.Response(200, json={"data": [{"kb_id": KB, "name": "X", "entry_count": 2}]}))
        mock.get(f"{API}/bank-stats").mock(return_value=httpx.Response(200, json={"data": {"generated_at": "2026-09-18T19:00:00", "stats": {KB: {"entry_count": 2, "queries_total": 5}}}}))
        mock.get(f"{API}/banks/{KB}/entries").mock(return_value=httpx.Response(200, json={"data": {"entries": [{"id": "e1"}], "total": 1}}))
        client = GuruCloudClient(API_KEY, base_url=BASE_URL)
        srv = start_ui_server(client, kb=KB, port=0).start()
        try:
            yield srv
        finally:
            srv.stop()


def test_server_url_preselects_bank(server):
    assert server.url.startswith(f"http://127.0.0.1:{server.port}/?kb=")


def test_server_serves_host_page(server):
    status, headers, body = _get(f"http://127.0.0.1:{server.port}/")
    assert status == 200 and headers["Content-Type"].startswith("text/html")
    assert b'id="kbx-root"' in body and b'data-mode="sdk"' in body


def test_server_serves_static_with_types_and_blocks_traversal(server):
    base = f"http://127.0.0.1:{server.port}"
    status, headers, body = _get(f"{base}/js/main.js")
    assert status == 200 and headers["Content-Type"].startswith("text/javascript") and b"bootExplorer" in body
    status, headers, _ = _get(f"{base}/kb-explorer.css")
    assert status == 200 and headers["Content-Type"].startswith("text/css")
    status, headers, _ = _get(f"{base}/vendor/fonts/bootstrap-icons.woff2")
    assert status == 200 and headers["Content-Type"] == "font/woff2"
    status, _, _ = _get(f"{base}/../pyproject.toml")
    assert status == 404
    status, _, _ = _get(f"{base}/js/%2e%2e/%2e%2e/__init__.py")
    assert status == 404
    status, _, _ = _get(f"{base}/index.html.bak")
    assert status == 404


def test_server_lists_banks_and_proxies(server):
    base = f"http://127.0.0.1:{server.port}"
    status, _, body = _get(f"{base}{BANKS_PATH}")
    assert status == 200 and json.loads(body)["banks"][0]["kb_id"] == KB
    status, _, body = _get(f"{base}{STATS_PATH}")
    assert status == 200 and json.loads(body)["stats"][KB]["queries_total"] == 5
    status, headers, body = _get(f"{base}{EXPLORER_PREFIX}{KB}/entries?limit=5")
    assert status == 200 and headers["Cache-Control"] == "no-store"
    assert json.loads(body) == {"entries": [{"id": "e1"}], "total": 1}


def test_server_rejects_unknown_paths_and_methods(server):
    base = f"http://127.0.0.1:{server.port}"
    status, _, _ = _get(f"{base}{EXPLORER_PREFIX}")
    assert status == 404
    req = urllib.request.Request(f"{base}/js/main.js", method="POST")
    try:
        urllib.request.urlopen(req, timeout=5)
        assert False, "expected 405"
    except HTTPError as e:
        assert e.code == 405
