# 🧰 Helper libraries

For JavaScript/TypeScript the collection view works without any helper: the
extension injects a serializer in-process and falls back to walking the
debugger's variable tree (`variables` requests) when an adapter hides the
previews. For **C# and F#** the bundled .NET helper is the only capture path —
it turns a whole page into one debugger request instead of one request per
element.

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
| JavaScript / TypeScript | *(built in)* | No file needed: the extension injects a self contained serializer. |

The extension supports **JavaScript/TypeScript, C# and F#**. The helper states
its own version, which follows the extension release; the built in
JavaScript/TypeScript serializer ships inside the extension, so it has no
declaration of its own. The `helper versions` test keeps the assembly version in
step with `package.json`.

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
`DataView` and `DataSet` (which have no query surface the debugger can enumerate
cheaply, so a helper assembly is what makes them explorable), plus F# records, options, lists, maps and
discriminated unions (`{ "Case": "Warm", "Item": 21 }`).

`CollectionHelper.WriteJsonFile(value, start, count, path)` serializes one page of
a collection into a UTF-8 file and returns the number of characters written.
Adapters truncate a string returned by a method call (vsdbg cuts it at about
1,000 characters), so the extension reads the JSON from the file instead of the
evaluation result. The temporary file is removed right after it is parsed.

```bash
dotnet build helpers/dotnet/ExploringCollections.Helper.csproj -c Release
dotnet run --project helpers/dotnet/tests/HelperTests.csproj -c Release
```

---

## ✅ Verifying everything at once

```bash
npm run test:helpers
```

Runs the .NET helper checks. A missing `dotnet` toolchain is reported and skipped
rather than failing the run.
