import * as vscode from 'vscode';
import type { CollectionSnapshot } from '../model/types';
import type { CollectionController, VariableCandidate } from '../services/controller';
import type { DebugSessionRegistry } from '../debug/sessionRegistry';
import { normalizeVariableArgument } from '../debug/sessionRegistry';
import type { SnapshotRecord, SnapshotStore } from '../state/snapshotStore';
import type { CollectionsTreeProvider, ExplorerNode } from '../tree/explorerTree';
import { CollectionViewPanel } from '../webview/panel';
import { localize } from '../services/i18n';
import { readSettings } from '../services/config';
import { copyToClipboard, runExport } from '../services/exporter';
import { toCsv, isExportFormat, type ExportFormat } from '../export/textFormats';
import { findLiteralCollections, snapshotFromLiteral, type LiteralCollection } from '../services/literalPreview';
import { layoutFromSettings } from '../services/config';
import type { ExtensionLogger } from '../services/logger';
import { formatError } from '../util/logging';

export interface CommandDependencies {
  extensionUri: vscode.Uri;
  controller: CollectionController;
  sessions: DebugSessionRegistry;
  store: SnapshotStore;
  logger: ExtensionLogger;
  tree: CollectionsTreeProvider;
  showDiagnostics: () => Promise<void>;
  showOutput: () => void;
  onSnapshotStateChange: () => void;
}

const COLLECTION_HINT = 'Start a debug session and stop at a breakpoint to explore collections.';

/** Registers every command of the extension. */
export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const register = (
    id: string,
    handler: (...args: unknown[]) => Promise<void> | void
  ): void => {
    disposables.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          deps.logger.error(`command ${id} failed`, error);
          void vscode.window.showErrorMessage(formatError(error));
        } finally {
          deps.onSnapshotStateChange();
        }
      })
    );
  };

  register('exploringCollections.explore', (argument) => exploreArgument(deps, argument));
  register('exploringCollections.exploreWatch', (argument) => exploreArgument(deps, argument));
  register('exploringCollections.exploreConsole', () => pickAndExplore(deps));
  register('exploringCollections.pickAndExplore', () => pickAndExplore(deps));
  register('exploringCollections.previewLiteral', (argument) => previewLiteral(deps, argument));
  register('exploringCollections.refresh', () => refreshCurrent(deps));
  register('exploringCollections.toggleMaximize', async () => {
    // Expands the editor group hosting the view so the collection fills the whole
    // window instead of sharing it with the neighbouring editors.
    await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
  });
  register('exploringCollections.export', () => exportCurrent(deps));
  register('exploringCollections.showChart', () => forwardToPanel(deps, 'chart'));
  register('exploringCollections.copyRows', (argument) => copyRows(deps, argument));
  register('exploringCollections.pinSnapshot', () => pinCurrent(deps));
  register('exploringCollections.removeSnapshot', (argument) => removeSnapshot(deps, argument));
  register('exploringCollections.openSnapshot', (argument) => openSnapshot(deps, argument));
  register('exploringCollections.showOutput', () => deps.showOutput());
  register('exploringCollections.showDiagnostics', () => deps.showDiagnostics());

  return disposables;
}

async function exploreArgument(deps: CommandDependencies, argument: unknown): Promise<void> {
  const normalized = normalizeVariableArgument(argument);
  const usable = normalized !== undefined;
  if (!usable || (!normalized.variable.variablesReference && !normalized.variable.evaluateName)) {
    await pickAndExplore(deps);
    return;
  }

  const snapshot = await withProgress(localize('Reading the collection…'), (token, progress) =>
    deps.controller.capture(
      {
        sessionId: normalized.sessionId,
        variable: normalized.variable,
        title: normalized.variable.name
      },
      token,
      rowReporter(progress)
    )
  );
  if (snapshot) {
    openPanel(deps, snapshot);
  }
}

async function pickAndExplore(deps: CommandDependencies): Promise<void> {
  const session = deps.sessions.activeSession();
  if (!session) {
    void vscode.window.showWarningMessage(localize(COLLECTION_HINT));
    return;
  }

  const candidates = await withProgress(localize('Looking for collections in the current frame…'), () =>
    deps.controller.listCandidates(session.id)
  );

  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(
      localize('No collection variables were found in the current frame.')
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.label,
      description: candidate.description,
      detail: candidate.detail,
      candidate
    })),
    {
      title: localize('Explore a collection'),
      placeHolder: localize('Select the collection to inspect'),
      matchOnDescription: true,
      matchOnDetail: true
    }
  );
  if (!picked) {
    return;
  }

  const target: VariableCandidate = picked.candidate;
  const snapshot = await withProgress(localize('Reading the collection…'), (token, progress) =>
    deps.controller.capture(
      {
        sessionId: session.id,
        variable: {
          name: target.label,
          type: target.description,
          evaluateName: target.expression,
          variablesReference: target.root.variablesReference
        },
        title: target.label
      },
      token,
      rowReporter(progress)
    )
  );
  if (snapshot) {
    openPanel(deps, snapshot);
  }
}

async function refreshCurrent(deps: CommandDependencies): Promise<void> {
  const current = deps.store.currentSnapshot;
  if (!current) {
    void vscode.window.showWarningMessage(localize(COLLECTION_HINT));
    return;
  }
  const panel = CollectionViewPanel.forSnapshot(current.id);
  if (panel) {
    await panel.invokeCommand('refresh');
    return;
  }
  const refreshed = await withProgress(localize('Refreshing the collection…'), (token) =>
    deps.controller.refresh(current, token)
  );
  if (refreshed) {
    openPanel(deps, refreshed);
  }
}

async function exportCurrent(deps: CommandDependencies): Promise<void> {
  const current = deps.store.currentSnapshot;
  if (!current) {
    void vscode.window.showWarningMessage(localize(COLLECTION_HINT));
    return;
  }
  const panel = CollectionViewPanel.forSnapshot(current.id);
  if (panel) {
    await panel.invokeCommand('export');
    return;
  }

  const settings = readSettings();
  const formats: ExportFormat[] = ['csv', 'json', 'xlsx', 'xml'];
  const picked = await vscode.window.showQuickPick(
    formats.map((format) => ({
      label: format.toUpperCase(),
      description: format === settings.defaultExportFormat ? localize('default') : '',
      format
    })),
    { title: localize('Export collection'), placeHolder: localize('Select the export format') }
  );
  if (!picked || !isExportFormat(picked.format)) {
    return;
  }
  await runExport({ selection: { snapshot: current }, format: picked.format }, settings, deps.logger);
}

async function forwardToPanel(
  deps: CommandDependencies,
  command: 'chart' | 'valuePane' | 'copy'
): Promise<void> {
  const current = deps.store.currentSnapshot;
  if (!current) {
    void vscode.window.showWarningMessage(localize(COLLECTION_HINT));
    return;
  }
  const panel = CollectionViewPanel.forSnapshot(current.id);
  if (panel) {
    await panel.invokeCommand(command);
    return;
  }

  if (command === 'copy') {
    await copyRowsToClipboard(current);
    return;
  }

  if (command === 'chart') {
    openPanel(deps, current);
    await CollectionViewPanel.forSnapshot(current.id)?.invokeCommand('chart');
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    localize('Open the collection view to use this action.'),
    localize('Open "{0}"', current.title)
  );
  if (choice) {
    openPanel(deps, current);
    await CollectionViewPanel.forSnapshot(current.id)?.invokeCommand(command);
  }
}

async function copyRows(deps: CommandDependencies, argument: unknown): Promise<void> {
  const normalized = normalizeVariableArgument(argument);
  if (normalized && normalized.variable.variablesReference) {
    const snapshot = await withProgress(localize('Reading the collection…'), (token, progress) =>
      deps.controller.capture(
        {
          sessionId: normalized.sessionId,
          variable: normalized.variable,
          title: normalized.variable.name
        },
        token,
        rowReporter(progress)
      )
    );
    if (!snapshot) {
      return;
    }
    await copyRowsToClipboard(snapshot);
    return;
  }

  const current = deps.store.currentSnapshot;
  if (!current) {
    void vscode.window.showWarningMessage(localize(COLLECTION_HINT));
    return;
  }
  const panel = CollectionViewPanel.forSnapshot(current.id);
  if (panel) {
    await panel.invokeCommand('copy');
    return;
  }
  await copyRowsToClipboard(current);
}

async function copyRowsToClipboard(snapshot: CollectionSnapshot): Promise<void> {
  const text = toCsv(
    { snapshot },
    { delimiter: '\t', byteOrderMark: false, lineEnding: '\n' }
  );
  await copyToClipboard(text, localize('{0} rows', snapshot.rows.length));
}

async function pinCurrent(deps: CommandDependencies): Promise<void> {
  const current = deps.store.currentSnapshot;
  if (!current) {
    void vscode.window.showWarningMessage(localize(COLLECTION_HINT));
    return;
  }
  deps.store.pin(current);
  void vscode.window.showInformationMessage(localize('Pinned "{0}".', current.title));
}

async function removeSnapshot(deps: CommandDependencies, argument: unknown): Promise<void> {
  const snapshot = snapshotFromArgument(argument);
  if (!snapshot) {
    return;
  }
  deps.store.remove(snapshot.id);
}

async function openSnapshot(deps: CommandDependencies, argument: unknown): Promise<void> {
  const snapshot = snapshotFromArgument(argument);
  if (!snapshot) {
    const current = deps.store.currentSnapshot;
    if (!current) {
      void vscode.window.showWarningMessage(localize('Select a collection in the Collections view.'));
      return;
    }
    openPanel(deps, current);
    return;
  }
  openPanel(deps, snapshot);
}

function snapshotFromArgument(argument: unknown): CollectionSnapshot | undefined {
  if (!argument || typeof argument !== 'object') {
    return undefined;
  }
  if (argument instanceof vscode.TreeItem) {
    const node = argument as ExplorerNode;
    return node.snapshot;
  }
  const record = argument as SnapshotRecord & { snapshot?: CollectionSnapshot };
  if (record.snapshot && typeof record.snapshot === 'object') {
    return record.snapshot;
  }
  const candidate = argument as CollectionSnapshot;
  if (typeof candidate.id === 'string' && Array.isArray(candidate.columns)) {
    return candidate;
  }
  return undefined;
}

/**
 * Opens the viewer for data that is written in the source text.
 *
 * The CodeLens passes the document and the line of the literal; the command
 * palette and the editor context menu have no argument, so the literals of the
 * active editor are listed instead.
 */
async function previewLiteral(deps: CommandDependencies, argument: unknown): Promise<void> {
  const target = normalizeLiteralArgument(argument);
  const editor = vscode.window.activeTextEditor;
  const uri = target ? vscode.Uri.parse(target.uri) : editor?.document.uri;
  if (!uri) {
    void vscode.window.showWarningMessage(localize(COLLECTION_HINT));
    return;
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    void vscode.window.showWarningMessage(
      localize('Could not open {0}: {1}', uri.fsPath || uri.toString(), formatError(error))
    );
    return;
  }

  const literals = findLiteralCollections(document.getText(), document.languageId);
  if (literals.length === 0) {
    void vscode.window.showWarningMessage(
      localize('No collection data was found in {0}.', document.uri.fsPath || document.fileName)
    );
    return;
  }

  const literal = await pickLiteral(document, literals, target?.line);
  if (!literal) {
    return;
  }

  const settings = readSettings();
  const snapshot = snapshotFromLiteral(literal, literal.name ?? document.fileName, {
    formatOptions: {
      dateFormat: settings.dateFormat,
      maxCellLength: 512,
      emptyStringAsNull: false
    },
    columnOrder: layoutFromSettings(settings).columnOrder,
    flattenDepth: layoutFromSettings(settings).flattenDepth,
    uri: document.uri.toString(),
    sessionId: `source:${document.uri.toString()}`,
    notes: [localize('Read from the source text; no debug session is required.')]
  });

  deps.store.setCurrent(snapshot);
  deps.logger.info(
    `previewed literal '${snapshot.title}' (${snapshot.rows.length} rows) from ${document.uri.fsPath}`
  );
  openPanel(deps, snapshot);
}

/** Literal the CodeLens pointed at, or the one the user picks. */
async function pickLiteral(
  document: vscode.TextDocument,
  literals: readonly LiteralCollection[],
  line: number | undefined
): Promise<LiteralCollection | undefined> {
  if (line !== undefined) {
    const exact = literals.find((literal) => literal.line === line);
    if (exact) {
      return exact;
    }
  }
  if (literals.length === 1) {
    return literals[0];
  }
  const cursorLine = line ?? vscode.window.activeTextEditor?.selection.active.line;
  const sorted = [...literals].sort(
    (left, right) => Math.abs(left.line - (cursorLine ?? 0)) - Math.abs(right.line - (cursorLine ?? 0))
  );
  if (cursorLine !== undefined && Math.abs((sorted[0]?.line ?? 0) - cursorLine) <= 2) {
    return sorted[0];
  }
  const picked = await vscode.window.showQuickPick(
    sorted.map((literal) => ({
      label: literal.name ?? localize('collection'),
      description: localize('{0} row(s)', String(literal.rows.length)),
      detail: document.lineAt(literal.line).text.trim().slice(0, 120),
      literal
    })),
    {
      title: localize('Preview collection data'),
      placeHolder: localize('Select the collection to preview')
    }
  );
  return picked?.literal;
}

/** Argument the CodeLens hands over: the document and the line of the literal. */
function normalizeLiteralArgument(argument: unknown): { uri: string; line: number } | undefined {
  if (!argument || typeof argument !== 'object') {
    return undefined;
  }
  const candidate = argument as { uri?: unknown; line?: unknown };
  if (typeof candidate.uri !== 'string' || typeof candidate.line !== 'number') {
    return undefined;
  }
  return { uri: candidate.uri, line: candidate.line };
}

function openPanel(deps: CommandDependencies, snapshot: CollectionSnapshot): void {
  CollectionViewPanel.show(
    deps.extensionUri,
    deps.controller,
    deps.store,
    deps.logger,
    snapshot
  );
}

async function withProgress<T>(
  title: string,
  action: (token: vscode.CancellationToken, progress: vscode.Progress<{ message?: string }>) => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (progress, token) => action(token, progress)
  );
}

/**
 * Reports row progress into the notification, throttled so thousands of
 * materialized rows do not turn into thousands of UI updates.
 */
function rowReporter(progress: vscode.Progress<{ message?: string }>): (rows: number, total: number) => void {
  let reportedAt = 0;
  let reportedRows = -1;
  return (rows, total) => {
    const now = Date.now();
    if (rows === reportedRows || (now - reportedAt < 250 && rows < total)) {
      return;
    }
    reportedAt = now;
    reportedRows = rows;
    progress.report({
      message: localize('{0} of {1} rows', rows.toLocaleString(), total.toLocaleString())
    });
  };
}
