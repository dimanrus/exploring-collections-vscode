import * as vscode from 'vscode';
import type { DateFormat } from '../model/formatter';
import type { ExportFormat } from '../export/textFormats';
import type { CaptureLayout } from '../providers/capturer';

export const CONFIGURATION_SECTION = 'exploringCollections';

/** Snapshot of the extension settings, read once per operation. */
export interface ExtensionSettings {
  maxRows: number;
  /** Upper bound of the time one capture may spend reading a collection. */
  captureBudgetMs: number;
  pageSize: number;
  maxDepth: number;
  fetchConcurrency: number;
  timeoutMs: number;
  enableLanguageHelpers: boolean;
  enableFilterPushdown: boolean;
  enableCharts: boolean;
  showInlineHints: boolean;
  showCodeLens: boolean;
  showHoverLinks: boolean;
  showDesignTimePreview: boolean;
  dateFormat: DateFormat;
  columnOrder: 'alphabetical' | 'discovery';
  defaultExportFormat: ExportFormat;
  exportDirectory: string;
  openExportedFile: boolean;
  dictionariesAsRows: boolean;
  customDebugTypes: Record<string, string>;
  excludedMembers: string[];
}

const DEFAULTS: ExtensionSettings = {
  maxRows: 10000,
  captureBudgetMs: 30000,
  pageSize: 100,
  maxDepth: 3,
  fetchConcurrency: 8,
  timeoutMs: 20000,
  enableLanguageHelpers: true,
  enableFilterPushdown: true,
  enableCharts: true,
  showInlineHints: true,
  showCodeLens: true,
  showHoverLinks: true,
  showDesignTimePreview: true,
  dateFormat: 'iso',
  columnOrder: 'alphabetical',
  defaultExportFormat: 'csv',
  exportDirectory: '',
  openExportedFile: true,
  dictionariesAsRows: true,
  customDebugTypes: {},
  excludedMembers: ['Capacity', 'Count', 'Length', 'LongLength', '_count', '__len__']
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Reads the current settings, falling back to safe values for bad input. */
export function readSettings(): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const customDebugTypes = configuration.get<Record<string, string>>('customDebugTypes', {});
  const excludedMembers = configuration.get<string[]>('excludedMembers', DEFAULTS.excludedMembers);

  return {
    maxRows: clamp(configuration.get<number>('maxRows', DEFAULTS.maxRows), 1, 2000000, DEFAULTS.maxRows),
    captureBudgetMs: clamp(
      configuration.get<number>('captureBudgetMs', DEFAULTS.captureBudgetMs),
      1000,
      600000,
      DEFAULTS.captureBudgetMs
    ),
    pageSize: clamp(configuration.get<number>('pageSize', DEFAULTS.pageSize), 1, 10000, DEFAULTS.pageSize),
    maxDepth: clamp(configuration.get<number>('maxDepth', DEFAULTS.maxDepth), 1, 10, DEFAULTS.maxDepth),
    fetchConcurrency: clamp(
      configuration.get<number>('fetchConcurrency', DEFAULTS.fetchConcurrency),
      1,
      64,
      DEFAULTS.fetchConcurrency
    ),
    timeoutMs: clamp(configuration.get<number>('timeoutMs', DEFAULTS.timeoutMs), 1000, 600000, DEFAULTS.timeoutMs),
    enableLanguageHelpers: configuration.get<boolean>(
      'enableLanguageHelpers',
      DEFAULTS.enableLanguageHelpers
    ),
    enableFilterPushdown: configuration.get<boolean>('enableFilterPushdown', DEFAULTS.enableFilterPushdown),
    enableCharts: configuration.get<boolean>('enableCharts', DEFAULTS.enableCharts),
    showInlineHints: configuration.get<boolean>('showInlineHints', DEFAULTS.showInlineHints),
    showCodeLens: configuration.get<boolean>('showCodeLens', DEFAULTS.showCodeLens),
    showHoverLinks: configuration.get<boolean>('showHoverLinks', DEFAULTS.showHoverLinks),
    showDesignTimePreview: configuration.get<boolean>(
      'showDesignTimePreview',
      DEFAULTS.showDesignTimePreview
    ),
    dateFormat: configuration.get<DateFormat>('dateFormat', DEFAULTS.dateFormat),
    columnOrder: configuration.get<'alphabetical' | 'discovery'>('columnOrder', DEFAULTS.columnOrder),
    defaultExportFormat: configuration.get<ExportFormat>('defaultExportFormat', DEFAULTS.defaultExportFormat),
    exportDirectory: configuration.get<string>('exportDirectory', DEFAULTS.exportDirectory),
    openExportedFile: configuration.get<boolean>('openExportedFile', DEFAULTS.openExportedFile),
    dictionariesAsRows: configuration.get<boolean>('dictionariesAsRows', DEFAULTS.dictionariesAsRows),
    customDebugTypes: sanitizeCustomTypes(customDebugTypes),
    excludedMembers: Array.isArray(excludedMembers)
      ? excludedMembers.filter((entry) => typeof entry === 'string')
      : [...DEFAULTS.excludedMembers]
  };
}

function sanitizeCustomTypes(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== 'object') {
    return result;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === 'string' && typeof entry === 'string' && key.length > 0 && entry.length > 0) {
      result[key] = entry;
    }
  }
  return result;
}

/** Layout settings derived from the user configuration. */
export function layoutFromSettings(settings: ExtensionSettings): CaptureLayout {
  return {
    columnOrder: settings.columnOrder,
    flattenDepth: Math.max(1, Math.min(4, settings.maxDepth))
  };
}

/** Subscribes to configuration changes of the extension section. */
export function onDidChangeSettings(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
      listener();
    }
  });
}
