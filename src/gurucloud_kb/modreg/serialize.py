"""Canonical, byte-stable serialization used by the tracer, replay, fuzz and
shadow stages. Two values are "equivalent" iff their canonical bytes match.

Rules (deterministic by construction):
* dict keys sorted; sets sorted by their canonical form; tuples/lists kept in
  order but distinguished from each other.
* floats rendered with ``repr`` (round-trip exact); NaN/inf spelled out.
* bytes hex-encoded; datetimes/dates/times/timedeltas/Decimal/UUID/Path/Enum
  rendered through a tagged form so ``"2024-01-01"`` != ``date(2024,1,1)``.
* dataclasses and Pydantic models are walked by field; other objects fall back
  to a tagged ``__dict__`` walk, and anything still opaque becomes an
  ``<opaque:qualname>`` tag — which the caller treats as NOT comparable.
* exceptions serialize as type + args, so a raised ``ValueError("x")`` on both
  sides is equivalence, and a different exception type is a mismatch.

``MAX_BYTES`` guards the production paths: a value whose canonical form
exceeds it is replaced by a sha256 digest tag (``<hashed:...>``). Hashed
values still compare (same input → same digest) but the pair is flagged
``needs_offline_evidence`` by the tracer.
"""
from __future__ import annotations

import dataclasses
import datetime as _dt
import decimal
import enum
import hashlib
import json
import math
import pathlib
import uuid
from typing import Any, Optional

MAX_BYTES = 64 * 1024
OPAQUE_PREFIX = "<opaque:"
HASHED_PREFIX = "<hashed:"


class CanonicalError(TypeError):
    """Raised when a value cannot be canonicalised at all."""


def _tag(kind: str, value: Any) -> dict[str, Any]:
    return {"__t": kind, "v": value}


def to_canonical(value: Any, *, _depth: int = 0) -> Any:
    """Return a JSON-compatible structure whose ``json.dumps(sort_keys=True)``
    is byte-stable for equivalent inputs."""
    if _depth > 64:
        return _tag("opaque", f"{OPAQUE_PREFIX}depth>")
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return _tag("float", "nan")
        if math.isinf(value):
            return _tag("float", "inf" if value > 0 else "-inf")
        return _tag("float", repr(value))
    if isinstance(value, bytes):
        return _tag("bytes", value.hex())
    if isinstance(value, bytearray):
        return _tag("bytearray", bytes(value).hex())
    if isinstance(value, decimal.Decimal):
        return _tag("decimal", str(value))
    if isinstance(value, uuid.UUID):
        return _tag("uuid", str(value))
    if isinstance(value, enum.Enum):
        return _tag("enum", [type(value).__qualname__, value.name])
    if isinstance(value, _dt.datetime):
        return _tag("datetime", [value.isoformat(), value.tzinfo is not None])
    if isinstance(value, _dt.date):
        return _tag("date", value.isoformat())
    if isinstance(value, _dt.time):
        return _tag("time", [value.isoformat(), value.tzinfo is not None])
    if isinstance(value, _dt.timedelta):
        return _tag("timedelta", value.total_seconds())
    if isinstance(value, pathlib.PurePath):
        return _tag("path", str(value))
    if isinstance(value, BaseException):
        return _tag("exception", [type(value).__qualname__, [to_canonical(a, _depth=_depth + 1) for a in value.args]])
    if isinstance(value, dict):
        items = []
        for k, v in value.items():
            ck = k if isinstance(k, str) else json.dumps(to_canonical(k, _depth=_depth + 1), sort_keys=True)
            items.append((ck, to_canonical(v, _depth=_depth + 1)))
        return {"__t": "dict", "v": dict(sorted(items, key=lambda kv: kv[0]))}
    if isinstance(value, tuple):
        return _tag("tuple", [to_canonical(v, _depth=_depth + 1) for v in value])
    if isinstance(value, list):
        return [to_canonical(v, _depth=_depth + 1) for v in value]
    if isinstance(value, (set, frozenset)):
        members = [to_canonical(v, _depth=_depth + 1) for v in value]
        members.sort(key=lambda m: json.dumps(m, sort_keys=True))
        return _tag("set" if isinstance(value, set) else "frozenset", members)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        fields = {f.name: to_canonical(getattr(value, f.name), _depth=_depth + 1) for f in dataclasses.fields(value)}
        return _tag("dataclass", [type(value).__qualname__, fields])
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _tag("model", [type(value).__qualname__, to_canonical(model_dump(), _depth=_depth + 1)])
        except Exception:  # pragma: no cover - defensive: fall through to __dict__
            pass
    obj_dict = getattr(value, "__dict__", None)
    if isinstance(obj_dict, dict) and not callable(value):
        fields = {k: to_canonical(v, _depth=_depth + 1) for k, v in obj_dict.items() if not k.startswith("_")}
        return _tag("object", [type(value).__qualname__, fields])
    return _tag("opaque", f"{OPAQUE_PREFIX}{type(value).__module__}.{type(value).__qualname__}>")


def canonical_bytes(value: Any) -> bytes:
    """UTF-8 bytes of the canonical JSON form. Deterministic for equal inputs."""
    return json.dumps(to_canonical(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def is_opaque(value: Any) -> bool:
    """True when the canonical form contains any opaque tag (value is not
    comparable — the pair needs a card, not a proof)."""
    return OPAQUE_PREFIX.encode("utf-8") in canonical_bytes(value)


def canonical_or_hash(value: Any, *, max_bytes: int = MAX_BYTES) -> tuple[bytes, bool]:
    """Canonical bytes, or a digest tag when they exceed ``max_bytes``.
    Returns ``(bytes, hashed)``."""
    raw = canonical_bytes(value)
    if len(raw) <= max_bytes:
        return raw, False
    digest = hashlib.sha256(raw).hexdigest()
    return f"{HASHED_PREFIX}{digest}>".encode("utf-8"), True


def call_signature_bytes(args: tuple[Any, ...], kwargs: dict[str, Any]) -> bytes:
    """Canonical bytes for a call's positional + keyword arguments."""
    return canonical_bytes({"args": list(args), "kwargs": kwargs})


def outcome_bytes(result: Any = None, error: Optional[BaseException] = None) -> bytes:
    """Canonical bytes for a call outcome: either a result or a raised error."""
    if error is not None:
        return canonical_bytes({"error": error})
    return canonical_bytes({"result": result})


class NotReplayable(ValueError):
    """The canonical form cannot be turned back into a live Python value
    (opaque object, hashed value, enum/dataclass/model without its class)."""


def from_canonical(node: Any) -> Any:
    """Inverse of :func:`to_canonical` for replayable values. Raises
    :class:`NotReplayable` for tags that carry no reconstructable payload."""
    if node is None or isinstance(node, (bool, str, int)):
        if isinstance(node, str) and (node.startswith(OPAQUE_PREFIX) or node.startswith(HASHED_PREFIX)):
            raise NotReplayable(node)
        return node
    if isinstance(node, list):
        return [from_canonical(v) for v in node]
    if not isinstance(node, dict) or "__t" not in node:
        raise NotReplayable(f"untagged node {type(node).__name__}")
    kind = node["__t"]
    if "v" not in node or node["v"] is None:
        raise NotReplayable(f"tag {kind!r} without payload")
    v: Any = node["v"]
    if kind == "dict":
        return {k: from_canonical(val) for k, val in v.items()}
    if kind == "tuple":
        return tuple(from_canonical(x) for x in v)
    if kind in ("set", "frozenset"):
        members = [from_canonical(x) for x in v]
        return set(members) if kind == "set" else frozenset(members)
    if kind == "float":
        return {"nan": math.nan, "inf": math.inf, "-inf": -math.inf}.get(v, None) if v in ("nan", "inf", "-inf") else float(v)
    if kind == "bytes":
        return bytes.fromhex(v)
    if kind == "bytearray":
        return bytearray.fromhex(v)
    if kind == "decimal":
        return decimal.Decimal(v)
    if kind == "uuid":
        return uuid.UUID(v)
    if kind == "datetime":
        return _dt.datetime.fromisoformat(v[0])
    if kind == "date":
        return _dt.date.fromisoformat(v)
    if kind == "time":
        return _dt.time.fromisoformat(v[0])
    if kind == "timedelta":
        return _dt.timedelta(seconds=v)
    if kind == "path":
        return pathlib.PurePosixPath(v)
    if kind == "exception":
        raise NotReplayable("exception values are outcomes, not inputs")
    raise NotReplayable(f"tag {kind!r} ({str(v)[:60]})")
