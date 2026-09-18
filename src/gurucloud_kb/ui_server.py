"""Serve the bundled KB Explorer locally, proxied through the SDK.

The explorer UI ships inside this package (``gurucloud_kb/ui``: HTML, CSS, ES
modules, vendored Cytoscape). :func:`serve_ui` starts a small stdlib HTTP server
on localhost that

* serves those static files,
* renders ``index.html`` for the standalone host (bank picker + explorer),
* answers ``GET /api/kb-explorer-banks`` with the banks the key can see,
  ``GET /api/kb-explorer-bank-stats`` with their live stats, and
* proxies ``/api/kb-explorer/<kb>/<resource>`` — the route shape the UI's
  ``api.js`` speaks — onto the public ``/api/v1/kb/banks/<kb>/…`` API through
  the SDK's own transport, so the API key never reaches the browser and there
  is no CORS.

The same route shape is served by the hosted app (session auth) and by the
self-hosted KB platform image (``/ui``), so one UI works against all three.

Usage::

    from gurucloud_kb import GuruCloudClient, serve_ui
    serve_ui(GuruCloudClient(api_key="kb_..."), kb="my-kb")   # blocks; opens a browser

or from a shell: ``gurucloud-kb ui --kb my-kb`` (see :mod:`gurucloud_kb.cli`).
"""

from __future__ import annotations

import json
import mimetypes
import threading
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional
from urllib.parse import parse_qs, quote, unquote, urlsplit

from gurucloud_kb.errors import APIError, ConnectionError as SDKConnectionError, PlaybookOverlapError

if TYPE_CHECKING:  # pragma: no cover
    from gurucloud_kb._http import HTTPClient
    from gurucloud_kb.client import GuruCloudClient

EXPLORER_PREFIX = "/api/kb-explorer/"
BANKS_PATH = "/api/kb-explorer-banks"
STATS_PATH = "/api/kb-explorer-bank-stats"
UI_DIR = Path(__file__).resolve().parent / "ui"

_STATIC_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".svg": "image/svg+xml",
}


def ui_dir() -> Path:
    """Directory holding the bundled explorer (index.html, kb-explorer.css, js/, vendor/)."""
    return UI_DIR


# ─────────────────────────────────────────────────────────────── index page


def render_index(
    *,
    mode: str = "sdk",
    api_base: str = EXPLORER_PREFIX + "{kb}",
    banks_url: str = BANKS_PATH,
    stats_url: str = STATS_PATH,
    token_gate: bool = False,
) -> str:
    """The standalone host page with its placeholders filled in.

    ``api_base`` keeps the literal ``{kb}`` — the UI substitutes the selected
    bank id itself. ``token_gate`` makes the page ask for a bearer token and send
    it on every API call (the self-hosted platform needs that; the SDK server
    holds the key server-side and does not).
    """
    html = (UI_DIR / "index.html").read_text(encoding="utf-8")
    return (
        html.replace("{{MODE}}", mode)
        .replace("{{API_BASE}}", api_base)
        .replace("{{BANKS_URL}}", banks_url)
        .replace("{{STATS_URL}}", stats_url)
        .replace("{{TOKEN_GATE}}", 'data-token-gate="1"' if token_gate else "")
    )


# ───────────────────────────────────────────────────────── path translation


@dataclass(frozen=True)
class Translation:
    """How one explorer request maps onto the public API.

    ``composite`` names a multi-call resource (today only ``"info"``: bank card
    merged with the dimension schema). Otherwise ``method`` + ``path`` (relative
    to the transport's ``/api/v1/kb`` base) is a single passthrough call.
    """

    method: str
    path: str
    composite: Optional[str] = None


def translate(method: str, kb: str, subpath: str) -> Translation:
    """Map an explorer route (``/api/kb-explorer/<kb><subpath>``) to the API.

    Pure and total: every ``(method, subpath)`` yields a translation, so the
    proxy never has to hard-code the resource list — the explorer API and the
    public API share their shape except for the four cases handled here.
    """
    kb_seg = quote(kb, safe="")
    base = f"/banks/{kb_seg}"
    sub = "/" + subpath.strip("/") if subpath.strip("/") else ""
    m = method.upper()
    if sub == "/info" and m == "GET":
        return Translation("GET", base, composite="info")
    if sub == "/mcp-server-definition" and m == "GET":
        return Translation("POST", f"{base}/mcp-server-definition")
    if sub == "/dimensions" and m == "POST":
        return Translation("POST", f"{base}/schema/dimensions")
    if sub.startswith("/dimensions/") and m == "DELETE":
        return Translation("DELETE", f"{base}/schema{sub}")
    return Translation(m, f"{base}{sub}")


def _flatten_query(query: str) -> dict[str, str]:
    return {k: v[-1] for k, v in parse_qs(query, keep_blank_values=False).items()}


class ExplorerProxy:
    """Execute explorer requests against the public API via an :class:`HTTPClient`.

    Returns ``(status, body)`` where ``body`` is JSON-serialisable and uses the
    explorer error envelope ``{"error": <message>, "details": <payload|None>}``
    on failure — the shape ``api.js`` renders.
    """

    def __init__(self, http: "HTTPClient") -> None:
        self._http = http

    def list_banks(self) -> tuple[int, Any]:
        try:
            banks = self._http.get("/banks")
        except Exception as exc:  # noqa: BLE001 - mapped below
            return self._error(exc)
        return 200, {"banks": banks}

    def list_bank_stats(self) -> tuple[int, Any]:
        """Live per-bank stats (``GET /bank-stats``) for the table's stats
        columns; the UI treats a failure as "stats unavailable" and keeps the
        base columns."""
        try:
            stats = self._http.get("/bank-stats")
        except Exception as exc:  # noqa: BLE001 - mapped below
            return self._error(exc)
        return 200, stats

    def handle(self, method: str, kb: str, subpath: str, query: str = "", body: Any = None) -> tuple[int, Any]:
        t = translate(method, kb, subpath)
        params = _flatten_query(query) or None
        try:
            if t.composite == "info":
                info = self._http.get(t.path)
                try:
                    info["dimension_schema"] = self._http.get(f"{t.path}/schema")
                except Exception:  # noqa: BLE001 - schema is best-effort, like the hosted route
                    info["dimension_schema"] = None
                return 200, info
            if t.method == "GET":
                return 200, self._http.get(t.path, params=params)
            if t.method == "POST":
                return 200, self._http.post(t.path, json=body, params=params)
            if t.method == "PUT":
                return 200, self._http.put(t.path, json=body, params=params)
            if t.method == "PATCH":
                return 200, self._http.patch(t.path, json=body, params=params)
            if t.method == "DELETE":
                return 200, self._http.delete(t.path, params=params)
            return 405, {"error": f"Method {t.method} not allowed"}
        except Exception as exc:  # noqa: BLE001 - mapped to the explorer envelope
            return self._error(exc)

    @staticmethod
    def _error(exc: Exception) -> tuple[int, Any]:
        if isinstance(exc, PlaybookOverlapError):
            # PlaybookOverlapError unpacks the 409 body onto attributes; rebuild
            # the details dict the explorer UI renders (details.candidates).
            details: dict[str, Any] = {"candidates": exc.candidates, "message": str(exc)}
            if exc.slug is not None:
                details["slug"] = exc.slug
            if exc.threshold is not None:
                details["threshold"] = exc.threshold
            return 409, {"error": str(exc), "details": details}
        if isinstance(exc, APIError):
            return exc.status_code, {"error": str(exc), "details": None}
        if isinstance(exc, SDKConnectionError):
            return 502, {"error": str(exc), "details": None}
        return 500, {"error": f"Proxy error: {exc}", "details": None}


# ─────────────────────────────────────────────────────────────── the server


def _safe_static_path(url_path: str) -> Optional[Path]:
    """Resolve a URL path to a file inside ``UI_DIR`` or None (traversal-safe)."""
    rel = unquote(url_path).lstrip("/")
    if not rel or rel == "index.html":
        return None
    candidate = (UI_DIR / rel).resolve()
    try:
        candidate.relative_to(UI_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def make_handler(proxy: ExplorerProxy, *, default_kb: Optional[str], log: Optional[Callable[[str], None]] = None):
    """Build the request handler class bound to one proxy."""

    class ExplorerHandler(BaseHTTPRequestHandler):
        server_version = "gurucloud-kb-ui/1"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401 - stdlib hook
            if log:
                log(fmt % args)

        # ── helpers ──
        def _send_json(self, status: int, body: Any) -> None:
            data = json.dumps(body, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _send_bytes(self, status: int, data: bytes, content_type: str, cache: str = "no-cache") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(data)

        def _read_body(self) -> Any:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return None
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except ValueError:
                return None

        def _dispatch(self, method: str) -> None:
            parts = urlsplit(self.path)
            path = parts.path
            if path.startswith(EXPLORER_PREFIX):
                rest = path[len(EXPLORER_PREFIX):]
                kb, _, sub = rest.partition("/")
                if not kb:
                    self._send_json(404, {"error": "Knowledge Bank id missing"})
                    return
                body = self._read_body() if method in {"POST", "PUT", "PATCH"} else None
                status, payload = proxy.handle(method, unquote(kb), "/" + sub, parts.query, body)
                self._send_json(status, payload)
                return
            if path == BANKS_PATH and method == "GET":
                status, payload = proxy.list_banks()
                self._send_json(status, payload)
                return
            if path == STATS_PATH and method == "GET":
                status, payload = proxy.list_bank_stats()
                self._send_json(status, payload)
                return
            if method != "GET":
                self._send_json(405, {"error": "Method not allowed"})
                return
            if path in ("/", "/index.html"):
                html = render_index(mode="sdk")
                self._send_bytes(200, html.encode("utf-8"), "text/html; charset=utf-8")
                return
            static = _safe_static_path(path)
            if static is None:
                self._send_json(404, {"error": "Not found"})
                return
            ctype = _STATIC_TYPES.get(static.suffix.lower()) or mimetypes.guess_type(str(static))[0] or "application/octet-stream"
            self._send_bytes(200, static.read_bytes(), ctype, cache="public, max-age=3600")

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_PUT(self) -> None:  # noqa: N802
            self._dispatch("PUT")

        def do_PATCH(self) -> None:  # noqa: N802
            self._dispatch("PATCH")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

    ExplorerHandler.default_kb = default_kb  # type: ignore[attr-defined]
    return ExplorerHandler


class UIServer:
    """A running explorer server. Use :func:`start_ui_server` to create one."""

    def __init__(self, httpd: ThreadingHTTPServer, *, kb: Optional[str]) -> None:
        self._httpd = httpd
        self._thread: Optional[threading.Thread] = None
        self.kb = kb

    @property
    def host(self) -> str:
        return str(self._httpd.server_address[0])

    @property
    def port(self) -> int:
        return int(self._httpd.server_address[1])

    @property
    def url(self) -> str:
        base = f"http://{self.host}:{self.port}/"
        return f"{base}?kb={quote(self.kb, safe='')}" if self.kb else base

    def start(self) -> "UIServer":
        """Serve in a daemon thread and return immediately."""
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="gurucloud-kb-ui", daemon=True)
        self._thread.start()
        return self

    def serve_forever(self) -> None:
        """Serve on the calling thread until interrupted."""
        try:
            self._httpd.serve_forever()
        except KeyboardInterrupt:  # pragma: no cover - interactive
            pass
        finally:
            self._httpd.server_close()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread:
            self._thread.join(timeout=5)


def start_ui_server(
    client: "GuruCloudClient",
    *,
    kb: Optional[str] = None,
    host: str = "127.0.0.1",
    port: int = 8765,
    log: Optional[Callable[[str], None]] = None,
) -> UIServer:
    """Bind the explorer server (not yet serving). ``port=0`` picks a free port.

    ``kb`` (id or exact name) preselects a bank in the URL; without it the page
    lists the banks the key can see.
    """
    proxy = ExplorerProxy(client._http)  # noqa: SLF001 - same package
    handler = make_handler(proxy, default_kb=kb, log=log)
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return UIServer(httpd, kb=kb)


def serve_ui(
    client: "GuruCloudClient",
    kb: Optional[str] = None,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    open_browser: bool = True,
    log: Optional[Callable[[str], None]] = print,
) -> None:
    """Serve the explorer and block until Ctrl-C.

    Args:
        client: An authenticated :class:`GuruCloudClient` (hosted or self-hosted).
        kb: Bank id or exact name to open; omit for the bank picker.
        host / port: Bind address (loopback by default — the key stays local).
        open_browser: Open the page in the default browser once serving.
    """
    server = start_ui_server(client, kb=kb, host=host, port=port, log=None)
    if log:
        log(f"KB Explorer serving at {server.url}  (Ctrl-C to stop)")
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(server.url)).start()
    server.serve_forever()
