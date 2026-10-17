import type { CollectionSnapshot, ColumnDescriptor } from '../src/model/types';
import type {
  ColumnFilterState,
  HostMessage,
  LocalizedStrings,
  ViewState,
  WebviewMessage,
  WebviewSettings
} from '../src/webview/protocol';
import { createDefaultViewState } from '../src/webview/protocol';
import { ChartView, createDefaultChartState, type ChartLabels, type ChartState } from './charts';
import { clear, el, formatCount, icon } from './dom';
import {
  clampChartHeight,
  clampDetailWidth,
  clampPage,
  DEFAULT_CHART_HEIGHT,
  DEFAULT_DETAIL_WIDTH,
  distinctValues,
  emptyColumnFilter,
  isColumnFilterActive,
  orderedColumns,
  runPipeline
} from './state';
import { CollectionTable, computeColumnWidths } from './table';
import {
  conditionsFromText,
  renderFilterBuilder,
  type FilterBuilderStrings
} from './filterBuilder';
import { ValuePane } from './valuePane';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface PreviewBridge {
  postMessage(message: WebviewMessage): void;
  onMessage(listener: (message: HostMessage) => void): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __EXPLORING_COLLECTIONS_PREVIEW__?: PreviewBridge;
  }
}

interface AppState {
  snapshot: CollectionSnapshot | undefined;
  providerName: string;
  strings: LocalizedStrings | undefined;
  settings: WebviewSettings;
  view: ViewState;
  chartOpen: boolean;
  chart: ChartState;
  selectedRow: number | null;
  selectedColumnKey: string | null;
  busy: boolean;
  filterInfo: { executed: string; location: 'debugger' | 'client'; warnings: string[] } | undefined;
}

/** Page size presets of the pager, plus the "show everything" sentinel. */
const PAGE_SIZES = [25, 50, 100, 250, 500, 1000, 5000];
const ALL_ROWS = 'all';

const state: AppState = {
  snapshot: undefined,
  providerName: '',
  strings: undefined,
  settings: { pageSize: 100, enableCharts: true, maxDepth: 3, theme: 'dark' },
  view: createDefaultViewState(100),
  chartOpen: false,
  chart: { type: 'bar', xKey: '', yKeys: [], groupKey: '', sizeKey: '', aggregation: 'count', showLegend: true, bins: 12 },
  selectedRow: null,
  selectedColumnKey: null,
  busy: false,
  filterInfo: undefined
};

let api: VsCodeApi | undefined;
let table: CollectionTable | undefined;
let valuePane: ValuePane | undefined;
let chartView: ChartView | undefined;
let persistTimer: number | undefined;
let searchTimer: number | undefined;
let placeholder: HTMLDivElement | undefined;

const elements: {
  root: HTMLElement;
  toolbar: HTMLDivElement;
  filterBar: HTMLDivElement;
  main: HTMLDivElement;
  grid: HTMLDivElement;
  status: HTMLDivElement;
  side: HTMLDivElement;
  chartHost: HTMLDivElement;
  splitChart: HTMLDivElement;
  splitDetail: HTMLDivElement;
  overlay: HTMLDivElement;
  toasts: HTMLDivElement;
} = {
  root: document.getElementById('app') as HTMLElement,
  toolbar: el('div', { class: 'toolbar' }),
  filterBar: el('div', { class: 'filter-bar' }),
  main: el('div', { class: 'main' }),
  grid: el('div', { class: 'grid-host' }),
  status: el('div', { class: 'status-bar' }),
  side: el('div', { class: 'side-panel' }),
  chartHost: el('div', { class: 'chart-host' }),
  splitChart: el('div', { class: 'splitter splitter-h' }),
  splitDetail: el('div', { class: 'splitter splitter-v' }),
  overlay: el('div', { class: 'overlay', hidden: true }),
  toasts: el('div', { class: 'toasts' })
};

function post(message: WebviewMessage): void {
  api?.postMessage(message);
}

function bootstrap(): void {
  attachSplitters();
  clear(elements.root);
  elements.root.appendChild(elements.toolbar);
  elements.root.appendChild(elements.filterBar);
  elements.main.appendChild(elements.grid);
  elements.main.appendChild(elements.splitDetail);
  elements.main.appendChild(elements.side);
  const canvas = el('div', { class: 'canvas' }, [
    elements.chartHost,
    elements.splitChart,
    elements.main
  ]);
  elements.root.appendChild(canvas);
  elements.root.appendChild(elements.status);
  elements.root.appendChild(elements.overlay);
  elements.root.appendChild(elements.toasts);

  if (window.__EXPLORING_COLLECTIONS_PREVIEW__) {
    const bridge = window.__EXPLORING_COLLECTIONS_PREVIEW__;
    api = {
      postMessage: (message) => bridge.postMessage(message),
      getState: () => undefined,
      setState: () => undefined
    };
    bridge.onMessage((message) => handleHostMessage(message));
  } else if (typeof window.acquireVsCodeApi === 'function') {
    api = window.acquireVsCodeApi();
    window.addEventListener('message', (event) => handleHostMessage(event.data as HostMessage));
  }

  renderEmpty();
  post({ type: 'ready' });
}

function handleHostMessage(message: HostMessage): void {
  switch (message.type) {
    case 'init': {
      state.snapshot = message.snapshot;
      state.providerName = message.providerName;
      state.strings = message.strings;
      state.settings = message.settings;
      state.view = { ...createDefaultViewState(message.settings.pageSize), ...message.viewState };
      state.chart = deriveChartState(message.snapshot, state.chart);
      state.selectedRow = null;
      state.filterInfo = undefined;
      buildOnce();
      renderAll();
      return;
    }
    case 'snapshot': {
      state.snapshot = message.snapshot;
      state.providerName = message.providerName;
      state.filterInfo = undefined;
      renderAll();
      return;
    }
    case 'filterResult': {
      if (state.snapshot) {
        state.snapshot = { ...state.snapshot, rows: message.snapshot.rows };
      } else {
        state.snapshot = message.snapshot;
      }
      state.filterInfo = message.filter;
      renderAll();
      return;
    }
    case 'filterApplied': {
      state.view.filter = message.text;
      if (message.text.trim().length === 0) {
        state.filterInfo = undefined;
      }
      persistViewState();
      renderAll();
      return;
    }
    case 'busy':
      state.busy = message.busy;
      renderOverlay(message.message);
      return;
    case 'error':
      showToast('error', message.message);
      return;
    case 'toast':
      showToast(message.level, message.message);
      return;
    case 'valueChildren':
      valuePane?.resolveChildren(message.requestId, message.children, message.error);
      return;
    case 'settings':
      state.settings = message.settings;
      renderAll();
      return;
    case 'localized':
      state.strings = message.strings;
      renderAll();
      return;
    case 'command':
      void runCommand(message.command);
      return;
    default:
      return;
  }
}

function deriveChartState(snapshot: CollectionSnapshot, current: ChartState): ChartState {
  const defaults = createDefaultChartState(snapshot.columns);
  if (snapshot.columns.some((column) => column.key === current.xKey)) {
    return {
      ...current,
      yKeys: current.yKeys.filter((key) => snapshot.columns.some((column) => column.key === key))
    };
  }
  return defaults;
}

function buildOnce(): void {
  table = new CollectionTable(elements.grid, {
    onSelect: (columnKey, rowIndex) => {
      state.selectedRow = rowIndex;
      state.selectedColumnKey = columnKey;
      renderGrid();
      renderValuePane();
    },
    onSortChange: (columnKey, direction) => {
      state.view.sort = direction === null ? null : { columnKey, direction };
      persistViewState();
      renderAll();
    },
    openColumnFilter: (entry, anchor) => openColumnFilterPopover(entry.column, anchor),
    onReorder: (order) => {
      state.view.columnOrder = order;
      persistViewState();
      renderAll();
    },
    onCopy: (text, label) => post({ type: 'copy', text, label })
  });

  valuePane = new ValuePane(elements.side, {
    requestChildren: (requestId, variablesReference) =>
      post({ type: 'expandValue', requestId, variablesReference }),
    onCopy: (text, label) => post({ type: 'copy', text, label })
  });

  chartView = new ChartView(elements.chartHost, {
    onStateChange: (chart) => {
      state.chart = chart;
      renderChart();
    },
    onExportPng: (markup, name) => {
      const size = parseSvgSize(markup);
      void convertSvgToPng(markup, size.width, size.height).then((dataUrl) => {
        if (dataUrl) {
          post({ type: 'exportChartImage', dataUrl, name });
        } else {
          showToast('error', 'The chart could not be converted to PNG.');
        }
      });
    }
  });
}

/**
 * Applies the user's layout choices: chart height, detail pane width and the two
 * visibility switches. Everything is driven by state, so a resize or a toggle
 * only has to call this.
 */
function applyLayout(): void {
  const chartsEnabled = state.settings.enableCharts && Boolean(state.snapshot);
  const chartVisible = chartsEnabled && state.chartOpen;
  // The table can only be collapsed while the chart is there to take its place.
  const collapsed = state.view.tableCollapsed && chartVisible;

  elements.chartHost.hidden = !chartVisible;
  elements.splitChart.hidden = !chartVisible || collapsed;
  if (chartVisible && !collapsed) {
    elements.chartHost.style.flex = '0 0 auto';
    elements.chartHost.style.height = `${clampChartHeight(
      state.view.chartHeight ?? DEFAULT_CHART_HEIGHT,
      window.innerHeight
    )}px`;
  } else {
    // Without the table the chart is free to fill the whole canvas.
    elements.chartHost.style.flex = chartVisible ? '1 1 auto' : '';
    elements.chartHost.style.height = '';
  }
  elements.splitChart.title = strings().resizeChart;

  elements.grid.hidden = collapsed;
  // With the table gone there is nothing to select, so the details follow it.
  const showDetail = state.view.showValuePane && !collapsed;
  elements.side.hidden = !showDetail;
  elements.splitDetail.hidden = !showDetail;
  if (showDetail) {
    elements.side.style.flexBasis = `${clampDetailWidth(
      state.view.detailWidth ?? DEFAULT_DETAIL_WIDTH,
      window.innerWidth
    )}px`;
  } else {
    elements.side.style.flexBasis = '';
  }
  elements.splitDetail.title = strings().resizeDetail;
}

/** Wires the two drag handles that resize the chart and the detail pane. */
function attachSplitters(): void {
  drag(elements.splitChart, 'y', () => {
    state.view.chartHeight = clampChartHeight(
      state.view.chartHeight ?? DEFAULT_CHART_HEIGHT,
      window.innerHeight
    );
    return state.view.chartHeight;
  }, (start, delta) => {
    state.view.chartHeight = clampChartHeight(start + delta, window.innerHeight);
    applyLayout();
  });

  drag(elements.splitDetail, 'x', () => {
    state.view.detailWidth = clampDetailWidth(
      state.view.detailWidth ?? DEFAULT_DETAIL_WIDTH,
      window.innerWidth
    );
    return state.view.detailWidth;
  }, (start, delta) => {
    state.view.detailWidth = clampDetailWidth(start - delta, window.innerWidth);
    applyLayout();
  });

  window.addEventListener('resize', () => applyLayout());
}

function drag(
  handle: HTMLElement,
  axis: 'x' | 'y',
  current: () => number,
  apply: (start: number, delta: number) => void
): void {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    const startPosition = axis === 'y' ? event.clientY : event.clientX;
    const startValue = current();

    const onMove = (moveEvent: PointerEvent): void => {
      const position = axis === 'y' ? moveEvent.clientY : moveEvent.clientX;
      apply(startValue, position - startPosition);
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.classList.remove('is-dragging');
      persistViewState();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

/**
 * Boot placeholder. It lives inside the grid host so the toolbar, filter bar,
 * value pane and toast layer — all created by `bootstrap()` — survive: clearing
 * the root here detached them and the viewer stayed on the spinner forever.
 */
function renderEmpty(): void {
  if (placeholder) {
    return;
  }
  placeholder = el('div', { class: 'loading grid-placeholder' }, [
    el('div', { class: 'spinner' }),
    el('span', {}, [state.strings?.loading ?? 'Loading collection…'])
  ]);
  elements.grid.appendChild(placeholder);
}

function clearEmpty(): void {
  placeholder?.remove();
  placeholder = undefined;
}

function renderAll(): void {
  applyTheme();
  applyLayout();
  renderToolbar();
  renderFilterBar();
  renderGrid();
  renderValuePane();
  renderChart();
  renderStatus();
}

function applyTheme(): void {
  const kind = state.settings.theme === 'light' ? 'vscode-light' : state.settings.theme === 'dark' ? 'vscode-dark' : 'vscode-high-contrast';
  document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
  document.body.classList.add(kind);
}

function strings(): LocalizedStrings['toolbar'] {
  return (
    state.strings?.toolbar ?? {
      refresh: 'Refresh',
      filter: 'Filter',
      clearFilter: 'Clear filter',
      search: 'Search',
      columns: 'Columns',
      export: 'Export',
      chart: 'Show Chart',
      chartSettings: 'Series Settings',
      pin: 'Pin collection',
      settings: 'Settings',
      diagnostics: 'Diagnostics',
      copy: 'Copy',
      apply: 'Apply',
      cancel: 'Cancel',
      close: 'Close',
      pageSize: 'Page size',
      page: 'Page',
      of: 'of',
      rows: 'rows',
      clearAllFilters: 'Clear all filters',
      selectAll: 'Select all',
      clear: 'Clear',
      addToValues: 'Add value',
      include: 'Include',
      exclude: 'Exclude',
      regex: 'Regular expression',
      hideColumn: 'Hide column',
      showColumn: 'Show column',
      resetOrder: 'Reset column order',
      sortAscending: 'Sort ascending',
      sortDescending: 'Sort descending',
      clearSort: 'Clear sorting',
      valuePane: 'Value',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      loadFromDebugger: 'Load from debugger',
      chartType: 'Chart type',
      xAxis: 'X axis',
      yAxis: 'Y axis',
      group: 'Group by',
      aggregation: 'Aggregation',
      series: 'Series',
      none: 'None',
      mean: 'Mean',
      sum: 'Sum',
      min: 'Min',
      max: 'Max',
      count: 'Count',
      first: 'First',
      last: 'Last',
      exportPng: 'Export to PNG',
      empty: 'No rows to display',
      emptyHint: 'Adjust the filter or refresh the collection.',
      elapsed: 'Capture time',
      requests: 'Requests',
      strategy: 'Strategy',
      truncated: 'Truncated',
      filtered: 'Filtered',
      total: 'Total',
      error: 'Error',
      warning: 'Warning',
      showValuePane: 'Show value pane',
      hideValuePane: 'Hide value pane',
      hideTable: 'Hide the table',
      showTable: 'Show the table',
      resizeChart: 'Drag to change the height of the chart',
      resizeDetail: 'Drag to change the width of the details',
      activeFilter: 'Active filter',
      valueEmpty: 'Select a row to inspect its value.',
      filterBuilderTitle: 'Filter the whole collection',
      filterWholeCollection:
        'The condition is applied to every element, not only to the rows that were fetched.',
      addCondition: 'Add condition',
      removeCondition: 'Remove condition',
      filterColumn: 'Column',
      filterOperator: 'Operator',
      filterValue: 'Value',
      filterValueTo: 'to',
      matchAll: 'Match all',
      matchAny: 'Match any',
      valueRequired: 'Enter a value',
      filterOperators: {
        contains: 'contains',
        notContains: 'does not contain',
        equals: 'equals',
        notEquals: 'is not',
        startsWith: 'starts with',
        endsWith: 'ends with',
        regex: 'matches the regular expression',
        empty: 'is empty',
        notEmpty: 'is not empty',
        gt: 'greater than',
        gte: 'greater or equal',
        lt: 'less than',
        lte: 'less or equal',
        between: 'between',
        isTrue: 'is true',
        isFalse: 'is false',
        isNull: 'is null',
        isNotNull: 'is not null'
      },
      rowPosition: 'Position',
      copyCell: 'Copy cell',
      copyRow: 'Copy row',
      copyAll: 'Copy all rows',
      copied: 'Copied to clipboard'
    }
  );
}

function renderToolbar(): void {
  const t = strings();
  clear(elements.toolbar);
  const snapshot = state.snapshot;

  const title = el('div', { class: 'title-group' }, [
    el('span', { class: 'title-icon' }, [icon('table', 16)]),
    el('span', { class: 'title-text', title: snapshot?.expression ?? '' }, [snapshot?.title ?? '']),
    snapshot ? el('span', { class: 'title-provider' }, [state.providerName]) : null
  ]);
  elements.toolbar.appendChild(title);

  const actions = el('div', { class: 'toolbar-actions' });

  actions.appendChild(
    toolbarButton('refresh', t.refresh, () => post({ type: 'refresh' }), true)
  );

  actions.appendChild(
    toolbarButton('columns', t.columns, (event) => openColumnsPanel(event.currentTarget as HTMLElement), true)
  );

  if (state.settings.enableCharts) {
    const chartButton = toolbarButton(
      'chart',
      state.chartOpen ? t.chartSettings : t.chart,
      () => {
        state.chartOpen = !state.chartOpen;
        renderAll();
      },
      true
    );
    chartButton.classList.toggle('is-active', state.chartOpen);
    actions.appendChild(chartButton);
  }

  if (state.settings.enableCharts) {
    const tableButton = toolbarButton(
      'table',
      state.view.tableCollapsed ? t.showTable : t.hideTable,
      () => {
        state.view.tableCollapsed = !state.view.tableCollapsed;
        // Collapsing the table only makes sense while the chart is there to fill
        // the area, so the chart is opened when the table goes away.
        if (state.view.tableCollapsed) {
          state.chartOpen = true;
        }
        persistViewState();
        renderAll();
      },
      true
    );
    tableButton.classList.toggle('is-active', state.view.tableCollapsed);
    actions.appendChild(tableButton);
  }

  actions.appendChild(
    toolbarButton('export', t.export, (event) => openExportMenu(event.currentTarget as HTMLElement), true)
  );

  const detailButton = toolbarButton(
    'panel',
    state.view.showValuePane ? t.hideValuePane : t.showValuePane,
    () => toggleValuePane(!state.view.showValuePane)
  );
  detailButton.classList.toggle('is-active', state.view.showValuePane);
  actions.appendChild(detailButton);

  actions.appendChild(toolbarButton('pin', t.pin, () => post({ type: 'pin' })));
  actions.appendChild(toolbarButton('settings', t.settings, () => post({ type: 'openSettings' })));
  actions.appendChild(toolbarButton('info', t.diagnostics, () => post({ type: 'showDiagnostics' })));

  elements.toolbar.appendChild(actions);
}

/** Shows or hides the row detail pane. */
function toggleValuePane(visible: boolean): void {
  state.view.showValuePane = visible;
  persistViewState();
  renderAll();
}

function toolbarButton(
  iconName: Parameters<typeof icon>[0],
  label: string,
  action: (event: Event) => void,
  withLabel = false
): HTMLButtonElement {
  const button = el('button', {
    class: 'toolbar-button',
    type: 'button',
    title: label,
    ariaLabel: label
  });
  button.appendChild(icon(iconName, 16));
  if (withLabel) {
    button.appendChild(el('span', { class: 'toolbar-label' }, [label]));
  }
  button.addEventListener('click', action);
  return button;
}

/** Small remove button used by the chips in the filter bar. */
function chipCloseButton(label: string): HTMLButtonElement {
  const button = el('button', {
    class: 'chip-close',
    type: 'button',
    title: label,
    ariaLabel: label
  });
  button.appendChild(icon('close', 12));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    post({ type: 'clearFilter' });
  });
  return button;
}

/** Columns in the order the user arranged them, without the hidden ones. */
function currentColumns(): { column: ColumnDescriptor; index: number }[] {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return [];
  }
  return orderedColumns(snapshot.columns, state.view).filter(
    (entry) => !state.view.hiddenColumns.includes(entry.column.key)
  );
}

/**
 * The row of controls above the table: a free text search over the visible
 * columns, a removable chip for an active debugger side filter, and a way back
 * when column filters are hiding rows.
 */
function renderFilterBar(): void {
  const t = strings();
  const snapshot = state.snapshot;
  clear(elements.filterBar);
  elements.filterBar.hidden = !snapshot;

  const searchInput = el('input', {
    class: 'search-input',
    type: 'text',
    value: state.view.search,
    placeholder: t.search,
    ariaLabel: t.search
  });
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.view.search = searchInput.value;
      state.view.page = 0;
      persistViewState();
      renderGrid();
      renderStatus();
    }, 150);
  });
  elements.filterBar.appendChild(el('span', { class: 'search-icon' }, [icon('search', 14)]));
  elements.filterBar.appendChild(searchInput);

  // The search only looks at the fetched rows; this one filters the collection.
  const builderButton = el('button', {
    class: 'toolbar-button filter-builder-button',
    type: 'button',
    title: t.filterBuilderTitle,
    ariaLabel: t.filterBuilderTitle
  });
  builderButton.appendChild(icon('filter', 14));
  builderButton.appendChild(el('span', { class: 'toolbar-label' }, [t.filter]));
  builderButton.addEventListener('click', (event) => {
    openFilterBuilder(event.currentTarget as HTMLElement);
  });
  builderButton.classList.toggle('is-active', state.view.filter.trim().length > 0);
  elements.filterBar.appendChild(builderButton);

  const activeFilter = state.view.filter.trim();
  if (activeFilter.length > 0) {
    const chip = el('span', { class: 'filter-chip', title: `${t.activeFilter}: ${activeFilter}` }, [
      icon('filter', 12),
      el('code', {}, [activeFilter]),
      chipCloseButton(t.clearFilter)
    ]);
    elements.filterBar.appendChild(chip);
  }

  const hasColumnFilters = Object.keys(state.view.columnFilters).some((key) =>
    isColumnFilterActive(state.view.columnFilters[key])
  );
  if (hasColumnFilters) {
    const clearFilters = el('button', { class: 'link-button', type: 'button' }, [t.clearAllFilters]);
    clearFilters.addEventListener('click', () => {
      state.view.columnFilters = {};
      persistViewState();
      renderAll();
    });
    elements.filterBar.appendChild(clearFilters);
  }

  const hiddenColumns = state.view.hiddenColumns.length;
  if (hiddenColumns > 0) {
    const showAll = el('button', { class: 'link-button', type: 'button' }, [
      `${t.showColumn} (${hiddenColumns})`
    ]);
    showAll.addEventListener('click', () => {
      state.view.hiddenColumns = [];
      persistViewState();
      renderAll();
    });
    elements.filterBar.appendChild(showAll);
  }
}

/** Renders the visible page of rows into the grid. */
function renderGrid(): void {
  const snapshot = state.snapshot;
  const t = strings();
  if (!snapshot || !table) {
    renderEmpty();
    return;
  }
  clearEmpty();

  const pipeline = runPipeline(snapshot.rows, snapshot.columns, state.view);
  clampPage(state.view, pipeline.rows.length);
  const start = state.view.page * state.view.pageSize;
  const pageRows = pipeline.rows.slice(start, start + state.view.pageSize);
  const columns = currentColumns();

  table.strings = { filter: t.filter, copyCell: t.copyCell, copyRow: t.copyRow, copyAll: t.copyAll };
  table.render({
    columns: computeColumnWidths(columns, pageRows),
    rows: pageRows,
    sort: state.view.sort,
    columnFilters: state.view.columnFilters,
    pageOffset: start,
    selectedRow: state.selectedRow,
    selectedColumnKey: state.selectedColumnKey
  });
}

function renderStatus(): void {
  const t = strings();
  clear(elements.status);
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  const pipeline = runPipeline(snapshot.rows, snapshot.columns, state.view);
  const total = snapshot.totalItems ?? snapshot.rows.length;
  const start = state.view.page * state.view.pageSize;
  const shown = Math.min(state.view.pageSize, Math.max(0, pipeline.rows.length - start));

  elements.status.appendChild(
    el('span', { class: 'status-item' }, [
      `${formatCount(start + (shown > 0 ? 1 : 0))}–${formatCount(start + shown)} ${t.of} ${formatCount(
        pipeline.rows.length
      )} ${t.rows}`
    ])
  );
  if (state.filterInfo) {
    elements.status.appendChild(
      el('span', { class: 'status-item' }, [
        `${t.filtered}: ${state.filterInfo.location === 'debugger' ? 'debugger' : 'client'}`
      ])
    );
  }
  if (snapshot.truncated && total !== snapshot.rows.length) {
    // The tooltip names the reason: maxRows, or an adapter that handed over less
    // than it declared.
    elements.status.appendChild(
      el('span', { class: 'status-item is-warning', title: snapshot.warnings.join('\n') }, [
        `${t.truncated}: ${formatCount(total)} ${t.total.toLowerCase()}`
      ])
    );
  }
  elements.status.appendChild(
    el('span', { class: 'status-item' }, [`${t.elapsed}: ${snapshot.diagnostics.durationMs} ms`])
  );
  elements.status.appendChild(
    el('span', { class: 'status-item' }, [`${t.requests}: ${formatCount(snapshot.diagnostics.requests)}`])
  );
  elements.status.appendChild(
    el('span', { class: 'status-item' }, [`${t.strategy}: ${snapshot.diagnostics.strategy}`])
  );

  const pager = el('div', { class: 'pager' });
  const pageCount = Math.max(1, Math.ceil(pipeline.rows.length / state.view.pageSize));
  const previous = el('button', { class: 'icon-button', type: 'button', title: 'Previous page' }, [
    icon('chevronRight', 14)
  ]);
  previous.classList.add('rotate-180');
  previous.disabled = state.view.page <= 0;
  previous.addEventListener('click', () => {
    state.view.page = Math.max(0, state.view.page - 1);
    persistViewState();
    renderAll();
  });

  const next = el('button', { class: 'icon-button', type: 'button', title: 'Next page' }, [
    icon('chevronRight', 14)
  ]);
  next.disabled = state.view.page >= pageCount - 1;
  next.addEventListener('click', () => {
    state.view.page = Math.min(pageCount - 1, state.view.page + 1);
    persistViewState();
    renderAll();
  });

  pager.appendChild(previous);
  pager.appendChild(
    el('span', { class: 'pager-label' }, [`${state.view.page + 1} / ${pageCount}`])
  );
  pager.appendChild(next);

  const pageSizeSelect = el('select', { class: 'page-size', title: t.pageSize, ariaLabel: t.pageSize });
  const allOption = `All (${formatCount(pipeline.rows.length)})`;
  for (const size of PAGE_SIZES) {
    pageSizeSelect.appendChild(
      el('option', { value: String(size), selected: size === state.view.pageSize }, [String(size)])
    );
  }
  // When the page is not one of the presets - the "show everything" choice, for
  // example - it gets an option of its own so the control never lies.
  if (!PAGE_SIZES.includes(state.view.pageSize)) {
    pageSizeSelect.appendChild(
      el('option', { value: String(state.view.pageSize), selected: true }, [
        state.view.pageSize === pipeline.rows.length ? allOption : formatCount(state.view.pageSize)
      ])
    );
  }
  pageSizeSelect.appendChild(el('option', { value: ALL_ROWS }, [allOption]));
  pageSizeSelect.addEventListener('change', () => {
    const chosen = pageSizeSelect.value;
    state.view.pageSize = chosen === ALL_ROWS ? Math.max(1, pipeline.rows.length) : Number(chosen) || 100;
    state.view.page = 0;
    persistViewState();
    // Re-rendering straight away would pull the select out from under its own
    // native dropdown, so the redraw waits for the browser to finish the choice.
    window.setTimeout(() => renderAll(), 0);
  });
  pager.appendChild(pageSizeSelect);

  elements.status.appendChild(pager);
  if (state.filterInfo && state.filterInfo.warnings.length > 0) {
    elements.status.appendChild(
      el('span', { class: 'status-item is-warning', title: state.filterInfo.warnings.join('\n') }, [
        `${t.warning}: ${state.filterInfo.warnings[0]}`
      ])
    );
  }
}

function renderValuePane(): void {
  const snapshot = state.snapshot;
  if (!valuePane) {
    return;
  }
  const t = strings();
  valuePane.strings = {
    valuePane: t.valuePane,
    expandAll: t.expandAll,
    collapseAll: t.collapseAll,
    loadFromDebugger: t.loadFromDebugger,
    copy: t.copy,
    empty: t.valueEmpty,
    closePane: t.hideValuePane
  };
  valuePane.onClose = () => toggleValuePane(false);
  if (!snapshot || state.selectedRow === null) {
    valuePane.show([], undefined);
    return;
  }
  const pipeline = runPipeline(snapshot.rows, snapshot.columns, state.view);
  const start = state.view.page * state.view.pageSize;
  const row = pipeline.rows[start + state.selectedRow];
  valuePane.show(snapshot.columns, row);
  valuePane.focus(snapshot.columns, state.selectedColumnKey);
}

function renderChart(): void {
  elements.chartHost.hidden = !state.chartOpen || !state.settings.enableCharts;
  const snapshot = state.snapshot;
  if (!state.chartOpen || !snapshot || !chartView) {
    return;
  }
  const t = strings();
  const labels: ChartLabels = {
    settings: t.chartSettings,
    chartType: t.chartType,
    xAxis: t.xAxis,
    yAxis: t.yAxis,
    group: t.group,
    series: t.series,
    aggregation: t.aggregation,
    exportPng: t.exportPng,
    none: t.none,
    mean: t.mean,
    sum: t.sum,
    min: t.min,
    max: t.max,
    count: t.count,
    first: t.first,
    last: t.last,
    types: state.strings?.chartTypes ?? {
      bar: 'Bar Chart',
      pie: 'Pie Chart',
      area: 'Area Chart',
      line: 'Line Chart',
      scatter: 'Scatter Chart',
      bubble: 'Bubble Chart',
      stock: 'Stock Chart',
      areaRange: 'AreaRange Chart',
      histogram: 'Histogram Chart'
    }
  };
  const pipeline = runPipeline(snapshot.rows, snapshot.columns, state.view);
  chartView.render({
    state: state.chart,
    columns: snapshot.columns,
    rows: pipeline.rows,
    labels,
    title: snapshot.title,
    interactive: true
  });
}

function renderOverlay(message?: string): void {
  clear(elements.overlay);
  elements.overlay.hidden = !state.busy;
  if (state.busy) {
    elements.overlay.appendChild(el('div', { class: 'spinner' }));
    elements.overlay.appendChild(el('span', {}, [message ?? '…']));
  }
}

function showToast(level: 'info' | 'warn' | 'error', message: string): void {
  const toast = el('div', { class: `toast toast-${level}` }, [
    icon(level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info', 14),
    el('span', {}, [message])
  ]);
  elements.toasts.appendChild(toast);
  window.setTimeout(() => toast.classList.add('is-visible'), 10);
  window.setTimeout(() => {
    toast.classList.remove('is-visible');
    window.setTimeout(() => toast.remove(), 200);
  }, 4200);
}

function persistViewState(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    post({ type: 'saveViewState', viewState: state.view });
  }, 400);
}

function closePopovers(): void {
  for (const node of document.querySelectorAll('.popover')) {
    node.remove();
  }
}

function openPopover(anchor: HTMLElement, content: HTMLElement, width = 260): void {
  closePopovers();
  const popover = el('div', { class: 'popover' });
  popover.appendChild(content);
  document.body.appendChild(popover);
  const bounds = anchor.getBoundingClientRect();
  const left = Math.min(bounds.left, window.innerWidth - width - 12);
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${bounds.bottom + 6}px`;
  popover.style.width = `${width}px`;

  const onDocumentClick = (event: MouseEvent): void => {
    if (!popover.contains(event.target as Node) && event.target !== anchor) {
      popover.remove();
      document.removeEventListener('mousedown', onDocumentClick, true);
    }
  };
  window.setTimeout(() => document.addEventListener('mousedown', onDocumentClick, true), 0);
}

function openColumnFilterPopover(column: ColumnDescriptor, anchor: HTMLElement): void {
  const t = strings();
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  const current = state.view.columnFilters[column.key] ?? emptyColumnFilter();
  const draft: ColumnFilterState = { ...current, values: [...current.values] };

  const content = el('div', { class: 'popover-body' });
  content.appendChild(el('div', { class: 'popover-title' }, [column.key]));

  const modeRow = el('div', { class: 'radio-row' });
  // Both radios share a name, which is what makes them exclusive: without it the
  // browser lets both stay checked and a second click cannot undo the first.
  const modeGroup = `ec-mode-${column.key}`;
  const includeInput = el('input', {
    type: 'radio',
    name: modeGroup,
    checked: draft.mode === 'include'
  });
  const excludeInput = el('input', {
    type: 'radio',
    name: modeGroup,
    checked: draft.mode === 'exclude'
  });
  const includeOption = el('label', {}, [includeInput, el('span', {}, [t.include])]);
  const excludeOption = el('label', {}, [excludeInput, el('span', {}, [t.exclude])]);
  includeInput.addEventListener('change', () => {
    draft.mode = 'include';
  });
  excludeInput.addEventListener('change', () => {
    draft.mode = 'exclude';
  });
  modeRow.appendChild(includeOption);
  modeRow.appendChild(excludeOption);
  content.appendChild(modeRow);

  // The value box and the regular expression switch share one compact row: the
  // popover is a small utility panel, not a form.
  const textInput = el('input', {
    class: 'popover-input',
    type: 'text',
    value: draft.text,
    placeholder: t.search,
    ariaLabel: t.filter
  });
  textInput.addEventListener('input', () => {
    draft.text = textInput.value;
  });
  const regexInput = el('input', { type: 'checkbox', id: 'ec-regex', checked: draft.regex });
  regexInput.addEventListener('change', () => {
    draft.regex = regexInput.checked;
  });
  content.appendChild(
    el('div', { class: 'popover-row' }, [
      textInput,
      el('label', { class: 'popover-toggle', title: t.regex, htmlFor: 'ec-regex' }, [
        regexInput,
        el('span', {}, ['/.*/'])
      ])
    ])
  );

  const index = snapshot.columns.findIndex((candidate) => candidate.key === column.key);
  const values = distinctValues(snapshot.rows, index, 1000);
  const valueSearch = el('input', {
    class: 'popover-input popover-search',
    type: 'text',
    placeholder: t.search,
    ariaLabel: t.search
  });
  content.appendChild(valueSearch);
  const list = el('div', { class: 'value-list' });
  const checkboxes = new Map<string, HTMLInputElement>();

  const buildList = (query: string): void => {
    clear(list);
    checkboxes.clear();
    const lowered = query.trim().toLowerCase();
    for (const value of values) {
      if (lowered.length > 0 && !value.toLowerCase().includes(lowered)) {
        continue;
      }
      const selected = draft.values.includes(value);
      const checkbox = el('input', { type: 'checkbox', checked: selected });
      checkboxes.set(value, checkbox);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (!draft.values.includes(value)) {
            draft.values.push(value);
          }
        } else {
          draft.values = draft.values.filter((entry) => entry !== value);
        }
      });
      list.appendChild(
        el('label', { class: 'value-item' }, [checkbox, el('span', { title: value }, [value || '(empty)'])])
      );
    }
    if (values.length === 0) {
      list.appendChild(el('div', { class: 'empty-hint' }, [t.empty]));
    }
  };
  buildList('');
  valueSearch.addEventListener('input', () => buildList(valueSearch.value));
  content.appendChild(list);

  const actions = el('div', { class: 'popover-actions' });
  const selectAll = el('button', { class: 'link-button', type: 'button' }, [t.selectAll]);
  selectAll.addEventListener('click', () => {
    for (const [value, checkbox] of checkboxes) {
      checkbox.checked = true;
      if (!draft.values.includes(value)) {
        draft.values.push(value);
      }
    }
  });
  const clearValues = el('button', { class: 'link-button', type: 'button' }, [t.clear]);
  clearValues.addEventListener('click', () => {
    draft.values = [];
    for (const checkbox of checkboxes.values()) {
      checkbox.checked = false;
    }
  });
  actions.appendChild(selectAll);
  actions.appendChild(clearValues);
  content.appendChild(actions);

  const buttons = el('div', { class: 'popover-buttons' });
  const applyButton = el('button', { class: 'primary-button', type: 'button' }, [t.apply]);
  applyButton.addEventListener('click', () => {
    if (isColumnFilterActive(draft)) {
      state.view.columnFilters[column.key] = draft;
    } else {
      delete state.view.columnFilters[column.key];
    }
    state.view.page = 0;
    persistViewState();
    closePopovers();
    renderAll();
  });
  const cancelButton = el('button', { class: 'secondary-button', type: 'button' }, [t.cancel]);
  cancelButton.addEventListener('click', () => closePopovers());
  const clearButton = el('button', { class: 'secondary-button', type: 'button' }, [t.clearFilter]);
  clearButton.addEventListener('click', () => {
    delete state.view.columnFilters[column.key];
    persistViewState();
    closePopovers();
    renderAll();
  });
  buttons.appendChild(clearButton);
  buttons.appendChild(cancelButton);
  buttons.appendChild(applyButton);
  content.appendChild(buttons);

  openPopover(anchor, content, 248);
}

/** Opens the whole collection filter builder next to the button that owns it. */
function openFilterBuilder(anchor: HTMLElement): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  const t = strings();
  const labels: FilterBuilderStrings = {
    title: t.filterBuilderTitle,
    addCondition: t.addCondition,
    removeCondition: t.removeCondition,
    column: t.filterColumn,
    operator: t.filterOperator,
    value: t.filterValue,
    valueTo: t.filterValueTo,
    matchAll: t.matchAll,
    matchAny: t.matchAny,
    apply: t.apply,
    clear: t.clear,
    cancel: t.cancel,
    valueRequired: t.valueRequired,
    wholeCollection: t.filterWholeCollection,
    partialHint: state.filterInfo
      ? state.filterInfo.location === 'debugger'
        ? ''
        : state.filterInfo.warnings[0] ?? ''
      : '',
    operators: t.filterOperators as FilterBuilderStrings['operators']
  };

  renderFilterBuilder({
    columns: snapshot.columns,
    parsed: conditionsFromText(state.view.filter, snapshot.columns),
    strings: labels,
    anchor,
    openPopover,
    closePopovers,
    callbacks: {
      onApply: (text) => {
        state.view.filter = text;
        state.view.page = 0;
        persistViewState();
        post({ type: 'applyFilter', text });
        renderAll();
      }
    }
  });
}

function openColumnsPanel(anchor: HTMLElement): void {
  const t = strings();
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  const content = el('div', { class: 'popover-body' });
  content.appendChild(el('div', { class: 'popover-title' }, [t.columns]));

  for (const column of snapshot.columns) {
    if (column.key === '#') {
      continue;
    }
    const visible = !state.view.hiddenColumns.includes(column.key);
    const checkbox = el('input', { type: 'checkbox', checked: visible });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.view.hiddenColumns = state.view.hiddenColumns.filter((key) => key !== column.key);
      } else if (!state.view.hiddenColumns.includes(column.key)) {
        state.view.hiddenColumns.push(column.key);
      }
      persistViewState();
      renderAll();
    });
    content.appendChild(
      el('label', { class: 'value-item' }, [
        checkbox,
        el('span', { title: column.key }, [column.title]),
        el('span', { class: 'column-kind' }, [column.nested ? `${column.kind} · nested` : column.kind])
      ])
    );
  }

  const buttons = el('div', { class: 'popover-buttons' });
  const reset = el('button', { class: 'secondary-button', type: 'button' }, [t.resetOrder]);
  reset.addEventListener('click', () => {
    state.view.columnOrder = null;
    state.view.hiddenColumns = [];
    persistViewState();
    closePopovers();
    renderAll();
  });
  buttons.appendChild(reset);
  content.appendChild(buttons);

  openPopover(anchor, content, 300);
}

function openExportMenu(anchor: HTMLElement): void {
  const t = strings();
  const content = el('div', { class: 'popover-body' });
  content.appendChild(el('div', { class: 'popover-title' }, [t.export]));

  let scope: 'filtered' | 'all' = 'filtered';
  const scopeRow = el('div', { class: 'radio-row' });
  const filteredLabel = el('label', {}, [
    el('input', { type: 'radio', checked: true }),
    el('span', {}, [t.filtered])
  ]);
  const allLabel = el('label', {}, [el('input', { type: 'radio' }), el('span', {}, ['All'])]);
  (filteredLabel.querySelector('input') as HTMLInputElement).addEventListener('change', () => {
    scope = 'filtered';
  });
  (allLabel.querySelector('input') as HTMLInputElement).addEventListener('change', () => {
    scope = 'all';
  });
  scopeRow.appendChild(filteredLabel);
  scopeRow.appendChild(allLabel);
  content.appendChild(scopeRow);

  const formats: { format: 'csv' | 'json' | 'xlsx' | 'xml'; label: string }[] = [
    { format: 'csv', label: 'CSV' },
    { format: 'json', label: 'JSON' },
    { format: 'xlsx', label: 'Excel (XLSX)' },
    { format: 'xml', label: 'XML' }
  ];

  const exportRows = (format: 'csv' | 'json' | 'xlsx' | 'xml', pageOnly: boolean): void => {
    const columns = currentColumns().map((entry) => entry.column.key);
    if (pageOnly) {
      const indices: number[] = [];
      const count = state.snapshot
        ? Math.min(
            state.view.pageSize,
            runPipeline(state.snapshot.rows, state.snapshot.columns, state.view).rows
              .length -
              state.view.page * state.view.pageSize
          )
        : 0;
      for (let index = 0; index < Math.max(0, count); index += 1) {
        indices.push(state.view.page * state.view.pageSize + index);
      }
      post({ type: 'export', format, scope, columns, rowIndices: indices });
      return;
    }
    post({ type: 'export', format, scope, columns });
  };

  for (const entry of formats) {
    const button = el('button', { class: 'export-item', type: 'button' }, [entry.label]);
    button.addEventListener('click', () => {
      closePopovers();
      exportRows(entry.format, false);
    });
    content.appendChild(button);
  }

  const pageButton = el('button', { class: 'export-item', type: 'button' }, [
    `${t.page} → CSV`
  ]);
  pageButton.addEventListener('click', () => {
    closePopovers();
    exportRows('csv', true);
  });
  content.appendChild(pageButton);

  openPopover(anchor, content, 240);
}

/** Reads the pixel size an SVG declares, used to rasterize the chart. */
function parseSvgSize(svgMarkup: string): { width: number; height: number } {
  const width = /width="(\d+(?:\.\d+)?)"/.exec(svgMarkup);
  const height = /height="(\d+(?:\.\d+)?)"/.exec(svgMarkup);
  return {
    width: Math.max(200, Math.round(Number(width?.[1] ?? 720))),
    height: Math.max(160, Math.round(Number(height?.[1] ?? 360)))
  };
}

/** Rasterizes an SVG document into a PNG data URL. */
function convertSvgToPng(svgMarkup: string, width: number, height: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(undefined);
          return;
        }
        context.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(undefined);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
    image.src = url;
  });
}

async function runCommand(command: string): Promise<void> {
  switch (command) {
    case 'refresh':
      post({ type: 'refresh' });
      return;
    case 'chart':
      state.chartOpen = true;
      renderAll();
      return;
    case 'copy': {
      if (!state.snapshot) {
        return;
      }
      const pipeline = runPipeline(state.snapshot.rows, state.snapshot.columns, state.view);
      const columns = currentColumns();
      const lines = [columns.map((entry) => entry.column.title).join('\t')];
      for (const row of pipeline.rows) {
        lines.push(columns.map((entry) => row.cells[entry.index]?.text ?? '').join('\t'));
      }
      post({ type: 'copy', text: lines.join('\n'), label: strings().rows });
      return;
    }
    default:
      return;
  }
}

bootstrap();
