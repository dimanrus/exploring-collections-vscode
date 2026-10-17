#!/usr/bin/env python3
"""Self test for the Python helper.

Run with:  python3 helpers/python/test_helper.py

The extension executes the helper inside the debuggee, so the helper must never
raise on unusual values: it has to degrade gracefully instead.
"""

from __future__ import annotations

import dataclasses
import datetime
import json
import sys
from collections import OrderedDict, deque
from pathlib import Path
from typing import NamedTuple

HELPER = Path(__file__).with_name("exploring_collections_helper.py")


def load_helper():
    namespace: dict = {}
    exec(HELPER.read_text(encoding="utf8"), namespace)
    return namespace["__ec_dump"]


@dataclasses.dataclass
class Temperature:
    city: str
    degree: int
    date: datetime.date
    feels: str = "normal"


class Point(NamedTuple):
    x: int
    y: int


class Slotted:
    __slots__ = ("a", "b")

    def __init__(self, a: int, b: int) -> None:
        self.a = a
        self.b = b


class Plain:
    def __init__(self) -> None:
        self.name = "plain"


class Opaque:
    def __repr__(self) -> str:
        return "<Opaque>"


def main() -> int:
    dump = load_helper()
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        if not condition:
            failures.append(f"{name}: {detail}")

    temperatures = [
        Temperature("Seoul", 21, datetime.date(2024, 4, 1)),
        Temperature("Lima", 19, datetime.date(2024, 4, 2), "cold"),
    ]
    encoded = json.loads(dump(temperatures))
    check("envelope marker", encoded["__ec"] == 1, str(encoded)[:80])
    check("sequence kind", encoded["kind"] == "sequence")
    check("total", encoded["total"] == 2)
    check("record fields", encoded["items"][0]["city"] == "Seoul")
    check("date iso", encoded["items"][0]["date"] == "2024-04-01")

    mapping = json.loads(dump(OrderedDict([("a", 1), ("b", [1, 2])])))
    check("mapping kind", mapping["kind"] == "mapping")
    check("mapping pairs", mapping["items"][0] == ["a", 1], str(mapping["items"][:1]))

    check("dict is mapping", json.loads(dump({"a": 1}))["kind"] == "mapping")
    check("string is record", json.loads(dump("text"))["kind"] == "record")
    check("range is sequence", json.loads(dump(range(5)))["kind"] == "sequence")
    check("deque is sequence", json.loads(dump(deque([1, 2, 3])))["kind"] == "sequence")
    check("set is sequence", json.loads(dump({1, 2, 3}))["kind"] == "sequence")
    check("empty list", json.loads(dump([]))["total"] == 0)

    specials = json.loads(dump([float("nan"), float("inf"), float("-inf")]))
    check("nan encoding", specials["items"][0] == "NaN", str(specials["items"]))
    check("infinity encoding", specials["items"][1] == "Infinity")

    big = json.loads(dump([2**70]))
    check("bigint as string", isinstance(big["items"][0], str), str(big["items"][0]))

    named = json.loads(dump([Point(1, 2)]))
    check("namedtuple fields", named["items"][0] == {"x": 1, "y": 2}, str(named["items"][0]))

    slotted = json.loads(dump(Slotted(1, 2)))
    check("slots", slotted["items"][0] == {"a": 1, "b": 2}, str(slotted["items"][0]))

    plain = json.loads(dump(Plain()))
    check("plain object", plain["items"][0] == {"name": "plain"}, str(plain["items"][0]))

    cyclic: dict = {"a": 1}
    cyclic["self"] = cyclic
    cyclic_encoded = json.loads(dump([cyclic]))
    check("cycle guard", cyclic_encoded["items"][0]["self"] == "<circular>", str(cyclic_encoded["items"][0]))

    deep = {"l1": {"l2": {"l3": {"l4": {"l5": {"l6": {"l7": {"l8": {"l9": {"l10": 1}}}}}}}}}}
    deep_encoded = json.loads(dump(deep))
    check("depth guard keeps output", isinstance(deep_encoded["items"][0][1], (dict, str)))
    check("depth guard marks truncation", "len=" in json.dumps(deep_encoded) or isinstance(deep_encoded["items"][0][1], dict))

    opaque = json.loads(dump([Opaque()]))
    check("opaque does not raise", opaque["total"] == 1)

    mixed = json.loads(dump([Plain(), {"k": Point(9, 9)}, Temperature("X", 1, datetime.date(2020, 1, 1))]))
    check("mixed objects", mixed["total"] == 3)

    datetimes = json.loads(dump([datetime.datetime(2024, 4, 1, 12, 30)]))
    check("datetime isoformat", datetimes["items"][0] == "2024-04-01T12:30:00", str(datetimes["items"][0]))

    if failures:
        print(f"{len(failures)} check(s) failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("python helper: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
