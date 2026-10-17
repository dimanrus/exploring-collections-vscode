# 📋 Changelog

All notable changes to **Exploring Collections** are documented in this file. English is the primary language. The Russian translation is kept in [CHANGELOG.ru.md](./CHANGELOG.ru.md).

**Languages:** English · [Русский](./CHANGELOG.ru.md)

---

<a id="en-1-0-0"></a>
## 🚀 [1.0.0] — 2026-10-17

[🇷🇺 Читать эту версию по-русски](./CHANGELOG.ru.md#ru-1-0-0)

### ✨ Added

- **Design time data preview** — data hardcoded in the source can be opened without a debug session: a `Preview data` CodeLens above the literal, the `Preview Collection Data from Source` command and an editor context menu entry. C#, F#, JavaScript/TypeScript and JSON literals are parsed; `Ctrl+Alt+R` re-reads the literal after an edit.
- **Whole collection filter builder** — a button next to the search builds `WHERE x => …` conditions per column (contains, does not contain, equals, is not, starts with, ends with, regex, greater/less/between, null/empty/true/false) with a live preview, parsing of existing conditions and pushdown into the debuggee for C#, F# and JavaScript/TypeScript.
- **Full width button in the editor title bar** — left of *Split Editor Right*, instead of a button inside the panel.
- **“Explore code lens” section in the diagnostics report** — the line of every lens, why it was chosen there, the state of `editor.codeLens` and of both settings.
- **Pager: an “All (N)” entry** — the grid can show every row at once.
- **`Explore collection` CodeLens** — above every collection that is in scope at the current breakpoint, right in the stopped file: the name, the element count and one click to the viewer. It refreshes on every step and frame change.
- **Explore link in the tooltip** — hovering a collection variable adds its own tooltip block with an `Explore collection` link (the command is enabled through `isTrusted` for that command only).
- **Collections in the activity bar tree** — a debug session node expands into the collections of the frame (name, element count, type) with the Explore command; previously it only listed sessions.
- **New settings** `exploringCollections.showCodeLens` and `exploringCollections.showHoverLinks`.

### 🔧 Changed

- **One fast path; a fallback only for JavaScript/TypeScript.** The capture engine no longer tries a chain of independent strategies. A language provider supplies a single fast read: adapter previews for JavaScript/TypeScript, the helper file for C#/F#. The declared size is read from `Count = N` even when the adapter also reports member counters, so a `List<T>` of 1,000 elements is recognized as 1,000.
- **No more slow .NET walk.** C#/F# collections are read only through the helper: one request per page instead of one request per element, so 1,000 rows take about 300 ms instead of 27 seconds, and nothing is silently cut. When the helper cannot be loaded or cannot read its file the capture now fails with an explanatory notification instead of falling back to the walk. The `.NET` serializer expressions and the whole range/chunk machinery that only existed for that fallback are gone.
- **The variables walk stays for JavaScript/TypeScript.** It is the fallback when an adapter hides element previews, and `exploringCollections.captureBudgetMs` now applies to it alone.
- **CodeLens placement** — the lens sits above the line that introduced the collection; when the identifier is not part of the stopped file (a field, a parameter, a generated member) other spellings are tried (`this._items`, `response.Body.Items`) and the enclosing declaration is used as a last resort instead of the breakpoint.
- **Compact column filters** — the value field and the regex switch sit on one line, the paddings are smaller and the filter popup is narrower (248 px instead of 300 px).
- **A single dropdown for the Y axis** — the multiline column list is gone; multiple series are produced by choosing a grouping column.
- **The viewer layout is yours** — the detail pane can be hidden completely, the table can be collapsed with a button, and the splitters change the chart height and the detail width; the button in the top right maximizes the tab across the editor.
- **The row detail pane was redesigned** — names, types and values aligned in columns, indent guides, highlight of the clicked cell, hover copy buttons, and the row label, type, field count and actions in the header.
- **The “full width” button is no longer duplicated.** For a maximized group VS Code draws its own unmaximize button in the same `navigation` group, so ours hides on the same context key VS Code itself uses (`!editorPartMaximizedEditorGroup`); the built-in button still restores the group.
- **Local filters are always available.** The “Local filter” toolbar button is gone: the funnel sits in every column header from the start, and `Clear all filters` above the grid still removes every condition at once.
- **README screenshots are redrawn** (`npm run preview`) and now include the local filter view.

### 🗑 Removed

- **Python, Go, Rust, C and C++ support is gone.** The extension now focuses on JavaScript/TypeScript, C# and F#: the providers, their helpers (`helpers/python`, `helpers/go`, `helpers/rust`, `helpers/cc`), the Python filter dialect, literal parsing for those languages, hints and tests were removed. `customDebugTypes` still maps a custom debug type to one of the supported providers (`csharp`, `fsharp`, `javascript`).
- **The hand typed `WHERE x => …` condition.** The `Exploring Collections: Set Filter…` command with its input box is gone: conditions are built with the **Filter the whole collection** button next to the search, and the `WHERE` prefix is still understood when stored conditions are read back.

### 🐞 Fixed

- **The viewer no longer stays on the loading screen.** The `Loading collection…` placeholder cleared the webview root and took the whole built shell (toolbar, filter bar, table, value pane, toasts) with it, so the data arriving from the host rendered into detached nodes and the user only saw the spinner. The placeholder now lives inside the table area and is removed on the first snapshot.
- **The placeholder text is localized** (English/Russian) instead of a hardcoded string.
- **The stopped file is now always resolved.** `DebugStackFrame` in VS Code reports neither the file nor the line, so the frame source is requested from the adapter (`stackTrace`) and cached. Without it the CodeLens and the hover could not find the stopped file and showed nothing.
- **Collection detection no longer depends on adapter counters.** Some adapters (js-debug, for example) report no `indexedVariables`/`namedVariables` and describe the value as `(12) [{…}]`. Collections are now recognized from that description too, so JavaScript/TypeScript got full CodeLens, hover and tree support.
- **The CodeLens is anchored where the collection appears**, so several collections from one expression no longer collapse onto a single line.
- **Include/Exclude in the local filter** — the switch is exclusive again (the radios had no shared group, so a second click could not undo the first).
- **Row count selector** — the selector at the bottom no longer keeps the previous value.
- **Chart column picker** — the bulky list box is gone, the dropdown remains.
- **The variable window is no longer cut to the first page.** The `variables` enumeration now walks pages up to `maxRows`, so an adapter with a page size of its own (or one that ignores `count`) hands over the whole window instead of the first 25 elements; when an adapter repeats the same page (it ignores `start`) the walk stops and says so instead of looping forever.
- **The size comes from the preview text when the adapter reports no counters.** `vsdbg` reports no `indexedVariables` for a `List<T>`: the size only shows up in the preview (`Count = 50000`). That number is now used as the declared size, so a window the adapter cut is both visible and paged through instead of silently staying at 25 rows.
- **A capture can no longer hang.** The `exploringCollections.captureBudgetMs` budget (30 s by default) bounds the variables walk (one request per element, so 10 000 rows used to take minutes). What was read by then is shown as a truncated window with a warning, and the notification reports progress (“1 234 of 10 000 rows”).
- **Medium collections are read in one helper call.** A `List<Employee>` of 1,000 items used to be read element by element and came back cut at 962 rows; the C#/F# fast path now serializes the whole page through the helper into a temporary file and reads it from disk.
- **C#/F# filters travel as JSON.** A pushed down condition returned a `List<T>` while the payload reader expects JSON, so the whole collection filter could not parse the answer for C#/F#. The condition is serialized now (`JsonSerializer.Serialize`).
- **A failed evaluation is no longer mistaken for a value.** vsdbg answers a failed `evaluate` with a successful response that carries the exception as the value and only flags it in the presentation hint; the client now reports that as a failure, so a missing helper assembly says “helper load failed: … FileNotFoundException” instead of a confusing follow-up error.
- **A missing helper says so instead of guessing.** When the helper cannot be loaded, cannot write its file or the extension cannot read it (a remote target, for example), the capture reports the reason and stops; there is no silent walk and no half read collection.
- **The filter builder no longer shows a dead “Enter a value” box.** That grey field was the preview of the generated expression, drawn empty until a condition was complete; it now appears only when there is something to show, so the window holds no control that cannot be used.
- **A response the adapter cut is no longer mistaken for a small collection.** Adapters such as js-debug elide long `evaluate` results in the middle with `…`, and that text still parses as JSON — with mangled members and missing rows. Such a page is now recognised and re-requested smaller, and the page size converges to what the adapter delivers intact.
- **Large collections are read in bulk.** JavaScript/TypeScript rows are built from adapter previews in one or two requests; C#/F# pages are serialized by the helper into a temporary file in a single request, so the length of an `evaluate` string no longer limits the capture.
- **A cut window is now visible.** `Truncated` no longer depends on `maxRows` alone: when the adapter hands over less than it declared, the status bar shows `Truncated: N total` and the warnings name the numbers.
- **The JavaScript serializer was syntactically broken.** The statement list is joined with `;`, so a semicolon between `if (…) { … }` and `else if` made the expression a syntax error in the debuggee (`Uncaught SyntaxError: Unexpected token 'else'`). The JavaScript/TypeScript fast path therefore never ran and collections were read by walking them: 20 000 elements took 169 seconds. The chain is a single statement now and the fast path works.

### 🧪 Tests

- New `test/webviewBoot.test.ts` suite boots the **real webview bundle** in a DOM and asserts the `ready` handshake, row rendering, filtering, toasts and the absence of a stuck spinner — it is what caught the bug above.
- `test/frameFeatures.test.ts` covers the CodeLens, line placement, hover links and the collection lookup cache.
- **Integration suite inside a real VS Code** (`npm run test:integration`) starts a real Node debug session and checks the CodeLens, the hover link, opening the panel by clicking it, capturing from the context menu, the snapshot commands and a 50,000-element capture — 11 checks.
- `npm run preview` renders the real webview to PNG with headless Chromium; those images are the README screenshots (table, row details, local filter, chart).
- Layout geometry tests: the bounds of the chart height and the detail pane width, including degenerate and NaN values.

---

<!--
Template for the next releases / Шаблон для следующих версий:

## 🎉 [X.Y.Z] — YYYY-MM-DD

### ✨ Added / Добавлено
### 🔧 Changed / Изменено
### 🐞 Fixed / Исправлено
### ⚠️ Deprecated / Устарело
### 🗑 Removed / Удалено
### 🔒 Security / Безопасность
-->
