"""The gurucloud-kb command line (gurucloud_kb.cli)."""
from __future__ import annotations

import pytest

from gurucloud_kb import cli
from gurucloud_kb.client import _DEFAULT_BASE_URL


def test_ui_parser_defaults():
    args = cli.build_parser().parse_args(["ui"])
    assert args.command == "ui" and args.kb is None and args.host == "127.0.0.1" and args.port == 8765
    assert args.no_browser is False and args.allow_insecure is False


def test_credentials_prefer_flags_over_env():
    args = cli.build_parser().parse_args(["ui", "--api-key", "kb_flag", "--base-url", "https://flag"])
    key, url = cli.resolve_credentials(args, environ={cli.ENV_API_KEY: "kb_env", cli.ENV_BASE_URL: "https://env"})
    assert (key, url) == ("kb_flag", "https://flag")


def test_credentials_fall_back_to_env_then_default_base():
    args = cli.build_parser().parse_args(["ui"])
    key, url = cli.resolve_credentials(args, environ={cli.ENV_API_KEY: "kb_env"})
    assert (key, url) == ("kb_env", _DEFAULT_BASE_URL)


def test_missing_key_is_a_usage_error():
    args = cli.build_parser().parse_args(["ui"])
    with pytest.raises(SystemExit) as exc:
        cli.resolve_credentials(args, environ={})
    assert cli.ENV_API_KEY in str(exc.value)


def test_main_serves_with_resolved_client(monkeypatch):
    seen = {}

    def fake_serve(client, kb, *, host, port, open_browser):
        seen.update(kb=kb, host=host, port=port, open_browser=open_browser, base=client._http._base_url)

    monkeypatch.setattr("gurucloud_kb.ui_server.serve_ui", fake_serve)
    rc = cli.main(["ui", "--kb", "My KB", "--api-key", "kb_x", "--base-url", "https://p.example", "--port", "0", "--no-browser"])
    assert rc == 0
    assert seen == {"kb": "My KB", "host": "127.0.0.1", "port": 0, "open_browser": False, "base": "https://p.example"}


def test_insecure_base_url_needs_flag():
    with pytest.raises(ValueError):
        cli.main(["ui", "--api-key", "tok", "--base-url", "http://localhost:8006", "--no-browser"])
