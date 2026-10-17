<div align="center">

<img src="./resources/icon.png" alt="Exploring Collections" width="160" />

# 🔍 Exploring Collections

**A database grade collection &amp; DataTable visualizer for the VS Code debugger — for C#, F#, JavaScript, TypeScript, Python, Go, Rust, C++ and C.**

Sort it, search it, filter it with LINQ style conditions, chart it, export it — while your program sits at a breakpoint.

[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.105-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Languages](https://img.shields.io/badge/languages-9-blueviolet)](#-supported-languages)
[![Charts](https://img.shields.io/badge/charts-9-ff69b4)](#-charts)

*English · [Русский](./README.ru.md)*

</div>

---

## ✨ Why

Debuggers in other IDEs can already show a `List<T>`, a `Dictionary<K,V>` or a `DataTable` as a real data grid instead of a tree. **Exploring Collections brings that experience to Visual Studio Code — and goes further, because it is not limited to .NET.**

Stop at a breakpoint, look at your collection as a *table*, not as an endless tree of nodes.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ 🔍 temperatures        ⌂ 14 of 14 rows · C# · coreclr                     │
│ 🔎 x.DegreeCelsius > 20                               📊 Chart  💾 Export │
├────┬────┬───────────────┬──────────────────┬──────────┬───────────────────┤
│  # │ ▸  │ City          │ DegreeCelsius    │ Date     │ Feels             │
├────┼────┼───────────────┼──────────────────┼──────────┼───────────────────┤
│  2 │ ▸  │ Mexico City   │ 23               │ 2026-01-12│ warm             │
│  5 │ ▸  │ Houston       │ 26               │ 2026-01-09│ warm             │
│  8 │ ▸  │ Brisbane      │ 21               │ 2026-01-06│ warm             │
└────┴────┴───────────────┴──────────────────┴──────────┴───────────────────┘
```

---

## 🚀 Quick start

1. Install the extension from the Marketplace (or press `F5` in a clone of this repo).
2. Start a debug session in **any** supported language and stop at a breakpoint.
3. Hover the **Variables** view, **right-click a collection** → **🔍 Explore collection**.
4. Optionally, run the command **`Exploring Collections: Explore a Collection…`** from the Command Palette to pick any variable of the current frame.

| How to open it | Where |
| --- | --- |
| `🔍 Explore collection` | Right-click a variable in **Variables**, **Watch** or the **Call Stack** (`locals`) |
| `⌨️ Ctrl+Alt+E` / `⌘+Alt+E` | On any supported variable while debugging |
| `⌨️ Ctrl+Alt+Shift+E` | Command Palette picker with search over every visible variable |
| `🧭 Activity bar → Exploring Collections` | All captured snapshots, pinned or transient |
| `💡 Inline hint` | On the stopped line: `🔍 temperatures (14) · explore with Ctrl+Alt+E` |
| `🧪 Preview data` | CodeLens above a collection literal in the editor — **no debug session needed** |

> **Note** — Visual Studio Code offers no *debug hover* extension point, so unlike the visualizers built into other IDEs there is no `Explore` hyperlink in a tooltip. The CodeLens above each collection, the extra hover section, the context menus, the keybinding, the inline hint and the snapshot tree cover the same workflow inside the APIs VS Code exposes today.

### 🧪 No breakpoint? No problem

Data that is **hardcoded in the source** can be opened without debugging anything. Put the caret in a file that declares a collection literal, open the **Command Palette** → `Exploring Collections: Preview Collection Data from Source`, or simply click the `🧪 Preview data` CodeLens that appears above the literal:

```python
temperatures = [                                  # 🧪 Preview data · temperatures · 3
    {"city": "Seoul", "degrees": 21},
    {"city": "Busan", "degrees": 24},
    {"city": "Incheon", "degrees": 22},
]
```

The parser understands the literal syntax of every supported language — JavaScript/TypeScript objects and arrays, Python lists and dicts (with comments and trailing commas), C# `new List<T> { new T { … } }` and `new Dictionary<K,V> { ["k"] = v }`, Go slices and `map[string]T`, Rust `vec![Temperature { … }]`, F# record lists, C/C++ initializer lists and JSON documents. Press `Ctrl+Alt+R` to re-read the literal after editing it.

---

## 🌍 Supported languages

Nine languages, three retrieval strategies. The **universal variables walk** works with every adapter, so a collection is always explorable; the **language fast paths** make it fast and type accurate.

| Language | Adapters | Fast path | Native helper | Filter pushdown |
| --- | --- | --- | --- | --- |
| **C#** | `coreclr`, `clr`, `vsdbg`, `dotnet` | `System.Text.Json` / `Newtonsoft.Json` | ✅ `ExploringCollections.Helper.dll` (also enables ADO.NET) | ✅ LINQ (`.Where`) |
| **F#** | `coreclr`, `clr`, `vsdbg`, `dotnet` | `System.Text.Json` / `Newtonsoft.Json` | ✅ same helper, option/union aware | ✅ `Seq.filter` |
| **JavaScript / TypeScript** | `pwa-node`, `node`, `pwa-chrome`, `chrome`, `msedge`, `pwa-msedge`, `deno`, `bun` | injected in-process serializer | built in | ✅ `Array.filter` |
| **Python** | `debugpy`, `python` | `json.dumps` | ✅ `exploring_collections_helper.py` | ✅ list comprehension |
| **Go** | `go`, `delve` | `json.Marshal` | ✳️ optional package | ➖ client side |
| **Rust** | `lldb`, `rust-gdb`, `gdb`, `cppdbg`, `code-lldb` | `{:?}` parsing | ✳️ optional module | ➖ client side |
| **C++ / C** | `cppdbg`, `cppvsdbg`, `lldb`, `codelldb`, `gdb` | — | ✳️ optional header | ➖ client side |

✅ = bundled and used automatically · ✳️ = bundled, opt in by compiling it into your program · ➖ = filtered locally

Column kinds (`number`, `string`, `boolean`, `date`, `null`, `object`, …) are inferred per language, so sorting and chart axes behave correctly in all of them.

---

## 📊 What you get

| Capability | Details |
| --- | --- |
| 🧮 **Data grid** | Virtualized rows, resizable columns, drag to reorder, hide/show, pagination with a free page size box and an **All (N)** entry, row count of every pipeline stage |
| 🧭 **Layout on your terms** | Hide the whole detail pane (or drag its splitter to any width), collapse the table, drag the splitter to change the chart/table ratio, and expand the view to the full editor width with the 🖥 button **left of *Split Editor Right*** in the editor title bar (`Exploring Collections: Toggle Full Width`) |
| 🌳 **Readable row details** | The detail pane aligns names, types and values in columns, indents nested members with guide lines, highlights the cell you clicked and copies any value from a hover button |
| 🔀 **Sorting** | Click any header; numbers/dates/booleans sort by kind, text sorts naturally (`2` before `10`), empty cells always last |
| 🔤 **Global search** | Case-insensitive substring across every visible column |
| 🔍 **Explore CodeLens** | An `Explore collection` lens above **the line that introduced each collection** — not above the breakpoint — with its element count, refreshed on every stop and step. When the identifier belongs to another file (a field, a generated member) the lens moves to the enclosing declaration instead of piling up on the stop line, and **Show Diagnostics** reports the exact line and reason for every lens |
| 🧪 **Design time preview** | A `Preview data` lens above collection literals, so hardcoded data can be inspected without a debug session — see [below](#-no-breakpoint-no-problem) |
| 🎯 **Local filters** | A funnel in every column header opens a per-column popup with a compact value box, an inline `/.*/ ` switch for regular expressions, `include`/`exclude` mode and the list of known values; `Clear all filters` removes every condition at once |
| 🧠 **Whole collection filters** | The `Filter the whole collection` button next to the search builds a condition per column (contains, does not contain, equals, is not, starts with, ends with, matches the regular expression, greater/less/between, is null/empty/true/false) with a live expression preview. The condition is pushed into the debuggee for C#/F#/JS/Python, so it reaches elements outside the fetched window, and it stays visible as a removable chip |
| 🌳 **Value pane** | Click `#` for the whole element, or any cell for that member only; nested members load lazily from the debugger |
| 📈 **Charts** | 9 chart types with series settings and PNG export |
| 💾 **Export** | CSV, JSON, Excel (`.xlsx`) and XML — containing the filtered and sorted view you are looking at |
| 📌 **Snapshots** | Pin a capture to keep exploring it after the session ends; reload it with the debugger gone |
| 🌐 **Localized** | English (primary) and Russian, both the manifest (`%key%`) and the runtime strings |
| 🧾 **Diagnostics** | Which strategy was used, how many adapter requests it cost, why a fast path was skipped, which collections the frame exposes right now, plus provider specific notes |

### 🔗 Locals in your filter

The **Filter the whole collection** button next to the search collects the condition from per-column rows, pushes it into the debuggee when the translation is exact and keeps it visible as a chip with a clear button. Free identifiers that are **not** columns are resolved in the current frame, just like a query parameter:

```text
x.Day == dayOfMonth        ← dayOfMonth is a local of the stopped statement
x.Price > budget * 1.2     ← budget too
```

---

## 🧠 The filter language

One canonical syntax, adapted to every language. Leading `WHERE`, `x =>`, `(x) =>` and F# `fun x ->` are optional.

```text
x.DegreeCelsius > 20 && x.Feels == "warm"
(entry) => entry["Key"].StartsWith("A") || entry.Value > 100
fun x -> x.Age >= minAge and not (x.Country = "N/A")
WHERE len(x.Tags) in (2, 3) and like(x.Name, "S%")
```

| Group | Supported |
| --- | --- |
| Comparison | `==` `!=` `<>` `>` `>=` `<` `<=` `=` (equality, per language dialect) |
| Logic | `&&` `\|\|` `!` `and` `or` `not` |
| Membership | `in`, `not in`, `(a, b, c)` and `[a, b, c]` literals |
| Pattern | `like(text, "S%")` — also available as a method |
| Functions | `len`/`length`/`count`, `lower`/`upper`, `trim`, `abs`, `round`, `floor`, `ceil`, `sqrt`, `pow`, `min`, `max`, `sum`, `avg`, `contains`, `startswith`, `endswith`, `indexof`, `matches`, `substring`, `replace`, `concat`, null checks (`isnull`, `isempty`, `isnotnull`), casts (`int`, `float`, `string`, `bool`) and date parts (`year`, `month`, `day`, `dayofweek`, `hour`, `minute`, `second`, `now`, `today`) |
| Access | `x.City`, `x.Address.City`, `x["Key"]`, `x[0]`, `x.Items.Count` |

**Pushdown policy** — the filter is *always* evaluated locally so every language behaves identically. It is additionally pushed into the debuggee when, and only when:

1. the collection is larger than the captured window, **and**
2. the provider can translate the expression *exactly* (string literals are never rewritten textually).

If either condition fails you get a warning explaining it, and the fetched rows are filtered on the client instead.

---

## 📈 Charts

Nine chart types, `Show Chart` from the toolbar, `Series settings` in the corner:

| | | |
| --- | --- | --- |
| 📊 Bar | 🥧 Pie | 🌄 Area |
| 📈 Line | ⚬ Scatter | 🫧 Bubble |
| 🕯 Stock | ↕ AreaRange | 📶 Histogram |

Pick the **X axis**, a **Y series**, an optional **group** column (that is what turns one series into one series per group), a **bubble size** column, and an aggregation (`none`, `mean`, `sum`, `min`, `max`, `count`, `first`, `last`). Every chart can be exported to **PNG** for sharing without screenshots.

---

## 💾 Export

| Format | Extension | Notes |
| --- | --- | --- |
| CSV | `.csv` | RFC 4180 quoting, UTF-8 BOM so Excel opens it correctly, configurable delimiter/quote/line ending |
| JSON | `.json` | Typed values (`null`, numbers, booleans) plus capture metadata instead of display strings |
| Excel | `.xlsx` | A real spreadsheet with typed cells, frozen header row and auto width — written by our own ZIP/OOXML writer, no dependency |
| XML | `.xml` | One element per row, escaped and indented |

Copy to the clipboard as TSV with `Exploring Collections: Copy Rows`.

Exports contain **exactly the rows you see** — filters, search and sorting applied — and the extension tells you when a collection was truncated so a partial export is never silent.

---

## 🧰 Native helpers (optional, per language)

The bundled helpers are what make `.NET` ADO.NET collections and rich typed data work. They live in [`helpers/`](./helpers) — see [helpers/README.md](./helpers/README.md) for the full contract.

| Language | Helper | How to enable |
| --- | --- | --- |
| C# / F# | `ExploringCollections.Helper.dll` | **Automatic** — loaded into the process with `Assembly.LoadFrom` on first use (toggle with `exploringCollections.enableLanguageHelpers`) |
| Python | `exploring_collections_helper.py` | **Automatic** — executed in the debuggee, then reused |
| JavaScript / TypeScript | built in | Nothing to do |
| Go | `exploring_collections.go` | Import the package and call `exploringcollections.Dump(x)` |
| Rust | `exploring_collections.rs` | Add the module and call `exploring_collections::dump_json(&x)` |
| C / C++ | `exploring_collections.h` | Compile it in and call `exploring_collections::dump_json_cstr(x)` (C++ `EC_OBJECT` macro) or the C descriptor API |

Every helper speaks the same tiny envelope, so the extension needs one parser per language, not one per type:

```json
{ "__ec": 1, "kind": "sequence", "total": 14, "items": [ { "City": "Seoul" } ] }
```

`kind` is `sequence`, `mapping` (items are `[key, value]` pairs) or `record` (a single object). Limits, cycle detection and depth are handled inside the helper, so a cyclic graph yields a readable row rather than a hung debuggee. **No helper is ever required** — the variables walk is always there as the fallback.

---

## ⚙️ Settings

| Setting | Default | Description |
| --- | --- | --- |
| `exploringCollections.maxRows` | `10000` | Maximum number of elements to materialize per capture |
| `exploringCollections.captureBudgetMs` | `30000` | How long one capture may spend reading a collection through the debugger variables tree; what was read by then is shown as a truncated window |
| `exploringCollections.pageSize` | `100` | Rows per page in the grid |
| `exploringCollections.maxDepth` | `3` | How deep nested members are flattened into columns |
| `exploringCollections.fetchConcurrency` | `8` | Parallel debug adapter requests while walking |
| `exploringCollections.timeoutMs` | `20000` | Per request timeout |
| `exploringCollections.enableLanguageHelpers` | `true` | Use the bundled / injected per language helpers |
| `exploringCollections.enableFilterPushdown` | `true` | Push exactly translatable filters into the debuggee |
| `exploringCollections.enableCharts` | `true` | Show the chart tab |
| `exploringCollections.showInlineHints` | `true` | Inline `🔍 name (count)` hint on the stopped line |
| `exploringCollections.showCodeLens` | `true` | `Explore collection` CodeLens above every collection in scope at the breakpoint |
| `exploringCollections.showHoverLinks` | `true` | `Explore collection` link in the tooltip of collection variables in the stopped file |
| `exploringCollections.showDesignTimePreview` | `true` | `Preview data` CodeLens above collection literals, so hardcoded data can be opened without debugging |
| `exploringCollections.dateFormat` | `iso` | `iso`, `locale` or `raw` rendering of dates |
| `exploringCollections.columnOrder` | `alphabetical` | `alphabetical` or `discovery` (declaration) order |
| `exploringCollections.defaultExportFormat` | `csv` | Format pre-selected in the export dialog |
| `exploringCollections.exportDirectory` | *(workspace)* | Folder for exports |
| `exploringCollections.openExportedFile` | `true` | Open the file after exporting |
| `exploringCollections.dictionariesAsRows` | `true` | Render dictionaries as key/value rows instead of one wide row |
| `exploringCollections.customDebugTypes` | `{}` | Map extra debug type ids to a known family, e.g. `{ "my-runtime": "csharp" }` |
| `exploringCollections.excludedMembers` | `["Capacity","Count","Length","LongLength","_count","__len__"]` | Members never turned into columns |

---

## ⌨️ Commands

| Command | Keybinding | Purpose |
| --- | --- | --- |
| `Exploring Collections: Explore Collection` | `Ctrl+Alt+E` | Capture the variable under the cursor |
| `Exploring Collections: Explore Collection…` | `Ctrl+Alt+Shift+E` | Pick a variable from the frame |
| `Exploring Collections: Refresh Snapshot` | `Ctrl+Alt+R` | Re-read the same collection |
| `Exploring Collections: Preview Collection Data from Source` | | Open a collection literal without a debug session |
| `Exploring Collections: Toggle Full Width` | | Full editor width from the editor title bar |
| `Exploring Collections: Export Rows…` | | Export the current view |
| `Exploring Collections: Show Chart` | | Chart tab |
| `Exploring Collections: Copy Rows` | | Clipboard as TSV |
| `Exploring Collections: Pin Snapshot` | | Keep it after the session ends |
| `Exploring Collections: Remove Snapshot` | | Delete a stored snapshot |
| `Exploring Collections: Show Log` / `Show Diagnostics` | | Troubleshooting |

---

## ⚠️ Limitations (honest list)

- **No debug hover extension point.** VS Code does not let an extension inject a link into the debug adapter's own hover line. The CodeLens above each collection, our extra hover section, the context menus, the inline hint and the keybinding all lead to the viewer, but a *single* merged tooltip link is not reachable through the public API. *(An API gap, not a skipped feature.)*
- **Captures are bounded in time.** `exploringCollections.captureBudgetMs` (30 s) limits reading a collection from the debugger (the variables tree needs one request per element); the rows read by then are shown with a truncation warning, and the notification reports progress. Bulk paths (helper, evaluator pages) are not affected.
- **Variable windows are bounded.** With `maxRows` smaller than the collection, only part of it is materialized; the viewer says so, and filter pushdown is what lets you reach the rest. The walk now follows the adapter's pages, so a debug adapter that returns a page of its own no longer caps the window at that page — when it refuses to page at all, the status bar says how many children it did return.
- **Rust helper parses `Debug` output.** Cyclic values would recurse inside `format!` before the extension can intervene, so use `dump_json` for graph like data.
- **C needs the descriptor API.** The C++ template API can't be used from C, so `ec_field_descriptor` tables are the way for structs.
- **Python 3 only.** The helper uses f-strings and `dataclasses`.
- **Go needs Delve `call` support.** Evaluation based fast paths require a Delve version that can call into the target process; otherwise the walk is used.
- **Pushdown is limited to C#/F#/JavaScript/TypeScript/Python.** Other languages filter the captured window locally.
- **The design time preview reads source text.** Literals whose values are computed (`Load()`, `items[0]`, a variable) are shown as empty cells and counted in a warning; the preview is a convenience for data that is written out in full.

---

## 🌐 Localization

English is the primary language; Russian ships as the secondary one — for both the manifest (`package.nls.json` / `package.nls.ru.json`) and runtime strings (`l10n/bundle.l10n.json` / `l10n/bundle.l10n.ru.json`, 138 strings).

```bash
npm run l10n          # regenerate l10n/bundle.l10n.json + report missing translations
npm run l10n -- --check   # fail when a translated string is missing (CI)
```

To add a language: copy `l10n/bundle.l10n.ru.json` to `l10n/bundle.l10n.<tag>.json`, translate, and add `package.nls.<tag>.json`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## 🏗️ How it works

```text
      capture request
            │
            ▼
  ┌───────────────────────┐   no code in the debuggee needed
  │ 1. native helper      │   C#/F#, Python, ×optional Go/Rust/C/C++
  │ 2. serializer call    │   System.Text.Json, json.dumps, json.Marshal, {:?}
  │ 3. variables walk     │   universal DAP fallback — always correct
  └───────────────────────┘
            │
            ▼  language providers (syntax, kinds, filter dialects)
  ┌───────────────────────┐
  │ snapshot + rows model │   immutable, serializable, exportable
  └───────────────────────┘
            │
            ▼  strict CSP webview (no framework, no runtime dependencies)
  grid · column filters · LINQ bar · 9 charts · value pane · export
```

```text
src/            extension host: providers, DAP client, filters, exports, commands
webview/        the UI (vanilla TypeScript, self contained SVG charts)
helpers/        per language helper libraries with their own test suites
test/           unit + integration tests (node:test over the bundled output)
resources/      icon and activity bar artwork
scripts/        icon generation, l10n generation, helper test runner
```

Deliberate engineering choices: **no runtime dependencies** (own ZIP + XLSX writer, own SVG charts, own expression parser), **strict CSP** in the webview, **immutable snapshots** so a capture can be re-rendered after the session is gone, and **an AST based filter** so a condition is never rewritten by string surgery.

---

## 🛠️ Build from source

```bash
npm install
npm run build            # dist/extension.js + dist/webview.js
npm run check            # TypeScript 7 type check
npm test                 # unit tests + every language helper suite
npm run test:helpers     # helper suites only (skips toolchains you don't have)
npm run test:integration # drives the extension inside a real VS Code window
npm run preview          # renders the viewer into media/screenshot-*.png
npm run package          # produce exploring-collections-1.0.0.vsix
```

Helper build steps: `npm run package` packs the .NET helper assembly
(`helpers/dotnet/dist/ExploringCollections.Helper.dll` — one dll for both C# and F#) into the VSIX.
That assembly is tracked in git, so a fresh clone can be packaged as is; rebuild it with
`npm run build:helper:dotnet` after any change under `helpers/dotnet/`. The other helpers need no
build step — Python, Go,
Rust and C/C++ ship as sources the debuggee compiles or loads itself, and the
JavaScript/TypeScript serializer is injected by the extension. Every helper has its own suite
(`npm run test:helpers` runs them all, skipping toolchains you don't have); the per language
build, run and test commands are in [helpers/README.md](./helpers/README.md).

`npm run test:integration` launches the installed Visual Studio Code with a throwaway
profile, starts a real Node debug session on a sample program and checks the CodeLens,
the hover link, the capture pipeline and the panel — including screenshots of the DOM
through the headless preview renderer (`npm run preview`).

Requires Node.js 20+ (developed against Node 26), TypeScript 7 and, for the helper suites, whatever toolchains you have installed (`.NET 10`, Python 3, Go, Cargo, `g++`/`gcc`).

---

## 🤝 Contributing

Issues, language providers and additional export formats are welcome — please read [CONTRIBUTING.md](./CONTRIBUTING.md) first. New providers are ~100 lines: implement `LanguageProvider`, register it, add tests.

---

## 🙏 Credits

Inspired by the database-style **Collection View** debugger visualizers found in other IDEs. This project is an independent implementation for Visual Studio Code. The sample weather dataset used in the tests is recreated here for parity.

## 📄 License

[MIT](./LICENSE) © 2026 dimanrus
