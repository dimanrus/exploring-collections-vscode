import Module from 'node:module';
import { EventEmitter as NodeEmitter } from 'node:events';

/**
 * Minimal stand in for the `vscode` module.
 *
 * The extension host is not available outside VS Code, so activation is
 * exercised against this stub. Nothing here emulates behaviour: every call is
 * recorded so a test can assert that the extension registered what its manifest
 * promises.
 */
export interface VscodeStub {
  api: Record<string, unknown>;
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  executedCommands: { command: string; args: unknown[] }[];
  contextKeys: Map<string, unknown>;
  messages: { level: string; message: string }[];
  outputLines: string[];
  registeredTreeViews: string[];
  registeredSerializers: string[];
  registeredInlineProviders: { languages: unknown[] }[];
  registeredCodeLensProviders: unknown[];
  registeredHoverProviders: unknown[];
  webviewPanels: Record<string, unknown>[];
  disposed: string[];
}

class StubDisposable {
  constructor(private readonly onDispose?: () => void) {}

  dispose(): void {
    this.onDispose?.();
  }

  static from(...items: unknown[]): StubDisposable[] {
    return items as StubDisposable[];
  }
}

class StubUri {
  constructor(
    public readonly scheme: string,
    public readonly fsPath: string,
    public readonly path: string = fsPath
  ) {}

  static file(path: string): StubUri {
    return new StubUri('file', path);
  }

  static parse(value: string): StubUri {
    return new StubUri('file', value.replace(/^file:\/\//, ''));
  }

  static joinPath(base: StubUri, ...segments: string[]): StubUri {
    const joined = [base.fsPath.replace(/\/$/, ''), ...segments].join('/');
    return new StubUri(base.scheme, joined);
  }

  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }

  with(changes: { scheme?: string; path?: string }): StubUri {
    return new StubUri(changes.scheme ?? this.scheme, changes.path ?? this.fsPath);
  }
}

class StubEventEmitter<T> extends NodeEmitter {
  event = (listener: (value: T) => void): StubDisposable => {
    this.on('event', listener);
    return new StubDisposable(() => this.off('event', listener));
  };

  fire(value: T): void {
    this.emit('event', value);
  }

  dispose(): void {
    this.removeAllListeners();
  }
}

class StubCodeLens {
  constructor(
    public range: unknown,
    public command?: unknown
  ) {}
}

class StubHover {
  constructor(
    public contents: unknown,
    public range?: unknown
  ) {}
}

class StubTreeItem {
  label: unknown;
  collapsibleState: unknown;
  description: unknown;
  tooltip: unknown;
  contextValue: unknown;
  iconPath: unknown;
  command: unknown;
  id: unknown;

  constructor(label: unknown, collapsibleState?: unknown) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

let shared: VscodeStub | undefined;

/**
 * Installs the stub so that `require('vscode')` resolves to it.
 *
 * The stub is a singleton per process: modules that already captured `vscode`
 * must keep seeing the same object, so a second call returns the first stub.
 */
export function installVscodeStub(): VscodeStub {
  if (shared) {
    return shared;
  }
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const executedCommands: { command: string; args: unknown[] }[] = [];
  const contextKeys = new Map<string, unknown>();
  const messages: { level: string; message: string }[] = [];
  const outputLines: string[] = [];
  const registeredTreeViews: string[] = [];
  const registeredSerializers: string[] = [];
  const registeredInlineProviders: { languages: unknown[] }[] = [];
  const registeredCodeLensProviders: unknown[] = [];
  const registeredHoverProviders: unknown[] = [];
  const webviewPanels: Record<string, unknown>[] = [];
  const disposed: string[] = [];

  // `createOutputChannel(name, { log: true })` yields a log channel.
  const outputChannel = {
    name: 'Exploring Collections',
    logLevel: 2,
    onDidChangeLogLevel: () => new StubDisposable(),
    trace: (value: string) => outputLines.push(value),
    debug: (value: string) => outputLines.push(value),
    info: (value: string) => outputLines.push(value),
    warn: (value: string) => outputLines.push(value),
    error: (value: string) => outputLines.push(value),
    append: (value: string) => outputLines.push(value),
    appendLine: (value: string) => outputLines.push(value),
    replace: (value: string) => outputLines.splice(0, outputLines.length, value),
    clear: () => outputLines.splice(0, outputLines.length),
    show: () => undefined,
    hide: () => undefined,
    dispose: () => disposed.push('outputChannel')
  };

  const webview = () => ({
    html: '',
    options: {},
    cspSource: 'vscode-webview://stub',
    asWebviewUri: (uri: StubUri) => uri.toString(),
    postMessage: async () => true,
    onDidReceiveMessage: () => new StubDisposable()
  });

  const createWebviewPanel = (...args: unknown[]) => {
    const panel: Record<string, unknown> = {
      viewType: args[0],
      title: args[1],
      webview: webview(),
      active: true,
      visible: true,
      onDidDispose: () => new StubDisposable(),
      onDidChangeViewState: () => new StubDisposable(),
      reveal: () => undefined,
      dispose: () => disposed.push('webviewPanel')
    };
    webviewPanels.push(panel);
    return panel;
  };

  const configuration = {
    get: (_key: string, fallback?: unknown) => fallback,
    has: () => false,
    update: async () => undefined,
    inspect: () => undefined
  };

  const stubUri = StubUri;

  const api: Record<string, unknown> = {
    version: '1.105.0',
    Disposable: StubDisposable,
    EventEmitter: StubEventEmitter,
    Uri: stubUri,
    // `new Range(start, end)` and `new Range(startLine, startChar, endLine, endChar)`
    // are both valid in the real API.
    Range: class StubRange {
      readonly start: unknown;
      readonly end: unknown;

      constructor(
        startOrLine: unknown,
        endOrCharacter: unknown,
        endLine?: number,
        endCharacter?: number
      ) {
        if (typeof startOrLine === 'number') {
          this.start = { line: startOrLine, character: endOrCharacter as number };
          this.end = { line: endLine ?? startOrLine, character: endCharacter ?? (endOrCharacter as number) };
        } else {
          this.start = startOrLine;
          this.end = endOrCharacter;
        }
      }
    },
    Position: class {
      constructor(
        public readonly line: number,
        public readonly character: number
      ) {}
    },
    Location: class {
      constructor(
        public readonly uri: unknown,
        public readonly range: unknown
      ) {}
    },
    ThemeIcon: class {
      constructor(public readonly id: string) {}
    },
    MarkdownString: class {
      value = '';
      isTrusted = false;
    },
    CodeLens: StubCodeLens,
    Hover: StubHover,
    TreeItem: StubTreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15, Window: 10 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
    DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
    l10n: {
      t: (message: string, ...args: unknown[]) =>
        args.length === 0 ? message : message.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]))
    },
    env: {
      language: 'en',
      appName: 'Visual Studio Code',
      clipboard: { writeText: async () => undefined, readText: async () => '' }
    },
    commands: {
      registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
        registeredCommands.set(command, handler);
        return new StubDisposable(() => {
          registeredCommands.delete(command);
          disposed.push(command);
        });
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        executedCommands.push({ command, args });
        if (command === 'setContext') {
          contextKeys.set(String(args[0]), args[1]);
        }
        return undefined;
      },
      getCommands: async () => [...registeredCommands.keys()]
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: () => new StubDisposable(),
      activeColorTheme: { kind: 2 },
      showWarningMessage: async (message: string) => {
        messages.push({ level: 'warn', message });
        return undefined;
      },
      showErrorMessage: async (message: string) => {
        messages.push({ level: 'error', message });
        return undefined;
      },
      showInformationMessage: async (message: string) => {
        messages.push({ level: 'info', message });
        return undefined;
      },
      showQuickPick: async () => undefined,
      showSaveDialog: async () => undefined,
      showTextDocument: async () => undefined,
      setStatusBarMessage: () => new StubDisposable(),
      withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
        task(
          { report: () => undefined },
          { isCancellationRequested: false, onCancellationRequested: () => new StubDisposable() }
        ),
      createOutputChannel: () => outputChannel,
      createWebviewPanel,
      registerTreeDataProvider: (viewId: string) => {
        registeredTreeViews.push(viewId);
        return new StubDisposable();
      },
      registerWebviewPanelSerializer: (viewType: string) => {
        registeredSerializers.push(viewType);
        return new StubDisposable();
      }
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => configuration,
      onDidChangeConfiguration: () => new StubDisposable(),
      openTextDocument: async () => ({
        uri: stubUri.file('/tmp/exploring-collections.md'),
        getText: () => '',
        lineCount: 1
      }),
      fs: {
        writeFile: async () => undefined,
        readFile: async () => new Uint8Array(),
        stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 })
      }
    },
    languages: {
      registerInlineValuesProvider: (selector: unknown) => {
        registeredInlineProviders.push({
          languages: Array.isArray(selector) ? selector : [selector]
        });
        return new StubDisposable();
      },
      registerCodeLensProvider: (selector: unknown) => {
        registeredCodeLensProviders.push(selector);
        return new StubDisposable();
      },
      registerHoverProvider: (selector: unknown) => {
        registeredHoverProviders.push(selector);
        return new StubDisposable();
      }
    },
    debug: {
      activeDebugSession: undefined,
      activeStackItem: undefined,
      onDidStartDebugSession: () => new StubDisposable(),
      onDidTerminateDebugSession: () => new StubDisposable(),
      onDidChangeActiveDebugSession: () => new StubDisposable(),
      onDidChangeActiveStackItem: () => new StubDisposable(),
      asDebugSourceUri: (source: { path?: string }) => stubUri.file(source.path ?? ''),
      registerDebugAdapterTrackerFactory: () => new StubDisposable()
    }
  };

  const moduleWithLoad = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
      return api;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  shared = {
    api,
    registeredCommands,
    executedCommands,
    contextKeys,
    messages,
    outputLines,
    registeredTreeViews,
    registeredSerializers,
    registeredInlineProviders,
    registeredCodeLensProviders,
    registeredHoverProviders,
    webviewPanels,
    disposed
  };
  return shared;
}
