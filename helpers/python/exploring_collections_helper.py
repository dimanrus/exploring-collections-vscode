"""Exploring Collections helper for Python debuggees.

The extension executes this module inside the debuggee and calls ``__ec_dump``:

    __import__('builtins').exec(<this source>, globals().setdefault('__ec_ns', {})) \
        or __ec_ns['__ec_dump'](<expression>)

``__ec_dump`` returns a JSON string following the collection envelope contract::

    {"__ec": 1, "kind": "sequence" | "mapping" | "record", "total": <int|None>, "items": [...]}

The module only uses the standard library and defines no global state, so it is
safe to execute repeatedly in any frame.
"""

from __future__ import annotations

import collections.abc as _abc
import dataclasses as _dataclasses
import datetime as _datetime
import decimal as _decimal
import enum as _enum
import fractions as _fractions
import json as _json
import pathlib as _pathlib
import uuid as _uuid

__version__ = "1.0.0"

_MAX_DEPTH = 8
_MAX_ITEMS = 200000
_MAX_TEXT = 4096

_PRIMITIVE_TYPES = (str, int, float, bool, type(None))


def _truncate(value: str) -> str:
    if len(value) <= _MAX_TEXT:
        return value
    return value[:_MAX_TEXT] + "..."


def _scalar(value):
    """Returns a JSON friendly representation, or None when not scalar."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        # Very large integers would lose precision in JavaScript.
        if -9007199254740991 <= value <= 9007199254740991:
            return value
        return str(value)
    if isinstance(value, float):
        if value != value:
            return "NaN"
        if value == float("inf"):
            return "Infinity"
        if value == float("-inf"):
            return "-Infinity"
        return value
    if isinstance(value, _decimal.Decimal):
        return str(value)
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, (_datetime.datetime, _datetime.date, _datetime.time)):
        return value.isoformat()
    if isinstance(value, _datetime.timedelta):
        return value.total_seconds()
    if isinstance(value, (_uuid.UUID, _pathlib.PurePath)):
        return str(value)
    if isinstance(value, _enum.Enum):
        return value.name
    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            raw = value.tobytes() if isinstance(value, memoryview) else bytes(value)
            return raw.hex()
        except Exception:  # pragma: no cover - defensive
            return repr(value)
    if isinstance(value, (_fractions.Fraction, complex)):
        return str(value)
    return None


def _encode(value, depth: int, seen: set):
    scalar = _scalar(value)
    if scalar is not None or value is None:
        return scalar

    if depth <= 0:
        try:
            size = len(value)
        except TypeError:
            return repr(value)[:512]
        return f"<{type(value).__name__} len={size}>"

    key = id(value)
    if key in seen:
        return "<circular>"
    seen.add(key)
    try:
        if isinstance(value, _abc.Mapping):
            result = {}
            for position, (entry_key, entry_value) in enumerate(value.items()):
                if position >= _MAX_ITEMS:
                    break
                result[str(entry_key)] = _encode(entry_value, depth - 1, seen)
            return result

        if _dataclasses.is_dataclass(value) and not isinstance(value, type):
            return {
                field.name: _encode(getattr(value, field.name, None), depth - 1, seen)
                for field in _dataclasses.fields(value)
            }

        # numpy arrays, pandas Series/DataFrame and similar libraries expose
        # `tolist()`; using it produces far better output than repr().
        to_list = getattr(value, "tolist", None)
        if callable(to_list) and not isinstance(value, (list, tuple, set, frozenset)):
            try:
                converted = to_list()
                if converted is not value:
                    return _encode(converted, depth, seen)
            except Exception:  # pragma: no cover - defensive
                pass

        # namedtuple and similar tuple subclasses read better with field names.
        as_dict = getattr(value, "_asdict", None)
        if callable(as_dict):
            try:
                return {str(k): _encode(v, depth - 1, seen) for k, v in as_dict().items()}
            except Exception:  # pragma: no cover - defensive
                pass

        if isinstance(value, (list, tuple, set, frozenset, range)):
            result = []
            for position, entry in enumerate(value):
                if position >= _MAX_ITEMS:
                    break
                result.append(_encode(entry, depth - 1, seen))
            return result

        slots = getattr(type(value), "__slots__", None)
        if slots is not None and not hasattr(value, "__dict__"):
            names = slots if isinstance(slots, (list, tuple)) else (slots,)
            return {
                name: _encode(getattr(value, name, None), depth - 1, seen)
                for name in names
                if not name.startswith("__")
            }

        attributes = getattr(value, "__dict__", None)
        if isinstance(attributes, dict):
            return {
                name: _encode(entry, depth - 1, seen)
                for name, entry in list(attributes.items())[:_MAX_ITEMS]
                if not name.startswith("__")
            }

        if isinstance(value, _abc.Iterable):
            result = []
            for position, entry in enumerate(value):
                if position >= _MAX_ITEMS:
                    break
                result.append(_encode(entry, depth - 1, seen))
            return result

        return _truncate(repr(value))
    finally:
        seen.discard(key)


def _is_sequence(value) -> bool:
    if isinstance(value, (str, bytes, bytearray, memoryview, _abc.Mapping)):
        return False
    if isinstance(value, (list, tuple, set, frozenset, range)):
        return True
    if isinstance(value, _abc.Sequence):
        return True
    # Container-like objects such as deque, numpy arrays or custom collections:
    # iterable and sized, but carrying no attributes of their own.
    if isinstance(value, _abc.Iterable) and hasattr(value, "__len__"):
        return not hasattr(value, "__dict__")
    return False


def _size_of(value):
    try:
        return len(value)
    except TypeError:
        return None


def __ec_dump(value, depth: int = _MAX_DEPTH):
    """Serializes ``value`` into the envelope the extension understands."""
    seen: set = set()

    if isinstance(value, _abc.Mapping):
        items = []
        for position, (entry_key, entry_value) in enumerate(value.items()):
            if position >= _MAX_ITEMS:
                break
            items.append([_encode(entry_key, 1, seen), _encode(entry_value, depth - 1, seen)])
        return _json.dumps(
            {
                "__ec": 1,
                "kind": "mapping",
                "total": _size_of(value),
                "items": items,
            },
            ensure_ascii=False,
            default=str,
        )

    if _is_sequence(value):
        items = []
        for position, entry in enumerate(value):
            if position >= _MAX_ITEMS:
                break
            items.append(_encode(entry, depth - 1, seen))
        return _json.dumps(
            {
                "__ec": 1,
                "kind": "sequence",
                "total": _size_of(value),
                "items": items,
            },
            ensure_ascii=False,
            default=str,
        )

    return _json.dumps(
        {
            "__ec": 1,
            "kind": "record",
            "total": 1,
            "items": [_encode(value, depth - 1, seen)],
        },
        ensure_ascii=False,
        default=str,
    )
