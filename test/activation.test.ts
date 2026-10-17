import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installVscodeStub, type VscodeStub } from './vscodeStub';

// The tests are bundled to CommonJS, so `__dirname` is `<repo>/out/test`.
const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string }[];
    views: Record<string, { id: string }[]>;
    configuration: { properties: Record<string, unknown> };
    keybindings: { command: string }[];
    menus: Record<string, { command?: string }[]>;
  };
};
const englishStrings = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
const russianStrings = JSON.parse(readFileSync(join(root, 'package.nls.ru.json'), 'utf8')) as Record<string, string>;

function loadExtension(): { activate: (context: unknown) => void; deactivate: () => void } {
  // The path is computed at runtime so the bundler leaves this `require` alone;
  // the extension bundle itself resolves `vscode` through the stub.
  const bundlePath = join(root, 'dist', 'extension.js');
  return require(bundlePath) as {
    activate: (context: unknown) => void;
    deactivate: () => void;
  };
}

function createContext(stub: VscodeStub, state: Map<string, unknown> = new Map()) {
  return {
    extensionUri: (stub.api.Uri as { file(path: string): unknown }).file('/extension'),
    extension: { packageJSON: { version: '0.1.0' } },
    subscriptions: [] as unknown[],
    workspaceState: {
      get: (key: string, fallback?: unknown) => state.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
      keys: () => [...state.keys()]
    },
    globalState: {
      get: (_key: string, fallback?: unknown) => fallback,
      update: async () => undefined,
      keys: () => []
    }
  };
}

describe('the activation contract', () => {
  let stub: VscodeStub;
  let extension: { activate: (context: unknown) => void; deactivate: () => void };

  before(() => {
    stub = installVscodeStub();
    extension = loadExtension();
  });

  it('activates without throwing and registers every contributed command', () => {
    const context = createContext(stub);

    assert.doesNotThrow(() => extension.activate(context));

    const missing = manifest.contributes.commands
      .map((entry) => entry.command)
      .filter((command) => !stub.registeredCommands.has(command));
    assert.deepEqual(missing, [], 'every contributed command must be registered');

    assert.equal(stub.registeredCommands.size, manifest.contributes.commands.length);
    assert.equal(context.subscriptions.length > 0, true, 'the extension must clean up after itself');
  });

  it('registers the activity bar view and the webview serializer', () => {
    const viewId = manifest.contributes.views.exploringCollections?.[0]?.id;
    assert.ok(viewId);
    assert.ok(stub.registeredTreeViews.includes(viewId), 'the snapshot tree must be registered');
    assert.ok(stub.registeredSerializers.length > 0, 'the webview serializer must be registered');
  });

  it('publishes the context keys the menus rely on', () => {
    assert.equal(stub.contextKeys.get('exploringCollections.hasSnapshot'), false);
    const debugTypes = stub.contextKeys.get('exploringCollections.supportedDebugTypes');
    assert.ok(Array.isArray(debugTypes));
    for (const debugType of ['coreclr', 'pwa-node', 'debugpy', 'go', 'lldb', 'cppdbg']) {
      assert.ok(
        (debugTypes as string[]).includes(debugType),
        `${debugType} must be advertised to the 'debugType in ...' menu condition`
      );
    }
    assert.equal(stub.contextKeys.get('exploringCollections.activeProvider'), '');
  });

  it('registers the debug time affordances in the editor', () => {
    assert.ok(
      stub.registeredCodeLensProviders.length > 0,
      'the Explore CodeLens must be registered'
    );
    assert.ok(
      stub.registeredHoverProviders.length > 0,
      'the Explore hover link must be registered'
    );
    const hoverLanguages = (
      stub.registeredHoverProviders.flatMap((entry) =>
        Array.isArray(entry) ? entry : [entry]
      ) as { language?: string }[]
    ).map((entry) => entry.language);
    for (const language of ['csharp', 'fsharp', 'python', 'go', 'rust', 'cpp', 'c']) {
      assert.ok(hoverLanguages.includes(language), `${language} must have hover links`);
    }
  });

  it('offers inline hints for the supported languages', () => {
    assert.ok(stub.registeredInlineProviders.length > 0);
    const languages = stub.registeredInlineProviders
      .flatMap((entry) => entry.languages)
      .map((entry) => (entry as { language?: string }).language);
    for (const language of ['csharp', 'fsharp', 'python', 'go', 'rust', 'cpp', 'c', 'javascript', 'typescript']) {
      assert.ok(languages.includes(language), `${language} must have inline value hints`);
    }
  });

  it('runs the diagnostics command without a debug session', async () => {
    const command = stub.registeredCommands.get('exploringCollections.showDiagnostics');
    assert.ok(command);

    await assert.doesNotReject(async () => command());
  });

  it('warns instead of failing when there is nothing to explore', async () => {
    const command = stub.registeredCommands.get('exploringCollections.explore');
    assert.ok(command);

    await assert.doesNotReject(async () => command());
    assert.ok(
      stub.messages.some((entry) => entry.level === 'warn'),
      'the user must get an explanation, not silence'
    );
  });

  it('deactivates without throwing and disposes its registrations', () => {
    assert.doesNotThrow(() => extension.deactivate());
    assert.equal(stub.registeredCommands.size, 0, 'every command must be released');
  });

  it('reports the activated version and the adapter registry in the output channel', () => {
    assert.ok(
      stub.outputLines.some((line) => line.includes('0.1.0')),
      'the log must state which version activated'
    );

    const ready = stub.outputLines.find((line) => line.startsWith('ready:'));
    assert.ok(ready, 'the log must summarise the provider registry');
    for (const debugType of ['coreclr', 'vsdbg', 'pwa-node', 'debugpy', 'lldb', 'cppdbg', 'go', 'delve']) {
      assert.ok(ready.includes(debugType), `${debugType} must be part of the registry summary`);
    }
  });
});

describe('the manifest and its translations', () => {
  const manifestRaw = readFileSync(join(root, 'package.json'), 'utf8');

  it('localizes every placeholder it references', () => {
    const keys = new Set([...manifestRaw.matchAll(/"%(.*?)%"/g)].map((match) => match[1] as string));

    assert.ok(keys.size > 0);
    const missingEnglish = [...keys].filter((key) => !(key in englishStrings));
    const missingRussian = [...keys].filter((key) => !(key in russianStrings));
    assert.deepEqual(missingEnglish, [], 'package.nls.json must define every placeholder');
    assert.deepEqual(missingRussian, [], 'package.nls.ru.json must define every placeholder');
  });

  it('translates every runtime string into Russian', () => {
    const english = JSON.parse(readFileSync(join(root, 'l10n', 'bundle.l10n.json'), 'utf8')) as Record<string, string>;
    const russian = JSON.parse(readFileSync(join(root, 'l10n', 'bundle.l10n.ru.json'), 'utf8')) as Record<string, string>;

    const missing = Object.keys(english).filter((key) => !(key in russian));
    assert.deepEqual(missing, [], 'every English string needs a Russian translation');
    assert.equal(Object.keys(english).length, Object.keys(russian).length);
    for (const [key, value] of Object.entries(russian)) {
      assert.notEqual(value.trim(), '', `the translation of '${key}' must not be empty`);
      const placeholders = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(
        placeholders(value),
        placeholders(key),
        `the translation of '${key}' must keep its placeholders`
      );
    }
  });

  it('keeps command titles, keybindings and menus pointing at real commands', () => {
    const commands = new Set(manifest.contributes.commands.map((entry) => entry.command));

    for (const binding of manifest.contributes.keybindings) {
      assert.ok(commands.has(binding.command), `${binding.command} has a keybinding but is not contributed`);
    }
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
      for (const entry of entries) {
        if (entry.command) {
          assert.ok(commands.has(entry.command), `${entry.command} is used in ${menu} but is not contributed`);
        }
      }
    }
  });

  it('documents every setting in the README', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const russianReadme = readFileSync(join(root, 'README.ru.md'), 'utf8');

    for (const setting of Object.keys(manifest.contributes.configuration.properties)) {
      assert.ok(readme.includes(setting), `${setting} must be documented in README.md`);
      assert.ok(russianReadme.includes(setting), `${setting} must be documented in README.ru.md`);
    }
  });

  it('advertises the minimum supported VS Code version', () => {
    const packageJson = JSON.parse(manifestRaw) as { engines: { vscode: string } };
    assert.equal(packageJson.engines.vscode, '^1.105.0');
  });
});
