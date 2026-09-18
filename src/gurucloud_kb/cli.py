"""``gurucloud-kb`` command line.

Today one subcommand::

    gurucloud-kb ui [--kb ID_OR_NAME] [--api-key KEY] [--base-url URL]
                    [--host 127.0.0.1] [--port 8765] [--no-browser] [--allow-insecure]

The key comes from ``--api-key`` or the ``GURUCLOUD_KB_API_KEY`` environment
variable; the base URL from ``--base-url`` or ``GURUCLOUD_KB_BASE_URL`` (default:
the hosted API). Exit codes: 0 clean stop, 2 usage error.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Optional, Sequence

from gurucloud_kb.client import _DEFAULT_BASE_URL, GuruCloudClient

ENV_API_KEY = "GURUCLOUD_KB_API_KEY"
ENV_BASE_URL = "GURUCLOUD_KB_BASE_URL"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gurucloud-kb", description="GuruCloud Knowledge Bank SDK tools.")
    sub = parser.add_subparsers(dest="command", required=True)

    ui = sub.add_parser("ui", help="Open the Knowledge Bank Explorer in your browser (served locally, key stays on this machine).")
    ui.add_argument("--kb", help="Bank id or exact name to open. Omit to pick from a list.")
    ui.add_argument("--api-key", help=f"KB API key (kb_...) or platform service token. Default: ${ENV_API_KEY}.")
    ui.add_argument("--base-url", help=f"API base URL. Default: ${ENV_BASE_URL} or the hosted API.")
    ui.add_argument("--host", default="127.0.0.1", help="Bind address (default 127.0.0.1).")
    ui.add_argument("--port", type=int, default=8765, help="Port (default 8765; 0 = any free port).")
    ui.add_argument("--no-browser", action="store_true", help="Do not open a browser tab.")
    ui.add_argument("--allow-insecure", action="store_true", help="Allow an http:// base URL (local development only).")
    return parser


def resolve_credentials(args: argparse.Namespace, environ: Optional[dict[str, str]] = None) -> tuple[str, str]:
    """(api_key, base_url) from flags then environment; raises SystemExit(2) when the key is missing."""
    env = os.environ if environ is None else environ
    api_key = args.api_key or env.get(ENV_API_KEY, "")
    base_url = args.base_url or env.get(ENV_BASE_URL) or _DEFAULT_BASE_URL
    if not api_key:
        raise SystemExit(f"error: no API key. Pass --api-key or set {ENV_API_KEY}.")
    return api_key, base_url


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "ui":
        api_key, base_url = resolve_credentials(args)
        client = GuruCloudClient(api_key, base_url=base_url, allow_insecure=args.allow_insecure)
        from gurucloud_kb.ui_server import serve_ui

        serve_ui(client, args.kb, host=args.host, port=args.port, open_browser=not args.no_browser)
        return 0
    parser.error(f"unknown command {args.command!r}")  # pragma: no cover - argparse exits first
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
