# 🤝 Contributing to Exploring Collections

Спасибо за интерес! Ниже — как быстро поднять проект, что мы ждём от изменений и как добавить новый язык. · Thanks for your interest! Below is how to get the project running, what we expect from a change, and how to add a new language.

---

## 📐 Ground rules

- **English is the primary language** for code, comments, commit messages and issues. Russian is welcome in issues; user-visible strings must ship in **both** English and Russian.
- **No runtime dependencies.** The extension ships with zero `dependencies` on purpose — the ZIP/XLSX writer, the SVG charts, the expression parser and the webview UI are all in this repository. Please do not add one without an explicit discussion in an issue.
- **Keep the webview under a strict CSP.** No `eval`, no inline scripts, no remote resources, no frameworks.
- **Small, focused commits.** One logical change per commit, with a message that explains *why*.
- **Tests come with the change.** Bug fixes get a regression test; new behaviour gets a test. Every helper language has its own suite.

---

## 🛠️ Setting up

```bash
git clone <your fork>
cd exploring-collections-vscode
npm install
npm run build          # esbuild: dist/extension.js, dist/webview.js, test bundles
npm run check          # TypeScript 7, strict, no unused locals/parameters
```

Press `F5` in VS Code to launch the Extension Development Host, open any project in a supported language, start debugging and right-click a collection.

### 🧪 Tests

```bash
npm test                 # unit tests + all language helper suites
npm run test:unit        # node:test over the bundled TypeScript tests
npm run test:helpers     # helper suites; toolchains you don't have are skipped
npm run test:integration # the extension inside a real VS Code window
```

`test:integration` launches the installed VS Code with a throwaway profile
(`--user-data-dir` in a temp folder, so your own profile is never touched), starts a
real Node debug session on `main.js`, and asserts the CodeLens, the hover link, the
capture pipeline and the panel. Set `VSCODE_EXECUTABLE_PATH` when VS Code lives
somewhere unusual. `npm run preview` renders the viewer into `media/screenshot-*.png`
with a headless Chromium, ready to be used as README screenshots.

Unit tests run against the **bundled** output, so always `npm run build:tests` (or `npm test`) after editing sources.

Helper suites and what they need:

| Suite | Command | Requirement |
| --- | --- | --- |
| .NET (C# / F#) | `dotnet run --project helpers/dotnet/tests/HelperTests.csproj -c Release` | .NET 10 SDK |
| Python | `python3 helpers/python/test_helper.py` | Python 3.8+ |
| Go | `go test ./...` (in `helpers/go`) | Go 1.21+ |
| Rust | `cargo test --offline` (in `helpers/rust`) | Cargo |
| C / C++ | `bash helpers/cc/build_and_test.sh` | `g++`/`gcc` with C++17 |

> Tip: point `GOCACHE` and `CARGO_TARGET_DIR` somewhere outside the repository to keep the working tree clean.

### 🌐 Translations

```bash
npm run l10n               # regenerate l10n/bundle.l10n.json and list missing translations
npm run l10n -- --check    # exit 1 when a translated string is missing (used by CI)
```

English source strings are the keys. Add your language by copying `l10n/bundle.l10n.ru.json` to `l10n/bundle.l10n.<tag>.json`, translating the values, and adding `package.nls.<tag>.json`. Russian translations are hand written in [`scripts/l10n.ru.json`](./scripts/l10n.ru.json).

### 🎨 Icon

```bash
npm run icon     # re-renders resources/icon*.png and resources/icon.svg
```

The icon is defined as vector shapes in [`scripts/generate-icon.py`](./scripts/generate-icon.py) and needs `Pillow`.

---

## 🌍 Adding a language provider

A provider is the only thing a new language needs. Create `src/providers/<language>Provider.ts`:

1. Extend `AbstractLanguageProvider` and set `id`, `language`, `displayName`, `debugTypes`, `editorLanguages` and `notes`.
2. Override only what the language supports:
   - `buildSerializeExpression` — the expression that serializes the collection to the envelope (fast path).
   - `parseSerializedPayload` — parse that payload, or the default JSON parser.
   - `buildNativeHelperExpression` / `buildHelperLoadExpression` — if you ship a helper.
   - `buildFilterExpression` — AST → native filter, and mark it `exact` **only** when the translation is faithful.
   - `buildMemberExpression` — how the value pane reaches a nested member.
3. Register it in `src/providers/index.ts` and add a `languages` entry where needed.
4. Add cases to `test/providers.test.ts` and, ideally, a capture test in `test/capturer.test.ts`.

Rules:

- **Never fake exactness.** If a construct cannot be translated one-to-one, return `exact: false` with a note; the extension will filter locally and tell the user.
- **Never build code by rewriting text.** Use the AST (`src/filter/emit.ts` + a dialect) so string literals stay intact.
- **Always keep the variables walk working.** The fast path is an optimisation, not a requirement.

---

## 🐛 Reporting a bug

Please include:

- the language and debug adapter (`debugType`), plus the version of the debugger;
- the variable's type and a **minimal** repro;
- the output of `Exploring Collections: Show Diagnostics` — it contains the strategy used, the request count and the fallback reasons;
- the log from `Exploring Collections: Show Log`.

## 💡 Proposing a feature

Open an issue first for anything larger than a small fix. Describe the debugger workflow you want to improve, and — if it maps to a visualizer feature of another IDE — how it should behave here given VS Code's extension API limits (for example, there is no debug hover extension point).

---

## ✅ Checklist before opening a pull request

- [ ] `npm run check` passes.
- [ ] `npm test` passes.
- [ ] `npm run test:integration` passes for changes that touch the debug integration,
      the webview or the contributed UI affordances (CodeLens, hover, tree, commands).
- [ ] New user-visible strings are localized in English **and** Russian (`npm run l10n -- --check`).
- [ ] `CHANGELOG.md` mentions the change under `Unreleased`.
- [ ] Documentation touched by the change is updated (`README.md`, `README.ru.md`, `helpers/README.md`).
- [ ] No new runtime dependency.

---

## 📄 License

By contributing you agree that your work is released under the [MIT License](./LICENSE). · Отправляя изменения, вы соглашаетесь, что они распространяются под лицензией [MIT](./LICENSE).
