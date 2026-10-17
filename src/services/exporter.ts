import * as vscode from 'vscode';
import type { CollectionSnapshot, ColumnDescriptor, RowDescriptor } from '../model/types';
import { buildXlsx } from '../export/xlsx';
import { extensionFor, labelFor, toCsv, toJson, toXml, type ExportFormat } from '../export/textFormats';
import { localize } from './i18n';
import { sanitizeFileName } from '../util/text';
import { formatBytes } from '../util/text';
import type { Logger } from '../util/logging';
import { formatError } from '../util/logging';
import type { ExtensionSettings } from './config';

export interface ExportSelection {
  snapshot: CollectionSnapshot;
  rows?: readonly RowDescriptor[];
  columns?: readonly ColumnDescriptor[];
}

export interface ExportRequest {
  selection: ExportSelection;
  format: ExportFormat;
  /** Overrides the automatic file name when provided. */
  fileName?: string;
}

/** Builds a file name for the exported collection. */
export function suggestedFileName(snapshot: CollectionSnapshot, format: ExportFormat): string {
  const base = sanitizeFileName(snapshot.title.length > 0 ? snapshot.title : 'collection');
  const stamp = new Date(snapshot.capturedAt)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
  return `${base}-${stamp}.${extensionFor(format)}`;
}

/** Serializes the selection into the bytes that should be written to disk. */
export function serializeSelection(
  selection: ExportSelection,
  format: ExportFormat
): Uint8Array {
  switch (format) {
    case 'csv':
      return new TextEncoder().encode(toCsv(selection, { byteOrderMark: true }));
    case 'json':
      return new TextEncoder().encode(toJson(selection, { pretty: true, includeMetadata: true }));
    case 'xml':
      return new TextEncoder().encode(toXml(selection, { pretty: true }));
    case 'xlsx':
      return buildXlsx([
        {
          name: selection.snapshot.title || 'Collection',
          snapshot: selection.snapshot,
          rows: selection.rows ?? selection.snapshot.rows
        }
      ]);
    default:
      throw new Error(`unsupported export format: ${String(format)}`);
  }
}

function defaultDirectory(settings: ExtensionSettings): vscode.Uri | undefined {
  const configured = settings.exportDirectory.trim();
  if (configured.length > 0) {
    return vscode.Uri.file(configured);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Asks for a destination, writes the file and optionally opens it.
 * Returns the written URI, or `undefined` when the user cancelled.
 */
export async function runExport(
  request: ExportRequest,
  settings: ExtensionSettings,
  logger: Logger
): Promise<vscode.Uri | undefined> {
  const { selection, format } = request;
  const directory = defaultDirectory(settings);
  const defaultUri = directory
    ? vscode.Uri.joinPath(directory, request.fileName ?? suggestedFileName(selection.snapshot, format))
    : vscode.Uri.file(request.fileName ?? suggestedFileName(selection.snapshot, format));

  const target = await vscode.window.showSaveDialog({
    title: localize('Export collection as {0}', labelFor(format)),
    defaultUri,
    saveLabel: localize('Export'),
    filters: filtersFor(format)
  });
  if (!target) {
    return undefined;
  }

  try {
    const bytes = serializeSelection(selection, format);
    await vscode.workspace.fs.writeFile(target, bytes);
    logger.info(
      `exported ${selection.rows?.length ?? selection.snapshot.rows.length} rows to ${target.fsPath} (${formatBytes(bytes.byteLength)})`
    );
    if (settings.openExportedFile) {
      await openExportedFile(target, format);
    } else {
      void vscode.window.showInformationMessage(
        localize('Exported {0} to {1}', labelFor(format), target.fsPath)
      );
    }
    return target;
  } catch (error) {
    logger.error(`export failed`, error);
    void vscode.window.showErrorMessage(
      localize('Export failed: {0}', formatError(error))
    );
    return undefined;
  }
}

function filtersFor(format: ExportFormat): Record<string, string[]> | undefined {
  switch (format) {
    case 'csv':
      return { [labelFor('csv')]: ['csv'] };
    case 'json':
      return { [labelFor('json')]: ['json'] };
    case 'xml':
      return { [labelFor('xml')]: ['xml'] };
    case 'xlsx':
      return { [labelFor('xlsx')]: ['xlsx'] };
    default:
      return undefined;
  }
}

async function openExportedFile(uri: vscode.Uri, format: ExportFormat): Promise<void> {
  if (format === 'xlsx') {
    // VS Code has no built-in spreadsheet viewer, so reveal the file instead.
    await vscode.commands.executeCommand('revealFileInOS', uri);
    return;
  }
  await vscode.commands.executeCommand('vscode.open', uri);
}

/** Copies text to the clipboard and reports the result. */
export async function copyToClipboard(text: string, label: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(localize('{0} copied to clipboard', label), 3000);
}
