import type { CollectionSnapshot, RowDescriptor, ValueNode } from '../model/types';
import type { ExportFormat } from '../export/textFormats';

/** Per column local filter state (the funnel icon in the toolbar). */
export interface ColumnFilterState {
  /** Selected values, matched with `mode`. */
  values: string[];
  /** Free text or regular expression applied to the cell content. */
  text: string;
  /** Include or exclude the matching rows. */
  mode: 'include' | 'exclude';
  /** Treat `text` as a regular expression. */
  regex: boolean;
}

/** State of the table view, persisted per collection between sessions. */
/** What the viewer learns about the last filter; the rows travel on their own. */
export interface FilterSummary {
  /** Text of the condition that ran, shown in the tooltip of the status badge. */
  executed: string;
  /** Non fatal problems, e.g. a window that was smaller than the collection. */
  warnings: string[];
}

export interface ViewState {
  sort: { columnKey: string; direction: 'asc' | 'desc' } | null;
  search: string;
  /** Condition of the optional debugger side filter, empty when there is none. */
  filter: string;
  page: number;
  pageSize: number;
  hiddenColumns: string[];
  /** User defined column order (column keys); `null` means provider order. */
  columnOrder: string[] | null;
  columnFilters: Record<string, ColumnFilterState>;
  /** Right hand detail pane, `true` by default. */
  showValuePane: boolean;
  /** Height of the chart area in pixels, `null` for the default. */
  chartHeight: number | null;
  /** Width of the detail pane in pixels, `null` for the default. */
  detailWidth: number | null;
  /** True while the table is collapsed to give the chart the whole area. */
  tableCollapsed: boolean;
}

export function createDefaultViewState(pageSize: number): ViewState {
  return {
    sort: null,
    search: '',
    filter: '',
    page: 0,
    pageSize,
    hiddenColumns: [],
    columnOrder: null,
    columnFilters: {},
    showValuePane: true,
    chartHeight: null,
    detailWidth: null,
    tableCollapsed: false
  };
}

/** Every string the webview renders, resolved on the host for localization. */
export interface LocalizedStrings {
  appTitle: string;
  loading: string;
  toolbar: {
    refresh: string;
    filter: string;
    clearFilter: string;
    search: string;
    columns: string;
    export: string;
    chart: string;
    chartSettings: string;
    pin: string;
    settings: string;
    diagnostics: string;
    copy: string;
    apply: string;
    cancel: string;
    close: string;
    pageSize: string;
    page: string;
    of: string;
    rows: string;
    clearAllFilters: string;
    selectAll: string;
    clear: string;
    addToValues: string;
    include: string;
    exclude: string;
    regex: string;
    hideColumn: string;
    showColumn: string;
    resetOrder: string;
    sortAscending: string;
    sortDescending: string;
    clearSort: string;
    valuePane: string;
    expandAll: string;
    collapseAll: string;
    loadFromDebugger: string;
    chartType: string;
    xAxis: string;
    yAxis: string;
    group: string;
    aggregation: string;
    series: string;
    none: string;
    mean: string;
    sum: string;
    min: string;
    max: string;
    count: string;
    first: string;
    last: string;
    exportPng: string;
    empty: string;
    emptyHint: string;
    elapsed: string;
    requests: string;
    strategy: string;
    truncated: string;
    filtered: string;
    total: string;
    error: string;
    warning: string;
    showValuePane: string;
    hideValuePane: string;
    hideTable: string;
    showTable: string;
    resizeChart: string;
    resizeDetail: string;
    activeFilter: string;
    valueEmpty: string;
    filterBuilderTitle: string;
    filterWholeCollection: string;
    addCondition: string;
    removeCondition: string;
    filterColumn: string;
    filterOperator: string;
    filterValue: string;
    filterValueTo: string;
    filterOperators: Record<string, string>;
    rowPosition: string;
    copyCell: string;
    copyRow: string;
    copyAll: string;
    copied: string;
  };
  chartTypes: {
    bar: string;
    pie: string;
    area: string;
    line: string;
    scatter: string;
    bubble: string;
    stock: string;
    areaRange: string;
    histogram: string;
  };
}

export interface WebviewSettings {
  pageSize: number;
  enableCharts: boolean;
  maxDepth: number;
  theme: 'dark' | 'light' | 'high-contrast';
}

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | {
      type: 'init';
      snapshot: CollectionSnapshot;
      viewState: ViewState;
      settings: WebviewSettings;
      strings: LocalizedStrings;
      providerName: string;
    }
  | { type: 'snapshot'; snapshot: CollectionSnapshot; providerName: string }
  | {
      type: 'filterResult';
      /** Condition that produced `rows`, kept for the chip and saved with the view. */
      text: string;
      rows: RowDescriptor[];
      filter: FilterSummary;
    }
  | { type: 'filterCleared' }
  | { type: 'busy'; busy: boolean; message?: string }
  | { type: 'error'; message: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  | {
      type: 'valueChildren';
      requestId: number;
      children?: ValueNode[];
      error?: string;
    }
  | { type: 'settings'; settings: WebviewSettings }
  | { type: 'localized'; strings: LocalizedStrings }
  /** Toolkit command issued from a palette entry; the webview performs it. */
  | { type: 'command'; command: 'refresh' | 'export' | 'chart' | 'valuePane' | 'copy' | 'pin' };

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'applyFilter'; text: string }
  | { type: 'clearFilter' }
  | {
      type: 'export';
      format: ExportFormat;
      scope: 'filtered' | 'all';
      columns: string[];
      /** Explicit row positions within the current rows, used for page exports. */
      rowIndices?: number[];
    }
  | { type: 'expandValue'; requestId: number; variablesReference: number; evaluateName?: string }
  | { type: 'copy'; text: string; label: string }
  | { type: 'pin' }
  | { type: 'saveViewState'; viewState: ViewState }
  | { type: 'exportChartImage'; dataUrl: string; name: string }
  | { type: 'showOutput' }
  | { type: 'showDiagnostics' }
  | { type: 'openSettings' };

/** Convenience alias used by the webview implementation. */
export type SnapshotMessage = Extract<HostMessage, { type: 'snapshot' }>;
