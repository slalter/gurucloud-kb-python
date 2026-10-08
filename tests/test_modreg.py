"""The module_registry harness mirrored into the SDK (gurucloud_kb.modreg)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import gurucloud_kb
from gurucloud_kb.modreg import cli, scan


def test_cli_help_runs_without_the_modreg_extras():
    # scan/purity/replay/corpus tools are stdlib-only; the ledger (psycopg2) and
    # fuzz (hypothesis) import lazily, so --help never needs the extras.
    out = subprocess.run([sys.executable, "-m", "gurucloud_kb.modreg", "--help"], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "python -m gurucloud_kb.modreg" in out.stdout and "ledger" in out.stdout


def test_scan_finds_shared_modules_in_a_foreign_repo(tmp_path: Path, capsys):
    (tmp_path / "src" / "utils").mkdir(parents=True)
    (tmp_path / "src" / "utils" / "slug.py").write_text("def slugify(s):\n    return s.lower()\n")
    (tmp_path / "src" / "app.py").write_text("from src.utils.slug import slugify\n")
    assert cli.main(["scan", "--root", str(tmp_path), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert [c["path"] for c in data] == ["src/utils/slug.py"] and data[0]["exports"] == ["slugify"]
    assert scan.DEFAULT_FAN_IN_THRESHOLD == 6


def test_generated_characterization_test_imports_the_mirror(tmp_path: Path):
    # In a foreign repo the generated test must import the harness from the wheel.
    assert cli.HARNESS_PACKAGE == "gurucloud_kb.modreg"
    corpus = tmp_path / "c.jsonl"
    corpus.write_text("")
    test_file, _ = cli.write_corpus_test(corpus, "pkg.mod:fn", tmp_path / "out" / "test_fn_equivalence.py")
    text = test_file.read_text()
    assert "from gurucloud_kb.modreg.replay import replay_corpus" in text
    assert "services.module_registry" not in text


def test_version_bumped_with_the_harness():
    assert gurucloud_kb.__version__ == "0.5.6"
