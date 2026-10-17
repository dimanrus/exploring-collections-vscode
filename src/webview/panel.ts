import * as vscode from 'vscode';
import type { CollectionSnapshot, ColumnDescriptor, RowDescriptor } from '../model/types';
import type { CollectionController } from '../services/controller';
import type { SnapshotStore } from '../state/snapshotStore';
import type { Logger } from '../util/logging';
import { formatError } from '../util/logging';
import { localize, localizeWebviewStrings } from '../services/i18n';
import { readSettings } from '../services/config';
import { copyToClipboard, runExport } from '../services/exporter';
import { isExportFormat, type ExportFormat } from '../export/textFormats';
import { renderCollectionViewHtml } from './html';
import type { HostMessage, WebviewMessage, WebviewSettings } from './protocol';

interface SerializedPanelState {
  snapshotId: string;
  expression: string;
  sessionId: string;
  title: string;
}

/** Webview panel hosting the collection table, the charts and the value pane. */
export class CollectionViewPanel implements vscode.Disposable {
  static readonly viewType = 'exploringCollections.view';
  private static readonly panels = new Map<string, CollectionViewPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private baseSnapshot: CollectionSnapshot;
  private viewSnapshot: CollectionSnapshot;
  private busy = false;
  private disposed = false;

  /** Opens or reveals the panel that shows `snapshot`. */
  static show(
    extensionUri: vscode.Uri,
    controller: CollectionController,
    store: SnapshotStore,
    logger: Logger,
    snapshot: CollectionSnapshot
  ): CollectionViewPanel {
    const existing = CollectionViewPanel.panels.get(snapshot.id);
    if (existing && !existing.disposed) {
      existing.updateSnapshot(snapshot);
      existing.webviewPanel.reveal(undefined, true);
      return existing;
    }

    const webviewPanel = vscode.window.createWebviewPanel(
      CollectionViewPanel.viewType,
      panelTitle(snapshot),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'media')
        ]
      }
    );

    const created = new CollectionViewPanel(
      webviewPanel,
      extensionUri,
      controller,
      store,
      logger,
      snapshot
    );
    CollectionViewPanel.panels.set(snapshot.id, created);
    return created;
  }

  /** Restores a panel after a window reload, when the data is still around. */
  static restore(
    webviewPanel: vscode.WebviewPanel,
    state: unknown,
    extensionUri: vscode.Uri,
    controller: CollectionController,
    store: SnapshotStore,
    logger: Logger
  ): void {
    const serialized = state as SerializedPanelState | undefined;
    const candidates = [...store.pinned, ...store.recent].map((record) => record.snapshot);
    const current = store.currentSnapshot;
    if (current) {
      candidates.push(current);
    }
    const candidate =
      serialized === undefined
        ? undefined
        : candidates.find((snapshot) => snapshot.id === serialized.snapshotId);

    if (!candidate) {
      webviewPanel.webview.html = renderMessageHtml(
        localize('This collection is no longer available. Capture it again from the debug session.')
      );
      return;
    }
    const instance = new CollectionViewPanel(
      webviewPanel,
      extensionUri,
      controller,
      store,
      logger,
      candidate
    );
    CollectionViewPanel.panels.set(candidate.id, instance);
  }

  private constructor(
    private readonly webviewPanel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: CollectionController,
    private readonly store: SnapshotStore,
    private readonly logger: Logger,
    snapshot: CollectionSnapshot
  ) {
    this.baseSnapshot = snapshot;
    this.viewSnapshot = snapshot;

    this.webviewPanel.webview.html = renderCollectionViewHtml(
      this.webviewPanel.webview,
      extensionUri,
      panelTitle(snapshot)
    );

    this.disposables.push(
      this.webviewPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message);
      }),
      this.webviewPanel.onDidDispose(() => this.dispose())
    );
  }

  /** Replaces the panel content with a freshly captured snapshot. */
  updateSnapshot(snapshot: CollectionSnapshot): void {
    const previousId = this.baseSnapshot.id;
    this.baseSnapshot = snapshot;
    this.viewSnapshot = snapshot;
    this.webviewPanel.title = panelTitle(snapshot);
    if (previousId !== snapshot.id) {
      CollectionViewPanel.panels.delete(previousId);
      CollectionViewPanel.panels.set(snapshot.id, this);
    }
    this.post({
      type: 'snapshot',
      snapshot,
      providerName: this.controller.providerDisplayName(snapshot)
    });
  }

  /** Serializes the panel state for window reloads. */
  serialize(): SerializedPanelState {
    return {
      snapshotId: this.baseSnapshot.id,
      expression: this.baseSnapshot.expression,
      sessionId: this.baseSnapshot.sessionId,
      title: this.baseSnapshot.title
    };
  }

  /** Returns the panel that displays the given snapshot id, when it is open. */
  static forSnapshot(snapshotId: string | undefined): CollectionViewPanel | undefined {
    if (!snapshotId) {
      return undefined;
    }
    const panel = CollectionViewPanel.panels.get(snapshotId);
    return panel && !panel.disposed ? panel : undefined;
  }

  /** True when at least one collection panel is open. */
  static get openCount(): number {
    return [...CollectionViewPanel.panels.values()].filter((panel) => !panel.disposed).length;
  }

  /** Reveals the panel and forwards a toolbar command to the webview. */
  async invokeCommand(
    command: 'refresh' | 'export' | 'chart' | 'valuePane' | 'copy' | 'pin'
  ): Promise<void> {
    this.webviewPanel.reveal(undefined, true);
    if (command === 'refresh') {
      await this.handleMessage({ type: 'refresh' });
      return;
    }
    this.post({ type: 'command', command });
  }

  dispose(): void {
    this.disposed = true;
    CollectionViewPanel.panels.delete(this.baseSnapshot.id);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private post(message: HostMessage): void {
    if (this.disposed) {
      return;
    }
    void this.webviewPanel.webview.postMessage(message);
  }

  private webviewSettings(): WebviewSettings {
    const settings = readSettings();
    const kind = vscode.window.activeColorTheme.kind;
    const theme: WebviewSettings['theme'] =
      kind === vscode.ColorThemeKind.Light
        ? 'light'
        : kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight
          ? 'high-contrast'
          : 'dark';
    return {
      pageSize: settings.pageSize,
      enableCharts: settings.enableCharts,
      maxDepth: settings.maxDepth,
      theme
    };
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.post({
            type: 'init',
            snapshot: this.viewSnapshot,
            viewState: this.store.viewStateFor(this.baseSnapshot, readSettings().pageSize),
            settings: this.webviewSettings(),
            strings: localizeWebviewStrings(),
            providerName: this.controller.providerDisplayName(this.baseSnapshot)
          });
          return;

        case 'refresh':
          await this.withBusy(localize('Refreshing collection…'), async () => {
            const refreshed = await this.controller.refresh(this.baseSnapshot);
            if (refreshed) {
              this.updateSnapshot(refreshed);
              this.post({ type: 'toast', level: 'info', message: localize('Collection refreshed.') });
            }
          });
          return;

        case 'applyFilter':
          await this.withBusy(localize('Filtering…'), async () => {
            if (message.text.trim().length === 0) {
              this.resetFilter();
              return;
            }
            const outcome = await this.controller.filter(this.baseSnapshot, message.text);
            if (!outcome) {
              return;
            }
            this.viewSnapshot = outcome.snapshot;
            this.post({ type: 'filterResult', snapshot: this.viewSnapshot, filter: outcome.result });
            for (const warning of outcome.result.warnings) {
              this.logger.warn(`filter warning: ${warning}`);
            }
          });
          return;

        case 'clearFilter':
          this.resetFilter();
          return;

        case 'export':
          await this.exportSnapshot(message);
          return;

        case 'expandValue':
          await this.expandValue(message.requestId, message.variablesReference);
          return;

        case 'copy':
          await copyToClipboard(message.text, message.label);
          this.post({ type: 'toast', level: 'info', message: localize('Copied to clipboard.') });
          return;

        case 'pin':
          this.store.pin(this.viewSnapshot);
          this.post({ type: 'toast', level: 'info', message: localize('Collection pinned.') });
          return;

        case 'saveViewState':
          await this.store.saveViewState(this.baseSnapshot, message.viewState);
          return;

        case 'exportChartImage':
          await this.saveChartImage(message.dataUrl, message.name);
          return;

        case 'showOutput':
          await vscode.commands.executeCommand('exploringCollections.showOutput');
          return;

        case 'showDiagnostics':
          await vscode.commands.executeCommand('exploringCollections.showDiagnostics');
          return;

        case 'openSettings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@ext:dimanrus.exploring-collections'
          );
          return;

        default:
          return;
      }
    } catch (error) {
      this.logger.error(`webview message '${message.type}' failed`, error);
      this.post({ type: 'error', message: formatError(error) });
      void vscode.window.showErrorMessage(formatError(error));
    }
  }

  private resetFilter(): void {
    this.viewSnapshot = this.baseSnapshot;
    this.post({
      type: 'filterResult',
      snapshot: this.viewSnapshot,
      filter: { rows: this.viewSnapshot.rows, executed: '', location: 'client', warnings: [] }
    });
    // Clears the chip in the filter bar, whatever asked for the reset.
    this.post({ type: 'filterApplied', text: '' });
  }

  private async withBusy(label: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.post({ type: 'busy', busy: true, message: label });
    try {
      await action();
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  private resolveColumns(keys: readonly string[]): ColumnDescriptor[] {
    if (keys.length === 0) {
      return this.viewSnapshot.columns;
    }
    const byKey = new Map(this.viewSnapshot.columns.map((column) => [column.key, column]));
    const selected: ColumnDescriptor[] = [];
    for (const key of keys) {
      const column = byKey.get(key);
      if (column) {
        selected.push(column);
      }
    }
    return selected.length > 0 ? selected : this.viewSnapshot.columns;
  }

  private resolveRows(scope: 'filtered' | 'all', rowIndices?: readonly number[]): RowDescriptor[] {
    if (rowIndices && rowIndices.length > 0) {
      return rowIndices
        .map((index) => this.viewSnapshot.rows[index])
        .filter((row): row is RowDescriptor => row !== undefined);
    }
    return scope === 'all' ? this.baseSnapshot.rows : this.viewSnapshot.rows;
  }

  private async exportSnapshot(message: Extract<WebviewMessage, { type: 'export' }>): Promise<void> {
    const format: ExportFormat = isExportFormat(message.format) ? message.format : 'csv';
    const rows = this.resolveRows(message.scope, message.rowIndices);
    if (rows.length === 0) {
      this.post({ type: 'toast', level: 'warn', message: localize('Nothing to export: the view is empty.') });
      return;
    }
    const exported = await runExport(
      {
        selection: {
          snapshot: this.baseSnapshot,
          rows,
          columns: this.resolveColumns(message.columns)
        },
        format
      },
      readSettings(),
      this.logger
    );
    if (exported) {
      this.post({ type: 'toast', level: 'info', message: localize('Exported to {0}', exported.fsPath) });
    }
  }

  private async expandValue(requestId: number, variablesReference: number): Promise<void> {
    try {
      const children = await this.controller.valueChildren(variablesReference);
      this.post({ type: 'valueChildren', requestId, children });
    } catch (error) {
      this.post({ type: 'valueChildren', requestId, error: formatError(error) });
    }
  }

  private async saveChartImage(dataUrl: string, name: string): Promise<void> {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    if (base64.length === 0 || base64 === dataUrl) {
      throw new Error(localize('The chart image could not be encoded.'));
    }
    const settings = readSettings();
    const directory =
      settings.exportDirectory.trim().length > 0
        ? vscode.Uri.file(settings.exportDirectory)
        : vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = directory
      ? vscode.Uri.joinPath(directory, `${name}.png`)
      : vscode.Uri.file(`${name}.png`);

    const target = await vscode.window.showSaveDialog({
      title: localize('Export chart as PNG'),
      defaultUri,
      filters: { PNG: ['png'] }
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
    this.post({ type: 'toast', level: 'info', message: localize('Chart saved to {0}', target.fsPath) });
  }
}

function panelTitle(snapshot: CollectionSnapshot): string {
  return `Collection: ${snapshot.title}`;
}

function renderMessageHtml(message: string): string {
  const escaped = message.replace(/[<>&]/g, (character) =>
    character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&amp;'
  );
  return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); padding: 24px;"><p>${escaped}</p></body></html>`;
}
