# 📋 Changelog

All notable changes to **Exploring Collections** are documented in this file.

Формат основан на [Keep a Changelog](https://keepachangelog.com/), версии — на [Semantic Versioning](https://semver.org/).
The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

---

## 🚧 Unreleased

### 🐞 Fixed / Исправлено

- **📥 Окно переменных больше не обрезается первой страницей.** Перечисление коллекции через `variables` идёт страницами до `maxRows`, поэтому адаптер со своим размером страницы (или тот, что игнорирует `count`) отдаёт всё окно, а не первые 25 элементов; если адаптер повторяет одну и ту же страницу (игнорирует `start`), обход останавливается и сообщает об этом вместо бесконечного цикла. · **The variable window is no longer cut to the first page.** The `variables` enumeration now walks pages up to `maxRows`, so an adapter with a page size of its own (or one that ignores `count`) hands over the whole window instead of the first 25 elements; when an adapter repeats the same page (it ignores `start`) the walk stops and says so instead of looping forever.
- **🔢 Размер коллекции берётся из предпросмотра, когда счётчиков нет.** `vsdbg` не сообщает `indexedVariables` для `List<T>` — размер виден только в тексте предпросмотра (`Count = 50000`). Теперь это число используется как объявленный размер, поэтому окно, обрезанное адаптером, видно и догружается, а не молча остаётся на 25 строках. · **The size comes from the preview text when the adapter reports no counters.** `vsdbg` reports no `indexedVariables` for a `List<T>`: the size only shows up in the preview (`Count = 50000`). That number is now used as the declared size, so a window the adapter cut is both visible and paged through instead of silently staying at 25 rows.
- **⏱ Захват больше не может «зависнуть».** Новый бюджет `exploringCollections.captureBudgetMs` (30 с по умолчанию) ограничивает чтение коллекции из отладчика: и обход дерева переменных (запрос на элемент — 10 000 строк читались минутами), и страницы через вычислитель. Прочитанное к этому моменту показывается как усечённое окно с предупреждением, а в уведомлении идёт прогресс «1 234 из 10 000 строк». · **A capture can no longer hang.** The new `exploringCollections.captureBudgetMs` budget (30 s by default) bounds reading a collection from the debugger: both the variables walk (one request per element, so 10 000 rows used to take minutes) and evaluator pages. What was read by then is shown as a truncated window with a warning, and the notification reports progress (“1 234 of 10 000 rows”).
- **✂️ Обрезанный адаптером ответ больше не принимается за маленькую коллекцию.** Адаптер (например js-debug) обрезает длинные результаты `evaluate` посередине, вставляя `…`, и такой текст всё ещё разбирается как JSON — с искажёнными полями и пропавшими строками. Теперь такая страница распознаётся и перезапрашивается меньшего размера, а размер страницы сходится к тому, что адаптер отдаёт целиком. · **A response the adapter cut is no longer mistaken for a small collection.** Adapters such as js-debug elide long `evaluate` results in the middle with `…`, and that text still parses as JSON — with mangled members and missing rows. Such a page is now recognised and re-requested smaller, and the page size converges to what the adapter delivers intact.
- **📄 Большие коллекции читаются страницами через вычислитель выражений.** Если адаптер объявляет большое окно, страницы читаются сразу (одна JSON-страница на запрос, стратегия `expression-subrange`), а если адаптер отдал меньше, чем объявил, недостающее догружается так же — выражением диапазона провайдера (`Skip`/`Take`, `slice`, `islice`). Слишком длинный обрезанный ответ адаптера означает повтор страницы меньшего размера. · **Large collections are read in evaluator pages.** When an adapter declares a big window the pages are read straight away — one JSON page per request, retrieval strategy `expression-subrange` — and when it hands over less than it declared the rest is fetched the same way, with the provider's range expression (`Skip`/`Take`, `slice`, `islice`). A page the adapter cut is retried with a smaller size.
- **🔎 Обрезанное окно теперь видно.** `Truncated` больше не зависит только от `maxRows`: если адаптер отдал меньше, чем объявил, в статус-баре появляется `Truncated: N total`, а в предупреждениях — строка «The debug adapter returned only the first 25 of 5,000 children». · **A cut window is now visible.** `Truncated` no longer depends on `maxRows` alone: when the adapter hands over less than it declared, the status bar shows `Truncated: N total` and the warnings name the numbers.
- **🐞 Сериализатор JavaScript был синтаксически сломан.** Список операторов соединяется через `;`, а между `if (…) { … }` и `else if` точка с запятой превращала выражение в синтаксическую ошибку в отлаживаемом процессе (`Uncaught SyntaxError: Unexpected token 'else'`). Из-за этого быстрый путь JavaScript/TypeScript никогда не срабатывал, и коллекции читались обходом: 20 000 элементов — 169 секунд. Теперь цепочка — один оператор, и быстрый путь работает. · **The JavaScript serializer was syntactically broken.** The statement list is joined with `;`, so a semicolon between `if (…) { … }` and `else if` made the expression a syntax error in the debuggee (`Uncaught SyntaxError: Unexpected token 'else'`). The JavaScript/TypeScript fast path therefore never ran and collections were read by walking them: 20 000 elements took 169 seconds. The chain is a single statement now and the fast path works.
- **🧠 Фильтр и диапазоны для C#/F# возвращаются как JSON.** Проталкиваемое условие отдавало `List<T>`, а читатель полезной нагрузки ждёт JSON, поэтому фильтр по всей коллекции для C#/F# не мог разобрать ответ. Теперь и условие, и страница диапазона сериализуются (`JsonSerializer.Serialize`). · **C#/F# filters and ranges travel as JSON.** A pushed down condition returned a `List<T>` while the payload reader expects JSON, so the whole collection filter could not parse the answer for C#/F#. Both the condition and a range page are serialized now (`JsonSerializer.Serialize`).

### 🗑 Removed / Удалено

- **⌨️ Ручной ввод условия `WHERE x => …`.** Команда `Exploring Collections: Set Filter…` с полем ввода убрана: условия собираются кнопкой **Фильтр по всей коллекции** рядом с поиском, а `WHERE`-префикс при разборе сохранённых условий по-прежнему понимается. · **The hand typed `WHERE x => …` condition.** The `Exploring Collections: Set Filter…` command with its input box is gone: conditions are built with the **Filter the whole collection** button next to the search, and the `WHERE` prefix is still understood when stored conditions are read back.

### 🔧 Changed / Изменено

- **🖥 Кнопка «на всю ширину» больше не дублируется.** У развёрнутой группы VS Code рисует свою кнопку сворачивания в той же группе `navigation`, поэтому наша прячется по тому же контексту, которым пользуется сам VS Code (`!editorPartMaximizedEditorGroup`); свернуть группу остаётся системной кнопкой. · **The “full width” button is no longer duplicated.** For a maximized group VS Code draws its own unmaximize button in the same `navigation` group, so ours hides on the same context key VS Code itself uses (`!editorPartMaximizedEditorGroup`); the built-in button still restores the group.
- **🎯 Локальные фильтры всегда доступны.** Кнопка «Local filter» убрана: воронка есть в каждом заголовке колонки сразу, а снять все условия можно ссылкой «Clear all filters» в панели над таблицей. · **Local filters are always available.** The “Local filter” toolbar button is gone: the funnel sits in every column header from the start, and `Clear all filters` above the grid still removes every condition at once.

---

## 🚀 [1.0.0] — 2026-10-16

### ✨ Added / Добавлено

- **🧪 Просмотр данных из кода** — данные, прописанные прямо в исходнике, открываются без запуска отладки: CodeLens `Просмотр данных` над литералом коллекции, команда `Exploring Collections: Preview Collection Data from Source` и пункт контекстного меню редактора. Разбор понимает литералы C#, F#, JavaScript/TypeScript, Python, Go, Rust, C/C++ и JSON; после правки `Ctrl+Alt+R` перечитывает данные. · **Design time data preview** — data hardcoded in the source can be opened without a debug session: a `Preview data` CodeLens above the literal, the `Preview Collection Data from Source` command and an editor context menu entry. C#, F#, JavaScript/TypeScript, Python, Go, Rust, C/C++ and JSON literals are parsed; `Ctrl+Alt+R` re-reads the literal after an edit.
- **🧠 Конструктор фильтра по всей коллекции** — кнопка рядом с поиском собирает условие `WHERE x => …` по колонкам (содержит, не содержит, равно, не равно, начинается с, заканчивается на, регулярка, больше/меньше/в диапазоне, null/пусто/истина/ложь) с живым предпросмотром, разбором существующего условия и проталкиванием в отлаживаемый процесс для C#/F#/JS/Python. · **Whole collection filter builder** — a button next to the search builds `WHERE x => …` conditions per column (contains, does not contain, equals, is not, starts with, ends with, regex, greater/less/between, null/empty/true/false) with a live preview, parsing of existing conditions and pushdown into the debuggee for C#/F#/JS/Python.
- **🖥 Кнопка «на всю ширину» в заголовке редактора** — слева от *Split Editor Right*, как и просили, вместо кнопки внутри панели. · **Full width button in the editor title bar** — left of *Split Editor Right*, instead of a button inside the panel.
- **🧾 Раздел «Explore code lens» в диагностике** — строка каждой ссылки, причина выбора, состояние `editor.codeLens` и обеих настроек: сразу видно, почему ссылки нет. · **“Explore code lens” section in the diagnostics report** — the line of every lens, why it was chosen there, the state of `editor.codeLens` and of both settings.
- **📄 Страницы: пункт «All (N)»** — таблица может показать сразу все строки. · **Pager: an “All (N)” entry** — the grid can show every row at once.

### 🔧 Changed / Изменено

- **🔍 Расположение CodeLens** — ссылка ставится над строкой, где коллекция появилась; если идентификатора нет в этом файле (поле, параметр, сгенерированный член), используются другие варианты написания (`this._items`, `response.Body.Items`), а в крайнем случае — строка объемлющего объявления, а не точка останова. · **CodeLens placement** — the lens sits above the line that introduced the collection; when the identifier is not part of the stopped file (a field, a parameter, a generated member) other spellings are tried (`this._items`, `response.Body.Items`) and the enclosing declaration is used as a last resort instead of the breakpoint.
- **🧭 Раскладка** — панель деталей скрывается целиком, высота таблицы меняется разделителем, ширина деталей — вторым разделителем. · **Layout** — the detail pane can be hidden completely, the table height is changed with a splitter and the detail width with a second one.
- **🌳 Панель деталей строки** — имена, типы и значения выровнены по колонкам, направляющие для вложенности, подсветка выбранной ячейки, кнопки копирования при наведении. · **Row detail pane** — names, types and values aligned in columns, indent guides, highlight of the clicked cell, hover copy buttons.

### 🐞 Fixed / Исправлено

- **↔️ Include/Exclude в локальном фильтре** — переключатель снова работает как взаимоисключающий (общей группы у радиокнопок не было, поэтому второе нажатие ничего не снимало). · **Include/Exclude in the local filter** — the switch is exclusive again (the radios had no shared group, so a second click could not undo the first).
- **📄 Выбор количества строк** — селектор внизу больше не «залипает» на старом значении. · **Row count selector** — the selector at the bottom no longer keeps the previous value.
- **📊 Список колонок в графиках** — вместо громоздкого списка остался один выпадающий список. · **Chart column picker** — the bulky list box is gone, the dropdown remains.

---

## 🚀 [0.1.1] — 2026-10-15

### ✨ Added / Добавлено

- **🔍 CodeLens «Explore collection»** — над каждой коллекцией, доступной в текущем кадре на точке останова, прямо в остановленном файле: имя, количество элементов, один клик до просмотрщика. Обновляется на каждом шаге и при смене кадра. · **`Explore collection` CodeLens** above every collection that is in scope at the breakpoint, in the stopped file itself: name, element count, one click to the viewer. Refreshes on every step and frame change.
- **💬 Ссылка Explore во всплывающей подсказке** — наведение на переменную-коллекцию добавляет собственный блок подсказки со ссылкой `Explore collection` (команда разрешена через `isTrusted` только для этой команды). · **Explore link in the tooltip** — hovering a collection variable adds our own hover section with an `Explore collection` command link, scoped with `isTrusted` to that single command.
- **🧭 Коллекции в дереве** — узел сессии отладки раскрывается в список коллекций кадра (имя, количество элементов, тип) с командой Explore; раньше там был только список сессий. · **Collections in the activity bar tree** — a debug session node now expands into the collections of its frame (name, element count, type) with an Explore command, instead of listing sessions only.
- **⚙️ Новые настройки** `exploringCollections.showCodeLens` и `exploringCollections.showHoverLinks`. · **New settings** `showCodeLens` and `showHoverLinks`.

### 🐛 Fixed / Исправлено

- **Просмотрщик больше не остаётся на экране загрузки.** Заглушка «Loading collection…» очищала корневой элемент webview и уносила за собой всю построенную обвязку (панель инструментов, строку фильтра, таблицу, панель значения, уведомления), поэтому данные, приходившие от хоста, рендерились в отсоединённые узлы и пользователь видел только спиннер. Заглушка теперь живёт внутри области таблицы и снимается при первом снимке. · **The viewer no longer stays on the loading screen.** The boot placeholder cleared the webview root, taking the whole scaffold (toolbar, filter bar, grid host, value pane, toast layer) with it, so everything the host sent was rendered into detached nodes and the user only ever saw the spinner. The placeholder now lives inside the grid host and is removed by the first snapshot.
- Текст заглушки локализован (английский/русский) вместо жёстко зашитой строки. · The placeholder text is localized instead of hard coded.
- **Файл остановки теперь определяется всегда.** `DebugStackFrame` в VS Code не сообщает ни файл, ни строку кадра, поэтому источник кадра запрашивается у адаптера (`stackTrace`) и кэшируется. Без этого CodeLens и hover не находили остановленный файл, и подсказки не показывались. · **The stopped file is now always resolved.** VS Code's `DebugStackFrame` exposes neither the file nor the line, so the frame source is requested from the adapter (`stackTrace`) and cached. Without it the CodeLens and the hover never matched the stopped file and showed nothing.
- **Распознавание коллекций больше не зависит от счётчиков адаптера.** Некоторые адаптеры (например js-debug) не присылают `indexedVariables`/`namedVariables`, а описывают значение как `(12) [{…}]`. Теперь коллекция определяется и по такому описанию, поэтому JavaScript/TypeScript получили полноценные CodeLens, hover и список в дереве. · **Collection detection no longer depends on adapter counters.** Adapters such as js-debug describe the value (`(12) [{…}]`) instead of reporting `indexedVariables`/`namedVariables`; the detection now understands both shapes, which is what brought the CodeLens, hover and tree entries to JavaScript/TypeScript.
- Ссылка CodeLens ставится на строку, где коллекция появилась, поэтому несколько коллекций из одного выражения больше не собираются в одну строку. · The CodeLens is anchored on the line that introduced the collection, so several collections read by one statement no longer stack on a single line.

### 🔧 Changed / Изменено

- **Ссылка Explore ставится над объявлением коллекции.** Определяется строка, где коллекция объявлена или присвоена (`var x = …`, `x := …`, `let x: T = …`, параметр метода), и только если такой строки в файле нет — первое упоминание или строка останова. · **The Explore link is anchored on the declaration.** The line that declares or assigns the collection (`var x = …`, `x := …`, `let x: T = …`, a method parameter) is preferred; a plain mention or the breakpoint line is only used when the file has no declaration.
- **Компактные фильтры колонок.** Поле значения и переключатель регулярного выражения стоят в одной строке, поля и отступы уменьшены, само окно фильтра уже (248 px вместо 300 px). · **Compact column filters.** The value box and the regular expression switch share one row, paddings and font size are smaller, and the popover is narrower (248 px instead of 300 px).
- **Один выпадающий список для оси Y.** Многострочный список столбцов убран: несколько серий получаются выбором колонки группировки. · **A single dropdown for the Y axis.** The multi-line column list box is gone; several series come from the group column instead.
- Скриншоты README перерисованы (`npm run preview`), добавлен вид локального фильтра. · README screenshots re-rendered (`npm run preview`) and a local filter view added.

- **Раскладка просмотрщика подстраивается.** Панель деталей скрывается кнопкой (или крестиком в её заголовке), таблицу можно свернуть кнопкой, а разделители меняют высоту графика и ширину панели деталей; кнопка в правом верхнем углу разворачивает вкладку на всю ширину редактора. · **The viewer layout is yours.** The detail pane hides with a toolbar button or its own close button, the table collapses with one click, two splitters resize the chart and the detail pane, and a button in the top right expands the tab to the full editor width.
- **Панель деталей строки перерисована.** Имя, тип и значение выровнены по колонкам, вложенность показана направляющими, выбранная ячейка подсвечивается, у каждого значения есть кнопка копирования при наведении, в заголовке — метка строки, тип, счётчик полей и действия. · **The row detail pane was redesigned.** Name, type and value are aligned in columns, nesting gets guide lines, the clicked cell is highlighted, every value has a hover copy button, and the header shows the row label, its type, a field count and the actions.
- **Строка LINQ-фильтра убрана из просмотрщика.** Сверху остались только поиск и чипы (активный фильтр, скрытые колонки, сброс локальных фильтров). Само условие вводится командой `Exploring Collections: Set Filter…` из палитры, с проталкиванием в отладчик как раньше. · **The LINQ bar is gone from the viewer.** Only the search box and compact chips (active filter, hidden columns, clear local filters) remain. The condition itself is typed through `Exploring Collections: Set Filter…` from the Command Palette, with the same debugger side pushdown as before.

### 🧪 Tests / Тесты

- Новый набор `test/webviewBoot.test.ts` загружает **реальный собранный webview** в DOM: проверяет рукопожатие `ready`, отрисовку строк, фильтр, уведомления и отсутствие вечного спиннера. Именно он поймал описанный выше баг. · New `test/webviewBoot.test.ts` suite boots the **real webview bundle** in a DOM and asserts the `ready` handshake, row rendering, filtering, toasts and the absence of a stuck spinner — it is what caught the bug above.
- Набор `test/frameFeatures.test.ts` покрывает CodeLens, размещение ссылки по строкам, hover-ссылки и кэш поиска коллекций. · `test/frameFeatures.test.ts` covers the CodeLens, line placement, hover links and the collection lookup cache.
- **Интеграционный набор в настоящем VS Code** (`npm run test:integration`): запускает реальную сессию отладки Node, проверяет CodeLens в редакторе, ссылку в подсказке, открытие панели по клику, захват коллекции из контекстного меню и команды снимка — 9 проверок. · **Integration suite inside a real VS Code** (`npm run test:integration`) starts a real Node debug session and checks the CodeLens, the hover link, opening the panel by clicking it, capturing from the context menu and the snapshot commands — 9 checks.
- `npm run preview` рендерит настоящий webview в PNG через безголовый Chromium: эти изображения попали в README (таблица, детали строки, локальный фильтр, график). · `npm run preview` renders the real webview to PNG with headless Chromium; those images are the README screenshots (table, row details, local filter, chart).
- Тесты геометрии раскладки: границы высоты графика и ширины панели деталей, включая вырожденные и NaN значения. · Layout geometry tests: the bounds of the chart height and the detail pane width, including degenerate and NaN values.

---

## 🚀 [0.1.0] — 2026-10-15

Первая публичная версия. · First public release.

### ✨ Added / Добавлено

- **🔍 Collection view for the VS Code debugger** — открывайте любую коллекцию как таблицу данных из контекстного меню `Variables`, `Watch`, `Call Stack`, палитры команд, горячей клавиши `Ctrl+Alt+E` или дерева снимков на панели активности. · Open any collection as a data grid from the `Variables`/`Watch`/`Call Stack` context menus, the Command Palette, the `Ctrl+Alt+E` keybinding, or the snapshot tree in the activity bar.
- **🌍 Девять языков** — C#, F#, JavaScript, TypeScript, Python, Go, Rust, C++ и C через гибридную схему получения данных: нативный помощник → вызов сериализатора → универсальный обход переменных по DAP. · **Nine languages** — C#, F#, JavaScript, TypeScript, Python, Go, Rust, C++ and C through a hybrid retrieval architecture: native helper → serializer expression → universal DAP variables walk.
- **📊 Полноценная работа с таблицей** — сортировка по типу колонки, глобальный поиск, локальные фильтры по колонкам (значения из списка, `include`/`exclude`, регулярные выражения), перетаскивание и скрытие колонок, постраничный вывод. · **Full table workflow** — kind-aware sorting, global search, per-column local filters (value list, `include`/`exclude`, regex), column drag and drop, column hiding, pagination.
- **🧠 Строка фильтра в стиле LINQ** — `WHERE x => x.DegreeCelsius > 20 && x.Feels == "warm"`. Единый синтаксис с диалектами для каждого языка, свободные идентификаторы вычисляются в текущем кадре (`x => x.Price > budget * 1.2`). · **LINQ style filter bar** — one syntax with per-language dialects, free identifiers resolved in the current frame.
- **⬆️ Проталкивание фильтра** — для C#, F#, JavaScript/TypeScript и Python фильтр транслируется в `.Where` / `Seq.filter` / `Array.filter` / списковое включение и выполняется внутри отлаживаемого процесса, когда коллекция больше загруженного окна и перевод точен. · **Filter pushdown** for C#, F#, JavaScript/TypeScript and Python when the collection is larger than the fetched window and the translation is exact.
- **📈 Девять типов графиков** — Bar, Pie, Area, Line, Scatter, Bubble, Stock, AreaRange, Histogram с настройкой осей, группировки, размера, агрегаций (`mean`, `sum`, `min`, `max`, `count`, `first`, `last`) и экспортом в PNG. · **Nine chart types** with axis/group/size settings, aggregations and PNG export.
- **💾 Экспорт в CSV, JSON, Excel и XML** — ровно того вида, который вы видите: CSV с BOM по RFC 4180, типизированный JSON с метаданными, настоящий `.xlsx` (собственный писатель ZIP/OOXML, без зависимостей) и XML. Плюс копирование в буфер как TSV. · **Export to CSV, JSON, Excel and XML** of the exact view you see, plus TSV clipboard copy.
- **🌳 Панель значения** — клик по `#` открывает весь элемент, клик по ячейке — только её поле; вложенные значения подгружаются из отладчика лениво. · **Value pane** — `#` shows the whole element, a cell shows only that member, nested members load lazily from the debugger.
- **🧰 Библиотеки-помощники для каждого языка** — `ExploringCollections.Helper.dll` (netstandard2.0, ADO.NET `DataTable`/`DataView`/`DataSet`, F# option/union), Python-помощник, встроенный JS/TS-сериализатор, пакеты для Go и Rust, заголовок для C/C++. · **Per-language helper libraries** with a shared envelope contract.
- **📌 Снимки** — закрепление, повторное открытие и удаление; снимок остаётся доступным после завершения сессии отладки. · **Snapshots** — pin, reopen and remove; a snapshot survives the end of the debug session.
- **💡 Подсказки в строке** — `🔍 temperatures (14) · explore with Ctrl+Alt+E` на остановленной строке. · **Inline hints** on the stopped line.
- **🌐 Локализация** — английский как основной и русский как дополнительный язык, и для манифеста, и для строк времени выполнения (138 строк). · **Localization** — English primary, Russian secondary, for both the manifest and runtime strings (138 strings).
- **🧾 Диагностика** — использованная стратегия, число запросов к адаптеру, причины отказа быстрых путей и заметки по провайдерам. · **Diagnostics** — strategy used, adapter request count, fast path fallback reasons and provider notes.
- **⚙️ 17 настроек** для строк, глубины, таймаутов, порядка колонок, форматов даты и экспорта, пользовательских типов отладки и исключаемых членов. · **17 settings** covering rows, depth, timeouts, column order, date and export formats, custom debug types and excluded members.

### 📝 Notes / Примечания

- **Ограничение API VS Code:** расширение не может добавить ссылку `Explore` во всплывающую подсказку отладчика — такой точки расширения в VS Code нет. Используйте контекстные меню, `Ctrl+Alt+E`, подсказку в строке или дерево снимков. · **VS Code API limitation:** an extension cannot add an `Explore` link to the debug hover because no such extension point exists. Use the context menus, `Ctrl+Alt+E`, the inline hint or the snapshot tree instead.
- Требуется VS Code 1.105 или новее. · Requires VS Code 1.105 or newer.
- Все помощники необязательны: обход переменных работает всегда. · Every helper is optional; the variables walk always works.

<!--
Шаблон для следующих версий / Template for the next releases:

## 🎉 [X.Y.Z] — ГГГГ-ММ-ДД

### ✨ Added / Добавлено
### 🔧 Changed / Изменено
### 🐛 Fixed / Исправлено
### ⚠️ Deprecated / Устарело
### 🔥 Removed / Удалено
### 🔒 Security / Безопасность
-->
