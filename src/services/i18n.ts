import * as vscode from 'vscode';
import type { LocalizedStrings } from '../webview/protocol';

/**
 * Localization entry point.
 *
 * The runtime bundle (`l10n/bundle.l10n.<locale>.json`) is produced from the
 * English strings used here, so English is the source of truth and every other
 * language is a translation of the same keys.
 */
function t(message: string, ...args: unknown[]): string {
  return args.length === 0 ? vscode.l10n.t(message) : vscode.l10n.t(message, ...args.map(String));
}

export function localize(message: string, ...args: unknown[]): string {
  return t(message, ...args);
}

/** Builds the string table for the collection view webview. */
export function localizeWebviewStrings(): LocalizedStrings {
  return {
    appTitle: t('Collection View'),
    loading: t('Loading collection…'),
    toolbar: {
      refresh: t('Refresh'),
      filter: t('Filter'),
      clearFilter: t('Clear filter'),
      search: t('Search'),
      columns: t('Columns'),
      export: t('Export'),
      chart: t('Show Chart'),
      chartSettings: t('Series Settings'),
      pin: t('Pin collection'),
      settings: t('Extension settings'),
      diagnostics: t('Diagnostics'),
      copy: t('Copy'),
      apply: t('Apply'),
      cancel: t('Cancel'),
      close: t('Close'),
      pageSize: t('Page size'),
      page: t('Page'),
      of: t('of'),
      rows: t('rows'),
      clearAllFilters: t('Clear all filters'),
      selectAll: t('Select all'),
      clear: t('Clear'),
      addToValues: t('Add value'),
      include: t('Include'),
      exclude: t('Exclude'),
      regex: t('Regular expression'),
      hideColumn: t('Hide column'),
      showColumn: t('Show column'),
      resetOrder: t('Reset column order'),
      sortAscending: t('Sort ascending'),
      sortDescending: t('Sort descending'),
      clearSort: t('Clear sorting'),
      valuePane: t('Value'),
      expandAll: t('Expand all'),
      collapseAll: t('Collapse all'),
      loadFromDebugger: t('Load from debugger'),
      chartType: t('Chart type'),
      xAxis: t('X axis'),
      yAxis: t('Y axis'),
      group: t('Group by'),
      aggregation: t('Aggregation'),
      series: t('Series'),
      none: t('None'),
      mean: t('Mean'),
      sum: t('Sum'),
      min: t('Min'),
      max: t('Max'),
      count: t('Count'),
      first: t('First'),
      last: t('Last'),
      exportPng: t('Export to PNG'),
      empty: t('No rows to display'),
      emptyHint: t('Adjust the filter or refresh the collection.'),
      elapsed: t('Capture time'),
      requests: t('Debugger requests'),
      strategy: t('Retrieval strategy'),
      truncated: t('Truncated'),
      filtered: t('Filtered'),
      total: t('Total'),
      error: t('Error'),
      warning: t('Warning'),
      showValuePane: t('Show value pane'),
      hideValuePane: t('Hide value pane'),
      hideTable: t('Hide the table'),
      showTable: t('Show the table'),
      resizeChart: t('Drag to change the height of the chart'),
      resizeDetail: t('Drag to change the width of the details'),
      activeFilter: t('Active filter'),
      valueEmpty: t('Select a row to inspect its value.'),
      filterBuilderTitle: t('Filter rows with a condition'),
      filterWholeCollection: t('The condition is applied to every fetched row. When the collection did not fit the window, only that window can match.'),
      addCondition: t('Add condition'),
      removeCondition: t('Remove condition'),
      filterColumn: t('Column'),
      filterOperator: t('Operator'),
      filterValue: t('Value'),
      filterValueTo: t('to'),
      filterOperators: {
        contains: t('contains'),
        notContains: t('does not contain'),
        equals: t('equals'),
        notEquals: t('is not'),
        startsWith: t('starts with'),
        endsWith: t('ends with'),
        regex: t('matches the regular expression'),
        empty: t('is empty'),
        notEmpty: t('is not empty'),
        gt: t('greater than'),
        gte: t('greater or equal'),
        lt: t('less than'),
        lte: t('less or equal'),
        between: t('between'),
        isTrue: t('is true'),
        isFalse: t('is false'),
        isNull: t('is null'),
        isNotNull: t('is not null')
      },
      rowPosition: t('Position'),
      copyCell: t('Copy cell'),
      copyRow: t('Copy row'),
      copyAll: t('Copy all rows'),
      copied: t('Copied to clipboard')
    },
    chartTypes: {
      bar: t('Bar Chart'),
      pie: t('Pie Chart'),
      area: t('Area Chart'),
      line: t('Line Chart'),
      scatter: t('Scatter Chart'),
      bubble: t('Bubble Chart'),
      stock: t('Stock Chart'),
      areaRange: t('AreaRange Chart'),
      histogram: t('Histogram Chart')
    }
  };
}
