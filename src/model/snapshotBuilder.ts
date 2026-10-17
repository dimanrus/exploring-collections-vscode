import { INDEX_COLUMN_KEY } from '../util/types';
import { DEFAULT_FORMAT_OPTIONS, formatRawValue, type FormatOptions } from './formatter';
import type {
  CellValue,
  CollectionSnapshot,
  ColumnDescriptor,
  ColumnKind,
  RowDescriptor,
  RetrievalStrategy,
  SnapshotDiagnostics,
  SnapshotSource
} from './types';

/** A flattened property of a collection element. */
export interface FieldNode {
  /** Header the column will receive. */
  name: string;
  /** Full property path from the element root. */
  path: string[];
  /** Display text. */
  text: string;
  kind: ColumnKind;
  isNull?: boolean;
  typeName?: string;
  expandable?: boolean;
  raw?: unknown;
  variablesReference?: number;
  evaluateName?: string;
  childCount?: number;
}

/** One materialized element of a collection. */
export interface ElementNode {
  label: string;
  typeName?: string;
  valueText?: string;
  raw?: unknown;
  variablesReference?: number;
  evaluateName?: string;
  childCount?: number;
  error?: boolean;
  fields: FieldNode[];
}

export interface BuildSnapshotInput {
  id: string;
  title: string;
  expression: string;
  sessionId: string;
  sessionName: string;
  debugType: string;
  language: string;
  providerId: string;
  elements: readonly ElementNode[];
  /** Element count reported by the debug adapter when it is larger than what we fetched. */
  totalItems?: number | null;
  truncated?: boolean;
  warnings?: string[];
  diagnostics: Omit<SnapshotDiagnostics, 'durationMs' | 'requests'> &
    Partial<Pick<SnapshotDiagnostics, 'durationMs' | 'requests'>>;
  formatOptions?: FormatOptions;
  columnOrder?: 'alphabetical' | 'discovery';
  /** Depth of nested objects that is flattened into separate columns. */
  flattenDepth?: number;
  /** Set when the rows were read from the source text instead of a debugger. */
  source?: SnapshotSource;
}

/** Picks the most specific kind among the observed kinds of a column. */
export function mergeKinds(kinds: readonly ColumnKind[]): ColumnKind {
  const meaningful = kinds.filter((kind) => kind !== 'null');
  const pool = meaningful.length > 0 ? meaningful : kinds;
  if (pool.length === 0) {
    return 'unknown';
  }
  const unique = new Set(pool);
  if (unique.size === 1) {
    return pool[0] as ColumnKind;
  }
  // Numbers mixed with nulls stay numeric; anything else degrades to text.
  if (pool.every((kind) => kind === 'number')) {
    return 'number';
  }
  if (unique.has('object') || unique.has('array')) {
    return unique.has('object') ? 'object' : 'array';
  }
  return 'string';
}

function isTextLike(kind: ColumnKind): boolean {
  return kind === 'string' || kind === 'unknown' || kind === 'null';
}

/**
 * Flattens nested objects and arrays into additional columns, mirroring the
 * way the viewer spreads `Temperature.Feels` and `Address.City` into the grid.
 */
export function flattenFields(
  fields: readonly FieldNode[],
  depth: number,
  prefix: string[] = []
): FieldNode[] {
  const result: FieldNode[] = [];
  for (const field of fields) {
    const path = [...prefix, ...field.path.length > 0 ? field.path : [field.name]];
    const isNestedContainer = field.kind === 'object' || field.kind === 'array';
    const hasChildren = field.variablesReference !== undefined || field.raw !== undefined;
    if (isNestedContainer && hasChildren && path.length <= depth) {
      const children = childrenOf(field);
      if (children.length > 0) {
        result.push(...flattenFields(children, depth, path));
        continue;
      }
    }
    result.push({ ...field, path });
  }
  return result;
}

function childrenOf(field: FieldNode): FieldNode[] {
  const raw = field.raw;
  if (raw !== undefined && raw !== null && typeof raw === 'object') {
    return rawToFields(raw as object);
  }
  return [];
}

/** Converts a parsed JSON object into field nodes (one level). */
export function rawToFields(value: object): FieldNode[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [
        {
          name: 'value',
          path: ['value'],
          text: '[]',
          kind: 'array',
          raw: value
        }
      ];
    }
    if (value.length > NESTED_FIELD_LIMIT) {
      return [
        {
          name: 'value',
          path: ['value'],
          text: formatRawValue(value).text,
          kind: 'array',
          expandable: true,
          raw: value
        }
      ];
    }
    return value.map((child, index) => {
      const formatted = formatRawValue(child);
      return {
        name: `[${index}]`,
        path: [`[${index}]`],
        text: formatted.text,
        kind: formatted.kind,
        isNull: formatted.isNull,
        expandable: formatted.kind === 'object' || formatted.kind === 'array',
        raw: child
      } satisfies FieldNode;
    });
  }
  return Object.entries(value).map(([name, child]) => {
    const formatted = formatRawValue(child);
    return {
      name,
      path: [name],
      text: formatted.text,
      kind: formatted.kind,
      isNull: formatted.isNull,
      expandable: formatted.kind === 'object' || formatted.kind === 'array',
      raw: child
    } satisfies FieldNode;
  });
}

/** Maximum number of nested array items expanded into separate columns. */
const NESTED_FIELD_LIMIT = 32;

/** Fields of an element, derived from `raw` when the provider did not build them. */
function elementFields(element: ElementNode): FieldNode[] {
  if (element.fields.length > 0) {
    return element.fields;
  }
  if (element.raw !== undefined && element.raw !== null && typeof element.raw === 'object') {
    return rawToFields(element.raw as object);
  }
  return [];
}

function columnKeyOf(field: FieldNode): string {
  return field.path.join('.');
}

interface ColumnAccumulator {
  key: string;
  title: string;
  path: string[];
  kinds: ColumnKind[];
  typeName?: string;
  nested: boolean;
  order: number;
}

/** Builds the immutable snapshot consumed by the webview UI. */
export function buildSnapshot(input: BuildSnapshotInput): CollectionSnapshot {
  const formatOptions = input.formatOptions ?? DEFAULT_FORMAT_OPTIONS;
  const flattenDepth = input.flattenDepth ?? 2;

  const columns = new Map<string, ColumnAccumulator>();
  let discoveryOrder = 0;

  for (const element of input.elements) {
    for (const field of flattenFields(elementFields(element), flattenDepth)) {
      const key = columnKeyOf(field);
      const existing = columns.get(key);
      if (existing) {
        existing.kinds.push(field.kind);
        if (!existing.typeName && field.typeName) {
          existing.typeName = field.typeName;
        }
        continue;
      }
      columns.set(key, {
        key,
        title: field.path.length > 0 ? (field.path[field.path.length - 1] as string) : field.name,
        path: field.path,
        kinds: [field.kind],
        typeName: field.typeName,
        nested: field.path.length > 1,
        order: discoveryOrder++
      });
    }
  }

  const orderedColumns: ColumnDescriptor[] = [...columns.values()]
    .sort((left, right) => {
      if (input.columnOrder === 'discovery') {
        return left.order - right.order;
      }
      // Sorting by key keeps nested columns next to their parent (`address.zip`
      // before `city`) while flat columns keep their alphabetical order.
      return left.key.localeCompare(right.key, undefined, { numeric: true, sensitivity: 'base' });
    })
    .map((accumulator) => ({
      key: accumulator.key,
      title: accumulator.title,
      path: accumulator.path,
      kind: mergeKinds(accumulator.kinds),
      typeName: accumulator.typeName,
      nested: accumulator.nested
    }));

  const indexColumn: ColumnDescriptor = {
    key: INDEX_COLUMN_KEY,
    title: INDEX_COLUMN_KEY,
    path: [],
    kind: 'index',
    nested: false
  };

  const allColumns = [indexColumn, ...orderedColumns];

  const rows: RowDescriptor[] = input.elements.map((element, index) => ({
    index,
    label: element.label,
    cells: cellsForElement(element, allColumns, formatOptions, flattenDepth),
    typeName: element.typeName,
    variablesReference: element.variablesReference,
    evaluateName: element.evaluateName,
    childCount: element.childCount,
    error: element.error
  }));

  const totalItems = input.totalItems ?? null;

  return {
    id: input.id,
    title: input.title,
    expression: input.expression,
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    debugType: input.debugType,
    language: input.language,
    providerId: input.providerId,
    capturedAt: Date.now(),
    columns: allColumns,
    rows,
    totalItems,
    truncated: input.truncated ?? false,
    warnings: input.warnings ?? [],
    source: input.source,
    diagnostics: {
      strategy: input.diagnostics.strategy as RetrievalStrategy,
      durationMs: input.diagnostics.durationMs ?? 0,
      requests: input.diagnostics.requests ?? 0,
      reportedItemCount: input.diagnostics.reportedItemCount ?? totalItems,
      fallbackReasons: input.diagnostics.fallbackReasons ?? [],
      pushedDownFilter: input.diagnostics.pushedDownFilter,
      notes: input.diagnostics.notes ?? []
    }
  };
}

/** Builds the cells of one element against an existing column set. */
export function cellsForElement(
  element: ElementNode,
  columns: readonly ColumnDescriptor[],
  formatOptions: FormatOptions = DEFAULT_FORMAT_OPTIONS,
  flattenDepth = 2
): CellValue[] {
  const byKey = new Map<string, FieldNode>();
  for (const field of flattenFields(elementFields(element), flattenDepth)) {
    byKey.set(columnKeyOf(field), field);
  }
  return columns.map((column) => {
    if (column.key === INDEX_COLUMN_KEY) {
      return {
        text: element.label,
        kind: 'index' as ColumnKind,
        isNull: false,
        expandable: true,
        typeName: element.typeName
      };
    }
    const field = byKey.get(column.key);
    if (!field) {
      return { text: '', kind: 'null' as ColumnKind, isNull: true, expandable: false };
    }
    return coerceCell(field, column.kind, formatOptions);
  });
}

/**
 * Rebuilds rows for a set of elements reusing an existing column layout, so a
 * pushed down filter keeps the grid stable instead of re-deriving the schema.
 */
export function rowsFromElements(
  elements: readonly ElementNode[],
  columns: readonly ColumnDescriptor[],
  formatOptions: FormatOptions = DEFAULT_FORMAT_OPTIONS,
  flattenDepth = 2
): RowDescriptor[] {
  return elements.map((element, index) => ({
    index,
    label: element.label,
    cells: cellsForElement(element, columns, formatOptions, flattenDepth),
    typeName: element.typeName,
    variablesReference: element.variablesReference,
    evaluateName: element.evaluateName,
    childCount: element.childCount,
    error: element.error
  }));
}

function coerceCell(field: FieldNode, columnKind: ColumnKind, options: FormatOptions): CellValue {
  const raw = field.raw;
  if (raw !== undefined) {
    const formatted = formatRawValue(raw, options);
    return {
      text: field.text.length > 0 ? field.text : formatted.text,
      kind: field.kind,
      isNull: field.isNull ?? formatted.isNull,
      raw,
      expandable: field.expandable ?? false,
      typeName: field.typeName,
      evaluateName: field.evaluateName
    };
  }

  let kind = field.kind;
  if (isTextLike(kind) && columnKind === 'number') {
    kind = 'number';
  }
  return {
    text: field.text,
    kind,
    isNull: field.isNull ?? kind === 'null',
    expandable: field.expandable ?? false,
    typeName: field.typeName,
    variablesReference: field.variablesReference,
    evaluateName: field.evaluateName
  };
}

/** Creates a snapshot for an empty or failed capture. */
export function createEmptySnapshot(
  base: Pick<
    CollectionSnapshot,
    'id' | 'title' | 'expression' | 'sessionId' | 'sessionName' | 'debugType' | 'language' | 'providerId'
  >,
  diagnostics: SnapshotDiagnostics,
  warnings: string[]
): CollectionSnapshot {
  return {
    ...base,
    capturedAt: Date.now(),
    columns: [],
    rows: [],
    totalItems: 0,
    truncated: false,
    warnings,
    diagnostics
  };
}

/** Returns a copy of the snapshot restricted to the given rows. */
export function withRows(snapshot: CollectionSnapshot, rows: RowDescriptor[]): CollectionSnapshot {
  return { ...snapshot, rows };
}

/**
 * Converts a cell into the value an export should contain. Numbers and booleans
 * are typed so that CSV/JSON/XLSX consumers see 21 instead of "21".
 */
export function coerceExportValue(cell: CellValue, kind: ColumnKind): unknown {
  if (cell.raw !== undefined) {
    return cell.raw;
  }
  if (cell.isNull) {
    return null;
  }
  if (kind === 'number') {
    const cleaned = cell.text.replace(/,/g, '').replace(/[fFdDmMlLuU]+$/, '');
    const parsed = cleaned.length > 0 ? Number(cleaned) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : cell.text;
  }
  if (kind === 'boolean') {
    return cell.text.toLowerCase() === 'true';
  }
  return cell.text;
}

/** Returns the plain object representation of a row, used by the exporters. */
export function rowToObject(snapshot: CollectionSnapshot, row: RowDescriptor): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < snapshot.columns.length; index += 1) {
    const column = snapshot.columns[index] as ColumnDescriptor;
    const cell = row.cells[index];
    if (!cell) {
      continue;
    }
    result[column.key] = coerceExportValue(cell, column.kind);
  }
  return result;
}
