# 🧰 Helper libraries

The collection view always works: with no helper at all, the extension walks the
debugger's variable tree (`variables` requests) and builds the grid from it.
Helpers make that path faster and richer by serializing a whole collection in a
single expression.

Everything the extension can load is described by a small **envelope contract**,
so any helper — including your own — can produce data the UI understands:

```json
{ "__ec": 1, "kind": "sequence" | "mapping" | "record", "total": 14, "items": [ ... ] }
```

| `kind` | meaning | `items` |
| --- | --- | --- |
| `sequence` | list, array, set, slice | one entry per element |
| `mapping` | dictionary, map, hash | `[key, value]` pairs |
| `record` | a single object | one entry, the object itself |

Numbers must be JSON numbers; `NaN` / `∞` are reported as the strings `"NaN"`,
`"Infinity"` and `"-Infinity"`, because JSON has no representation for them.

---

## 📦 What is in this folder

| Language | File | How the extension uses it |
| --- | --- | --- |
| .NET (C# / F#) | [`dotnet/`](dotnet) | Builds `ExploringCollections.Helper.dll` (netstandard2.0). The extension loads it with `Assembly.LoadFrom` on first use. |
| Python | [`python/exploring_collections_helper.py`](python/exploring_collections_helper.py) | Executed inside the debuggee, then called as `__ec_ns['__ec_dump'](expr)`. |
| JavaScript / TypeScript | *(built in)* | No file needed: the extension injects a self contained serializer. |
| Go | [`go/exploring_collections.go`](go/exploring_collections.go) | Optional: import the package and call `exploringcollections.Dump(x)`. |
| Rust | [`rust/exploring_collections.rs`](rust/exploring_collections.rs) | Optional: add the module and call `exploring_collections::dump_json(&x)`. |
| C / C++ | [`cc/exploring_collections.h`](cc/exploring_collections.h) | Optional: compile it in and call `exploring_collections::dump_json_cstr(x)` (C++) or the C API. |

Every helper states its own version, and all of them follow the extension release:
the assembly version in `dotnet/`, `__version__` in Python, `Version` in Go,
`VERSION` in Rust (mirrored by `version` in `Cargo.toml`), and
`EXPLORING_COLLECTIONS_VERSION` in the C/C++ header. The built in
JavaScript/TypeScript serializer ships inside the extension, so it has no
declaration of its own, and the `__ec` envelope revision is a protocol version
that stays independent of the release version. The `helper versions` test keeps
the declarations in step with `package.json`.

### .NET (C# and F#)

```text
helpers/dotnet/dist/ExploringCollections.Helper.dll
```

One assembly serves both languages: a C# and an F# debug session are handed the
same build, because both run on the same debug adapters. That is why the helper is
named after the runtime and not after a language.

Built from [`dotnet/CollectionHelper.cs`](dotnet/CollectionHelper.cs) for
**netstandard2.0**, so one assembly covers .NET Framework 4.6.2+, .NET Core 2+ and
all .NET 5+ versions. Beyond plain collections it understands `DataTable`,
`DataView` and `DataSet` (which have no useful LINQ surface, so a helper assembly is
what makes them explorable), plus F# records, options, lists, maps and
discriminated unions (`{ "Case": "Warm", "Item": 21 }`).

```bash
dotnet build helpers/dotnet/ExploringCollections.Helper.csproj -c Release
dotnet run --project helpers/dotnet/tests/HelperTests.csproj -c Release   # 55 checks
```

### Python

The module is read from disk, executed inside the debuggee and stored under a
single global name (`__ec_ns`), so the debuggee's namespace stays clean:

```python
__import__('builtins').exec(<module source>, globals().setdefault('__ec_ns', {})) \
    or __ec_ns['__ec_dump'](<expression>)
```

It handles dataclasses, `NamedTuple`, `__slots__`, enums, `datetime`, `Decimal`,
`bytes`, sets, `deque` and anything exposing `tolist()` (numpy, pandas).

```bash
python3 helpers/python/test_helper.py
```

### Go

Add the package to your module and call it from the Debug Console:

```go
import "your/module/exploringcollections"

// in the Debug Console while stopped:
//   exploringcollections.Dump(temperatures)
```

Delve only evaluates such a call when it is started with call support
(`--allow-non-terminal-interactive=true`); otherwise the extension uses the
variables walk, which needs no changes to your program.

```bash
cd helpers/go && go test ./...
```

### Rust

Copy the module into your crate and call it:

```rust
mod exploring_collections;

// in the Debug Console while stopped:
//   exploring_collections::dump_json(&temperatures)
```

The helper reformats the `Debug` representation of the value, which means **no
derive attributes and no dependencies** are required for any type that already
implements `Debug`. Two consequences are worth knowing:

* Types that do not implement `Debug` cannot be reported by the helper.
* A self referencing value would recurse inside `format!` before the helper sees
  it, so such values should be explored with the variables walk instead.

```bash
cd helpers/rust && cargo test
```

### C and C++

```cpp
#include "exploring_collections.h"

struct Temperature { std::string city; int degree; };
EC_OBJECT(Temperature, city, degree)   // opts the type in

// in the Debug Console while stopped:
//   exploring_collections::dump_json_cstr(temperatures)
```

`std::vector`, `list`, `deque`, `set`, `unordered_set`, `array`, `map`,
`unordered_map`, `pair`, `tuple`, `optional`, smart pointers and C arrays are
supported out of the box. A struct without `EC_OBJECT` is reported as a single
string cell when it can be streamed with `operator<<`.

C uses a descriptor based API, because C has no way to describe a field layout at
runtime:

```c
const ec_field_descriptor fields[] = {
    {"city", offsetof(temperature_t, city), EC_FIELD_STRING},
    {"degree", offsetof(temperature_t, degree), EC_FIELD_INT},
};
// in the Debug Console while stopped:
//   exploring_collections_dump_structs(temperatures, 2, sizeof(temperature_t), fields, 2)
```

Every entry point returns a buffer that **stays valid until the next call**, so
debugger expressions never leak memory.

```bash
bash helpers/cc/build_and_test.sh
```

---

## ✅ Verifying everything at once

```bash
npm run test:helpers
```

Runs the .NET, Python, Go, Rust and C/C++ helper checks. Some of them need a
matching toolchain (`dotnet`, `python3`, `go`, `cargo`, `g++`); missing tools are
reported and skipped rather than failing the run.
