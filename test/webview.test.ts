import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampChartHeight,
  clampDetailWidth,
  clampPage,
  compareCells,
  DEFAULT_CHART_HEIGHT,
  DEFAULT_DETAIL_WIDTH,
  distinctValues,
  emptyColumnFilter,
  isColumnFilterActive,
  orderedColumns,
  pageRows,
  runPipeline
} from '../webview/state';
import { computeColumnWidths } from '../webview/table';
import { buildChartModel, createDefaultChartState, type ChartState } from '../webview/charts';
import { buildRowTree } from '../webview/valuePane';
import { formatCount } from '../webview/dom';
import {
  createDefaultViewState,
  type ColumnFilterState,
  type ViewState
} from '../src/webview/protocol';
import type { CellValue, ColumnDescriptor, ColumnKind, RowDescriptor } from '../src/model/types';

function cell(text: string, kind: ColumnKind = 'string'): CellValue {
  return { text, kind, isNull: false, expandable: false };
}

const columns: ColumnDescriptor[] = [
  { key: '#', title: '#', kind: 'index', path: [], nested: false },
  { key: 'City', title: 'City', kind: 'string', path: ['City'], nested: false },
  { key: 'DegreeCelsius', title: 'DegreeCelsius', kind: 'number', path: ['DegreeCelsius'], nested: false },
  { key: 'Feels', title: 'Feels', kind: 'string', path: ['Feels'], nested: false }
];

const rows: RowDescriptor[] = [
  { index: 0, label: '[0]', cells: [cell('0', 'index'), cell('Seoul'), cell('21', 'number'), cell('normal')] },
  { index: 1, label: '[1]', cells: [cell('1', 'index'), cell('Sofia'), cell('24', 'number'), cell('warm')] },
  { index: 2, label: '[2]', cells: [cell('2', 'index'), cell('Lima'), cell('19', 'number'), cell('cold')] },
  { index: 3, label: '[3]', cells: [cell('3', 'index'), cell('Houston'), cell('31', 'number'), cell('hot')] },
  {
    index: 4,
    label: '[4]',
    cells: [cell('4', 'index'), cell('Seoul'), cell('9', 'number'), cell('cold')]
  }
];

function viewWith(overrides: Partial<ViewState> = {}): ViewState {
  return { ...createDefaultViewState(100), ...overrides };
}

function filterWith(overrides: Partial<ColumnFilterState> = {}): ColumnFilterState {
  return { ...emptyColumnFilter(), ...overrides };
}

describe('the client side view pipeline', () => {
  it('passes every row through when nothing is configured', () => {
    const outcome = runPipeline(rows, columns, viewWith());

    assert.equal(outcome.total, rows.length);
    assert.equal(outcome.rows.length, rows.length);
    assert.equal(outcome.afterColumnFilters, rows.length);
    assert.equal(outcome.afterSearch, rows.length);
  });

  it('searches across every visible column case insensitively', () => {
    const outcome = runPipeline(rows, columns, viewWith({ search: 'cold' }));

    assert.equal(outcome.rows.length, 2);
    assert.deepEqual(
      outcome.rows.map((row) => row.cells[1]!.text),
      ['Lima', 'Seoul']
    );
  });

  it('does not search inside hidden columns', () => {
    const outcome = runPipeline(rows, columns, viewWith({ search: 'cold', hiddenColumns: ['Feels'] }));

    assert.equal(outcome.rows.length, 0);
  });

  it('applies an include filter on selected values', () => {
    const view = viewWith({ columnFilters: { City: filterWith({ values: ['Seoul'] }) } });
    const outcome = runPipeline(rows, columns, view);

    assert.equal(outcome.afterColumnFilters, 2);
    for (const row of outcome.rows) {
      assert.equal(row.cells[1]!.text, 'Seoul');
    }
  });

  it('applies an exclude filter on selected values', () => {
    const view = viewWith({
      columnFilters: { City: filterWith({ values: ['seoul'], mode: 'exclude' }) }
    });
    const outcome = runPipeline(rows, columns, view);

    assert.equal(outcome.rows.length, 3);
    for (const row of outcome.rows) {
      assert.notEqual(row.cells[1]!.text, 'Seoul');
    }
  });

  it('combines a contains filter with a selected value', () => {
    const view = viewWith({
      columnFilters: { City: filterWith({ values: ['Seoul'], text: 'e' }) }
    });
    const outcome = runPipeline(rows, columns, view);

    assert.equal(outcome.rows.length, 2);
  });

  it('supports a per column regular expression', () => {
    const view = viewWith({
      columnFilters: { City: filterWith({ text: '^S(eo|of)', regex: true }) }
    });
    const outcome = runPipeline(rows, columns, view);

    assert.deepEqual(
      outcome.rows.map((row) => row.cells[1]!.text),
      ['Seoul', 'Sofia', 'Seoul']
    );
  });

  it('treats an invalid regular expression as no match', () => {
    const view = viewWith({ columnFilters: { City: filterWith({ text: '([', regex: true }) } });
    const outcome = runPipeline(rows, columns, view);

    assert.equal(outcome.rows.length, 0);
  });

  it('sorts numbers numerically and strings alphabetically', () => {
    const ascending = runPipeline(rows, columns, viewWith({ sort: { columnKey: 'DegreeCelsius', direction: 'asc' } }));
    assert.deepEqual(
      ascending.rows.map((row) => Number(row.cells[2]!.text)),
      [9, 19, 21, 24, 31]
    );

    const descending = runPipeline(rows, columns, viewWith({ sort: { columnKey: 'City', direction: 'desc' } }));
    assert.deepEqual(
      descending.rows.map((row) => row.cells[1]!.text),
      ['Sofia', 'Seoul', 'Seoul', 'Lima', 'Houston']
    );
  });

  it('never mutates the input rows', () => {
    const snapshot = rows.map((row) => row.cells.map((entry) => entry.text));

    runPipeline(rows, columns, viewWith({ sort: { columnKey: 'City', direction: 'asc' } }));

    assert.deepEqual(
      rows.map((row) => row.cells.map((entry) => entry.text)),
      snapshot
    );
  });

  it('reports the counts of every stage', () => {
    const view = viewWith({
      search: 'e',
      columnFilters: { City: filterWith({ values: ['Seoul'], }) }
    });
    const outcome = runPipeline(rows, columns, view);

    assert.equal(outcome.total, 5);
    assert.equal(outcome.afterColumnFilters, 2);
    assert.equal(outcome.afterSearch, 2);
  });
});

describe('cell comparison', () => {
  it('orders numbers numerically and text naturally', () => {
    assert.ok(compareCells(cell('9', 'number'), cell('10', 'number'), 'number') < 0);
    // Strings are compared with numeric awareness, so '2' precedes '10'.
    assert.ok(compareCells(cell('2'), cell('10'), 'string') < 0);
    assert.ok(compareCells(cell('apple'), cell('Banana'), 'string') < 0);
    assert.equal(compareCells(cell('same'), cell('same'), 'string'), 0);
  });

  it('sorts empty cells last in both directions', () => {
    assert.ok(compareCells(cell(''), cell('a'), 'string') > 0);
    assert.ok(compareCells(undefined, cell('a'), 'string') > 0);
    assert.equal(compareCells(cell(''), cell(''), 'string'), 0);
    // A non numeric value in a numeric column degrades to a text comparison.
    assert.ok(compareCells(cell('7', 'number'), cell('NaN', 'number'), 'number') < 0);
  });

  it('compares dates chronologically', () => {
    const left = cell('2024-01-02T00:00:00Z', 'date');
    const right = cell('2024-01-10T00:00:00Z', 'date');
    assert.ok(compareCells(left, right, 'date') < 0);
  });
});

describe('column filters helpers', () => {
  it('detects an active filter', () => {
    assert.equal(isColumnFilterActive(undefined), false);
    assert.equal(isColumnFilterActive(emptyColumnFilter()), false);
    assert.equal(isColumnFilterActive(filterWith({ text: '  ' })), false);
    assert.equal(isColumnFilterActive(filterWith({ text: 'x' })), true);
    assert.equal(isColumnFilterActive(filterWith({ values: ['a'] })), true);
  });

  it('collects the distinct values of a column without duplicates', () => {
    assert.deepEqual(distinctValues(rows, 1), ['Houston', 'Lima', 'Seoul', 'Sofia']);
  });

  it('caps the distinct values', () => {
    assert.equal(distinctValues(rows, 1, 2).length, 2);
    assert.deepEqual(distinctValues(rows, 9), []);
  });

  it('reorders the columns without losing any', () => {
    const reordered = orderedColumns(columns, viewWith({ columnOrder: ['Feels', 'City'] }));

    assert.deepEqual(
      reordered.map((entry) => entry.column.key),
      // Columns named by the user come first, the rest keep their original order.
      ['Feels', 'City', '#', 'DegreeCelsius']
    );
    assert.deepEqual(
      reordered.map((entry) => entry.index),
      [3, 1, 0, 2],
      'the original indices travel with the columns'
    );
    assert.equal(orderedColumns(columns, viewWith()).length, columns.length);
  });
});

describe('layout geometry', () => {
  it('keeps the chart inside the bounds that leave the table usable', () => {
    assert.equal(clampChartHeight(320, 900), 320);
    assert.equal(clampChartHeight(10, 900), 140, 'a chart shorter than the minimum snaps up');
    assert.equal(clampChartHeight(2000, 900), 720, 'the table keeps at least 140px');
    assert.equal(clampChartHeight(Number.NaN, 900), DEFAULT_CHART_HEIGHT);
  });

  it('adapts the chart bounds to a short window', () => {
    const height = clampChartHeight(600, 400);

    assert.ok(height <= 400, `the chart may not exceed the view, got ${height}`);
    assert.ok(height >= 140);
  });

  it('keeps the detail pane inside the bounds that leave the table usable', () => {
    assert.equal(clampDetailWidth(340, 1400), 340);
    assert.equal(clampDetailWidth(40, 1400), 220, 'the pane has a minimum width');
    assert.equal(clampDetailWidth(2000, 1400), 840, 'the table keeps at least 320px');
    assert.equal(clampDetailWidth(Number.NaN, 1400), DEFAULT_DETAIL_WIDTH);
  });

  it('narrows the detail pane before it eats a small view', () => {
    const width = clampDetailWidth(600, 700);

    assert.ok(width <= 420, `the table must keep room, got ${width}`);
    assert.ok(width >= 220);
  });
});

describe('pagination', () => {
  it('computes the visible window', () => {
    const view = viewWith({ page: 1, pageSize: 2 });
    const page = pageRows(rows, view);

    assert.equal(page.offset, 2);
    assert.deepEqual(
      page.rows.map((row) => row.index),
      [2, 3]
    );
  });

  it('returns everything when virtual scrolling is on', () => {
    const page = pageRows(rows, viewWith({ page: 3, pageSize: 2 }), true);

    assert.equal(page.rows.length, rows.length);
    assert.equal(page.offset, 0);
  });

  it('clamps a page that no longer exists', () => {
    const view = viewWith({ page: 9, pageSize: 2 });
    assert.equal(clampPage(view, rows.length), true);
    assert.equal(view.page, 2);
  });

  it('does not clamp when the page is valid', () => {
    const view = viewWith({ page: 1, pageSize: 2 });
    assert.equal(clampPage(view, rows.length), false);
    assert.equal(view.page, 1);
  });

  it('handles an empty row set', () => {
    const view = viewWith({ page: 3, pageSize: 50 });
    assert.equal(clampPage(view, 0), true);
    assert.equal(view.page, 0);
    assert.deepEqual(pageRows([], view).rows, []);
  });

  it('reaches the last row of a 50000 element collection', () => {
    const big: RowDescriptor[] = Array.from({ length: 50000 }, (_, index) => ({
      index,
      label: `[${index}]`,
      cells: [cell(String(index), 'index'), cell(`Emp${index}`)]
    }));
    const view = viewWith({ page: 0, pageSize: 100 });

    const pageCount = Math.ceil(big.length / view.pageSize);
    assert.equal(pageCount, 500);

    view.page = pageCount - 1;
    assert.equal(clampPage(view, big.length), false, 'the last page must exist');
    const page = pageRows(big, view);

    assert.equal(page.offset, 49900);
    assert.equal(page.rows.length, 100);
    assert.equal(page.rows[0]?.label, '[49900]');
    assert.equal(page.rows[99]?.label, '[49999]');
  });
});

describe('column widths', () => {
  it('uses the header as the minimum and stays within bounds', () => {
    const widths = computeColumnWidths(
      columns.map((column, index) => ({ column, index })),
      rows
    );

    assert.equal(widths.length, columns.length);
    for (const entry of widths) {
      assert.ok(entry.width >= 72, `${entry.column.key} must respect the minimum`);
      assert.ok(entry.width <= 460, `${entry.column.key} must respect the maximum`);
    }
    assert.ok(widths[2]!.width >= 72);
  });

  it('widens a column with long values and clamps very long ones', () => {
    const long = [
      {
        index: 0,
        label: '[0]',
        cells: [cell('0', 'index'), cell('x'.repeat(500)), cell('1', 'number'), cell('normal')]
      } satisfies RowDescriptor
    ];

    const widths = computeColumnWidths(columns.map((column, index) => ({ column, index })), long);

    assert.equal(widths[1]!.width, 460);
  });
});

describe('chart model', () => {
  function chartLabels() {
    return {
      settings: 'Settings',
      chartType: 'Chart type',
      xAxis: 'X axis',
      yAxis: 'Y axis',
      group: 'Group',
      series: 'Series',
      aggregation: 'Aggregation',
      exportPng: 'Export PNG',
      none: 'None',
      mean: 'Mean',
      sum: 'Sum',
      min: 'Min',
      max: 'Max',
      count: 'Count',
      first: 'First',
      last: 'Last',
      types: {
        bar: 'Bar',
        pie: 'Pie',
        area: 'Area',
        line: 'Line',
        scatter: 'Scatter',
        bubble: 'Bubble',
        stock: 'Stock',
        areaRange: 'Range',
        histogram: 'Histogram'
      }
    };
  }

  function chartState(overrides: Partial<ChartState>): ChartState {
    return { ...createDefaultChartState(columns), ...overrides };
  }

  function chartModel(
    state: ChartState,
    source: readonly RowDescriptor[] = rows
  ): ReturnType<typeof buildChartModel> {
    return buildChartModel({
      state,
      columns,
      rows: source,
      labels: chartLabels(),
      title: 'temperatures',
      interactive: false
    });
  }

  it('picks sensible defaults from the columns', () => {
    const state = createDefaultChartState(columns);

    assert.equal(state.type, 'bar');
    assert.equal(state.xKey, 'City');
    assert.deepEqual(state.yKeys, ['DegreeCelsius']);
    assert.ok(state.bins >= 2);
  });

  it('builds one series per category for a bar chart', () => {
    const model = chartModel(chartState({ type: 'bar' }));

    assert.ok(model.series.length >= 1);
    assert.ok(model.categories.length >= 1);
    assert.equal(model.xLabel, 'City');
    assert.equal(model.yLabel, 'DegreeCelsius');
    const seoul = model.categories.indexOf('Seoul');
    assert.ok(seoul >= 0, 'every distinct X value becomes a category');
  });

  it('aggregates duplicates of the same category', () => {
    const model = chartModel(chartState({ type: 'bar', aggregation: 'sum' }));
    const point = model.series[0]!.points.find((candidate) => candidate.label === 'Seoul');

    assert.equal(point?.y, 30, 'Seoul appears twice: 21 + 9');
  });

  it('bins a histogram from numeric values', () => {
    const model = chartModel(chartState({ type: 'histogram', xKey: 'DegreeCelsius', yKeys: [], bins: 4 }));

    assert.equal(model.series.length, 1);
    assert.equal(model.series[0]!.points.length, 4);
    assert.equal(
      model.series[0]!.points.reduce((total, point) => total + point.y, 0),
      rows.length
    );
  });

  it('returns an empty model for a missing X column', () => {
    const model = chartModel(chartState({ xKey: 'Nope' }));

    assert.deepEqual(model.series, []);
    assert.deepEqual(model.categories, []);
  });

  it('supports groupings, bubble sizes and candlesticks', () => {
    const grouped = chartModel(chartState({ type: 'bar', groupKey: 'Feels' }));
    assert.ok(grouped.series.length > 1, 'each group value becomes a series');

    const bubble = chartModel(chartState({ type: 'bubble', xKey: 'DegreeCelsius', yKeys: ['DegreeCelsius'], sizeKey: 'DegreeCelsius' }));
    assert.ok(bubble.series[0]!.points.every((point) => point.size !== undefined));

    const stock = chartModel(chartState({ type: 'stock', xKey: 'City', yKeys: ['DegreeCelsius'] }));
    assert.equal(stock.candles.length, stock.categories.length);
  });
});

describe('the value pane row tree', () => {
  const nestedColumns: ColumnDescriptor[] = [
    { key: '#', title: '#', kind: 'index', path: [], nested: false },
    { key: 'City', title: 'City', kind: 'string', path: ['City'], nested: false },
    { key: 'Location.Lat', title: 'Lat', kind: 'number', path: ['Location', 'Lat'], nested: true },
    { key: 'Location.Lon', title: 'Lon', kind: 'number', path: ['Location', 'Lon'], nested: true }
  ];

  it('rebuilds the nesting from the flattened paths', () => {
    const row: RowDescriptor = {
      index: 0,
      label: '[0]',
      cells: [cell('0', 'index'), cell('Seoul'), cell('37.5', 'number'), cell('127', 'number')]
    };

    const tree = buildRowTree(nestedColumns, row);

    const location = tree.find((node) => node.name === 'Location');
    assert.ok(location, 'the container is rebuilt');
    assert.deepEqual(
      location.children?.map((child) => child.name),
      ['Lat', 'Lon']
    );
    assert.equal(location.children?.[0]?.value, '37.5');
  });

  it('keeps flat columns at the root and skips the index column', () => {
    const row: RowDescriptor = {
      index: 0,
      label: '[0]',
      cells: [cell('0', 'index'), cell('Seoul'), cell('21', 'number'), cell('normal')]
    };

    const tree = buildRowTree(columns, row);

    assert.deepEqual(
      tree.map((node) => node.name),
      ['City', 'DegreeCelsius', 'Feels']
    );
  });
});

describe('shared formatting', () => {
  it('formats counts for large collections', () => {
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(999), '999');
    assert.ok(formatCount(250000).length > 3);
  });
});
