import * as vscode from 'vscode';
import { createProviderRegistry } from './providers';
import { DebugSessionRegistry } from './debug/sessionRegistry';
import { SnapshotStore } from './state/snapshotStore';
import { CollectionController } from './services/controller';
import { ExtensionLogger } from './services/logger';
import { CollectionsTreeProvider } from './tree/explorerTree';
import { registerCommands } from './commands';
import { CollectionViewPanel } from './webview/panel';
import { showDiagnosticsReport } from './services/diagnostics';
import {
  CollectionInlineValuesProvider,
  INLINE_HINT_LANGUAGES
} from './services/inlineValues';
import { FrameCollectionIndex } from './services/frameCollections';
import { CollectionCodeLensProvider } from './services/codeLens';
import { LITERAL_LANGUAGES } from './services/literalPreview';
import { CollectionHoverProvider, HOVER_LANGUAGES } from './services/hover';
import { onDidChangeSettings, readSettings } from './services/config';
import { formatError } from './util/logging';

const CONTEXT_HAS_SNAPSHOT = 'exploringCollections.hasSnapshot';
const CONTEXT_SUPPORTED_DEBUG_TYPES = 'exploringCollections.supportedDebugTypes';
const CONTEXT_ACTIVE_PROVIDER = 'exploringCollections.activeProvider';
const CONTEXT_SUPPORTS_DESIGN_TIME = 'exploringCollections.supportsDesignTimePreview';

let deactivateDisposables: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const logger = new ExtensionLogger();
  const providers = createProviderRegistry();
  const settings = readSettings();

  logger.info(
    `activating Exploring Collections ${extensionVersion(context)} for VS Code ${vscode.version} (${process.platform})`
  );

  const sessions = new DebugSessionRegistry(providers, logger, context.extensionUri);
  sessions.initialize();

  const store = new SnapshotStore(context.workspaceState);
  const controller = new CollectionController(sessions, providers, store, logger);
  const collections = new FrameCollectionIndex(sessions, logger);
  const tree = new CollectionsTreeProvider(sessions, store, collections);
  const inlineValues = new CollectionInlineValuesProvider(sessions, collections, logger);
  const codeLens = new CollectionCodeLensProvider(sessions, collections, logger);
  const hover = new CollectionHoverProvider(sessions, collections, logger);

  const updateContextKeys = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      CONTEXT_HAS_SNAPSHOT,
      store.currentSnapshot !== undefined
    );
    void vscode.commands.executeCommand(
      'setContext',
      CONTEXT_SUPPORTED_DEBUG_TYPES,
      providers.supportedDebugTypes()
    );
    void vscode.commands.executeCommand(
      'setContext',
      CONTEXT_SUPPORTS_DESIGN_TIME,
      supportsDesignTimePreview(vscode.window.activeTextEditor?.document.languageId)
    );
    const active = sessions.activeSession();
    if (active) {
      const resolved = sessions.describeContextSync(active, readSettings()).provider;
      void vscode.commands.executeCommand('setContext', CONTEXT_ACTIVE_PROVIDER, resolved?.id ?? '');
    } else {
      void vscode.commands.executeCommand('setContext', CONTEXT_ACTIVE_PROVIDER, '');
    }
  };

  const disposables: vscode.Disposable[] = [
    logger,
    sessions,
    store,
    collections,
    tree,
    inlineValues,
    codeLens
  ];

  disposables.push(
    vscode.window.registerTreeDataProvider('exploringCollections.explorer', tree)
  );

  disposables.push(
    ...registerCommands({
      extensionUri: context.extensionUri,
      controller,
      sessions,
      store,
      logger,
      tree,
      showDiagnostics: () =>
        showDiagnosticsReport({
          controller,
          sessions,
          store,
          logger,
          extensionVersion: extensionVersion(context),
          collections
        }),
      showOutput: () => {
        logger.record('--- output channel opened ---');
        logger.show(true);
      },
      onSnapshotStateChange: () => {
        updateContextKeys();
        tree.refresh();
      }
    })
  );

  disposables.push(
    vscode.window.registerWebviewPanelSerializer(CollectionViewPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        try {
          CollectionViewPanel.restore(
            panel,
            state,
            context.extensionUri,
            controller,
            store,
            logger
          );
        } catch (error) {
          logger.error('failed to restore a collection view', error);
          panel.dispose();
        }
      }
    })
  );

  if (settings.showInlineHints) {
    disposables.push(
      vscode.languages.registerInlineValuesProvider(
        INLINE_HINT_LANGUAGES.map((language) => ({ language })),
        inlineValues
      )
    );
  }

  if (settings.showCodeLens) {
    // Registered for every language: the provider decides from the stopped frame
    // whether the document belongs to a supported language.
    disposables.push(vscode.languages.registerCodeLensProvider('*', codeLens));
  }

  if (settings.showHoverLinks) {
    disposables.push(
      vscode.languages.registerHoverProvider(
        HOVER_LANGUAGES.map((language) => ({ language })),
        hover
      )
    );
  }

  // The stack item changes on every stop, step and frame selection, which is
  // exactly when the frame collections become stale.
  disposables.push(vscode.debug.onDidChangeActiveStackItem(() => collections.invalidate()));

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateContextKeys()),
    sessions.onDidChange(() => {
      updateContextKeys();
      collections.invalidate();
      inlineValues.invalidate();
    }),
    store.onDidChange(() => {
      updateContextKeys();
      tree.refresh();
    }),
    onDidChangeSettings(() => {
      logger.info('settings changed, refreshing context keys');
      updateContextKeys();
      tree.refresh();
    }),
    vscode.debug.onDidTerminateDebugSession(() => {
      collections.invalidate();
      inlineValues.invalidate();
    })
  );

  // Sessions started before activation (for example when VS Code restored a
  // previous debugging session) must still be advertised to the menus.
  updateContextKeys();

  context.subscriptions.push(...disposables);
  deactivateDisposables = disposables;

  logger.info(
    `ready: ${providers.all().length} providers, debug types: ${providers.supportedDebugTypes().join(', ')}`
  );
  logger.record('activation complete');
}

export function deactivate(): void {
  for (const disposable of deactivateDisposables) {
    try {
      disposable.dispose();
    } catch {
      // Shutdown must never throw.
    }
  }
  deactivateDisposables = [];
}

/** True when the language has literals the design time preview understands. */
function supportsDesignTimePreview(languageId: string | undefined): boolean {
  return languageId !== undefined && LITERAL_LANGUAGES.includes(languageId);
}

function extensionVersion(context: vscode.ExtensionContext): string {
  try {
    const packageJson = context.extension.packageJSON as { version?: string } | undefined;
    return packageJson?.version ?? '0.0.0';
  } catch (error) {
    return `unknown (${formatError(error)})`;
  }
}
