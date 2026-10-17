import type { CellValue, ColumnDescriptor, ColumnKind, RowDescriptor } from '../src/model/types';
import type { ColumnFilterState, ViewState } from '../src/webview/protocol';

export const DEFAULT_CHART_HEIGHT = 320;
export const DEFAULT_DETAIL_WIDTH = 340;
export const MIN_CHART_HEIGHT = 140;
export const MIN_TABLE_HEIGHT = 140;
export const MIN_DETAIL_WIDTH = 220;
/** Share of the view the chart may take, so the table never disappears. */
const MAX_CHART_SHARE = 0.8;

/** Height of the chart area, kept inside the bounds that leave the table usable. */
export function clampChartHeight(value: number, availableHeight: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHART_HEIGHT;
  }
  const maximum = Math.max(
    MIN_CHART_HEIGHT,
    Math.min(availableHeight * MAX_CHART_SHARE, availableHeight - MIN_TABLE_HEIGHT)
  );
  return Math.round(Math.min(Math.max(MIN_CHART_HEIGHT, value), maximum));
}

/** Width of the detail pane, kept inside the bounds that leave the table usable. */
export function clampDetailWidth(value: number, availableWidth: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_DETAIL_WIDTH;
  }
  const maximum = Math.max(MIN_DETAIL_WIDTH, Math.min(availableWidth * 0.6, availableWidth - 320));
  return Math.round(Math.min(Math.max(MIN_DETAIL_WIDTH, value), maximum));
}

/** Result of applying the client side view pipeline. */
export interface PipelineOutcome {
  rows: RowDescriptor[];
  /** Row count before any client side filter. */
  total: number;
  /** Row count after the column filters. */
  afterColumnFilters: number;
  /** Row count after the textual search. */
  afterSearch: number;
}

export function emptyColumnFilter(): ColumnFilterState {
  return { values: [], text: '', mode: 'include', regex: false };
}

export function isColumnFilterActive(filter: ColumnFilterState | undefined): boolean {
  if (!filter) {
    return false;
  }
  return filter.values.length > 0 || filter.text.trim().length > 0;
}

function cellAt(row: RowDescriptor, index: number): CellValue | undefined {
  return row.cells[index];
}

function compileTextFilter(filter: ColumnFilterState): ((text: string) => boolean) | undefined {
  const text = filter.text.trim();
  if (text.length === 0) {
    return undefined;
  }
  if (filter.regex) {
    try {
      const expression = new RegExp(text, 'i');
      return (value: string) => expression.test(value);
    } catch {
      return () => false;
    }
  }
  const lowered = text.toLowerCase();
  return (value: string) => value.toLowerCase().includes(lowered);
}

/** Applies the client side column filters, textual search and sorting. */
export function runPipeline(
  rows: readonly RowDescriptor[],
  columns: readonly ColumnDescriptor[],
  view: ViewState
): PipelineOutcome {
  const total = rows.length;
  let working: RowDescriptor[] = [...rows];

  const predicates = buildColumnPredicates(columns, view);
  if (predicates.length > 0) {
    working = working.filter((row) => predicates.every((predicate) => predicate(row, columns)));
  }
  const afterColumnFilters = working.length;

  const search = view.search.trim().toLowerCase();
  if (search.length > 0) {
    const visible = columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => !view.hiddenColumns.includes(column.key));
    working = working.filter((row) =>
      visible.some(({ index }) => {
        const cell = cellAt(row, index);
        return cell !== undefined && cell.text.toLowerCase().includes(search);
      })
    );
  }
  const afterSearch = working.length;

  if (view.sort) {
    const index = columns.findIndex((column) => column.key === view.sort?.columnKey);
    if (index >= 0) {
      const direction = view.sort.direction === 'asc' ? 1 : -1;
      const kind = (columns[index] as ColumnDescriptor).kind;
      working.sort((left, right) => {
        const leftCell = cellAt(left, index);
        const rightCell = cellAt(right, index);
        return direction * compareCells(leftCell, rightCell, kind);
      });
    }
  }

  return { rows: working, total, afterColumnFilters, afterSearch };
}

type ColumnPredicate = (row: RowDescriptor, columns: readonly ColumnDescriptor[]) => boolean;

function buildColumnPredicates(
  columns: readonly ColumnDescriptor[],
  view: ViewState
): ColumnPredicate[] {
  const predicates: ColumnPredicate[] = [];
  for (const column of columns) {
    const filter = view.columnFilters[column.key];
    if (!filter || !isColumnFilterActive(filter)) {
      continue;
    }
    const index = columns.findIndex((candidate) => candidate.key === column.key);
    if (index < 0) {
      continue;
    }
    const matcher = compileTextFilter(filter);
    const selected = new Set(filter.values.map((value) => value.toLowerCase()));
    const mode = filter.mode;

    predicates.push((row) => {
      const cell = cellAt(row, index);
      const text = cell ? cell.text : '';
      const matchesValues = selected.size === 0 || selected.has(text.toLowerCase());
      const matchesText = matcher ? matcher(text) : true;
      const matches = matchesValues && matchesText;
      return mode === 'include' ? matches : !matches;
    });
  }
  return predicates;
}

/** Typed comparison used for sorting, mirroring the filter semantics. */
export function compareCells(
  left: CellValue | undefined,
  right: CellValue | undefined,
  kind: ColumnKind
): number {
  const leftEmpty = left === undefined || left.isNull || left.text.length === 0;
  const rightEmpty = right === undefined || right.isNull || right.text.length === 0;
  if (leftEmpty && rightEmpty) {
    return 0;
  }
  // Empty cells always sort last, regardless of the direction.
  if (leftEmpty) {
    return 1;
  }
  if (rightEmpty) {
    return -1;
  }

  const leftValue = left as CellValue;
  const rightValue = right as CellValue;

  if (kind === 'number' || kind === 'index') {
    const leftNumber = toNumber(leftValue);
    const rightNumber = toNumber(rightValue);
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
    }
  }

  if (kind === 'date') {
    const leftTime = Date.parse(leftValue.text.replace(' ', 'T'));
    const rightTime = Date.parse(rightValue.text.replace(' ', 'T'));
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
    }
  }

  if (kind === 'boolean') {
    const leftBoolean = leftValue.text.toLowerCase() === 'true';
    const rightBoolean = rightValue.text.toLowerCase() === 'true';
    if (leftBoolean !== rightBoolean) {
      return leftBoolean ? 1 : -1;
    }
    return 0;
  }

  return leftValue.text.localeCompare(rightValue.text, undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function toNumber(cell: CellValue): number | undefined {
  if (typeof cell.raw === 'number') {
    return cell.raw;
  }
  const cleaned = cell.text.replace(/,/g, '').replace(/[fFdDmMlLuU]+$/, '');
  if (cleaned.length === 0) {
    return undefined;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/** Distinct values of a column, used by the local filter popup. */
export function distinctValues(
  rows: readonly RowDescriptor[],
  columnIndex: number,
  limit = 500
): string[] {
  const values = new Map<string, string>();
  for (const row of rows) {
    const cell = cellAt(row, columnIndex);
    if (!cell) {
      continue;
    }
    const key = cell.isNull ? '\u0000null' : cell.text;
    if (!values.has(key)) {
      if (values.size >= limit) {
        continue;
      }
      values.set(key, cell.isNull ? '' : cell.text);
    }
  }
  return [...values.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/** Columns in the order the user arranged them, honouring visibility. */
export function orderedColumns(
  columns: readonly ColumnDescriptor[],
  view: ViewState
): { column: ColumnDescriptor; index: number }[] {
  const indexed = columns.map((column, index) => ({ column, index }));
  const order = view.columnOrder;
  if (!order || order.length === 0) {
    return indexed;
  }
  const rank = new Map(order.map((key, position) => [key, position]));
  return indexed.sort((left, right) => {
    const leftRank = rank.get(left.column.key) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.column.key) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank === rightRank) {
      return left.index - right.index;
    }
    return leftRank - rightRank;
  });
}

/** Clamps the current page so it always points at existing rows. */
export function clampPage(view: ViewState, rowCount: number): boolean {
  const pageCount = Math.max(1, Math.ceil(rowCount / Math.max(1, view.pageSize)));
  const clamped = Math.min(Math.max(0, view.page), pageCount - 1);
  if (clamped !== view.page) {
    view.page = clamped;
    return true;
  }
  return false;
}

/** Slices the current page out of the filtered rows. */
export function pageRows(
  rows: readonly RowDescriptor[],
  view: ViewState,
  virtualWindow = false
): { rows: RowDescriptor[]; offset: number } {
  if (virtualWindow) {
    return { rows: [...rows], offset: 0 };
  }
  const start = view.page * Math.max(1, view.pageSize);
  return { rows: rows.slice(start, start + Math.max(1, view.pageSize)), offset: start };
}
