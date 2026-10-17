import { escapeCsvField, escapeXml, stripInvalidXmlCharacters, truncate } from '../util/text';
import { rowToObject } from '../model/snapshotBuilder';
import type { CollectionSnapshot, ColumnDescriptor, RowDescriptor } from '../model/types';

export type ExportFormat = 'csv' | 'json' | 'xlsx' | 'xml';

/** Narrows an arbitrary string to a supported export format. */
export function isExportFormat(value: string): value is ExportFormat {
  return value === 'csv' || value === 'json' || value === 'xlsx' || value === 'xml';
}

export interface ExportSelection {
  snapshot: CollectionSnapshot;
  /** Rows to export, defaults to every row of the snapshot. */
  rows?: readonly RowDescriptor[];
  /** Columns to export, defaults to every column of the snapshot. */
  columns?: readonly ColumnDescriptor[];
}

export interface CsvOptions {
  delimiter?: string;
  quote?: string;
  lineEnding?: '\r\n' | '\n';
  byteOrderMark?: boolean;
  includeHeader?: boolean;
}

function selectedColumns(selection: ExportSelection): readonly ColumnDescriptor[] {
  return selection.columns ?? selection.snapshot.columns;
}

function selectedRows(selection: ExportSelection): readonly RowDescriptor[] {
  return selection.rows ?? selection.snapshot.rows;
}

function cellTextAt(snapshot: CollectionSnapshot, row: RowDescriptor, column: ColumnDescriptor): string {
  const index = snapshot.columns.indexOf(column);
  if (index < 0) {
    return '';
  }
  const cell = row.cells[index];
  return cell ? cell.text : '';
}

function isNullAt(snapshot: CollectionSnapshot, row: RowDescriptor, column: ColumnDescriptor): boolean {
  const index = snapshot.columns.indexOf(column);
  if (index < 0) {
    return true;
  }
  const cell = row.cells[index];
  return cell ? cell.isNull : true;
}

/** Serializes the selection as RFC 4180 CSV. */
export function toCsv(selection: ExportSelection, options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const lineEnding = options.lineEnding ?? '\r\n';
  const columns = selectedColumns(selection);
  const rows = selectedRows(selection);

  const lines: string[] = [];
  if (options.includeHeader !== false) {
    lines.push(columns.map((column) => escapeCsvField(column.key, delimiter, quote)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => escapeCsvField(cellTextAt(selection.snapshot, row, column), delimiter, quote))
        .join(delimiter)
    );
  }

  const body = lines.join(lineEnding);
  const bom = options.byteOrderMark === false ? '' : '\uFEFF';
  return bom + body + (body.length > 0 ? lineEnding : '');
}

export interface JsonExportOptions {
  pretty?: boolean;
  includeMetadata?: boolean;
  indent?: number;
}

/** Serializes the selection as JSON. */
export function toJson(selection: ExportSelection, options: JsonExportOptions = {}): string {
  const columns = selectedColumns(selection);
  const rows = selectedRows(selection);
  const projected: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const full = rowToObject(selection.snapshot, row);
    const entry: Record<string, unknown> = {};
    for (const column of columns) {
      entry[column.key] = full[column.key] ?? null;
    }
    projected.push(entry);
  }

  const indent = options.indent ?? (options.pretty === false ? undefined : 2);
  if (options.includeMetadata) {
    const document = {
      collection: selection.snapshot.title,
      expression: selection.snapshot.expression,
      language: selection.snapshot.language,
      debugType: selection.snapshot.debugType,
      capturedAt: new Date(selection.snapshot.capturedAt).toISOString(),
      totalItems: selection.snapshot.totalItems,
      truncated: selection.snapshot.truncated,
      exportedRows: projected.length,
      columns: columns.map((column) => ({ key: column.key, kind: column.kind, typeName: column.typeName })),
      rows: projected
    };
    return JSON.stringify(document, null, indent);
  }
  return JSON.stringify(projected, null, indent);
}

export interface XmlExportOptions {
  /** Root element name. */
  rootName?: string;
  /** Element name used per row. */
  rowName?: string;
  pretty?: boolean;
}

/** Makes a string usable as an XML element name. */
export function toXmlName(value: string, fallback = 'column'): string {
  const cleaned = value.replace(/[^\w.\-]/g, '_').replace(/^[^A-Za-z_]/, (character) => `_${character}`);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Serializes the selection as XML with one element per cell. */
export function toXml(selection: ExportSelection, options: XmlExportOptions = {}): string {
  const rootName = options.rootName ?? 'collection';
  const rowName = options.rowName ?? 'row';
  const pretty = options.pretty !== false;
  const columns = selectedColumns(selection);
  const rows = selectedRows(selection);
  const indent = pretty ? '  ' : '';

  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  parts.push(
    `<${rootName} name="${escapeXml(selection.snapshot.title)}" expression="${escapeXml(
      selection.snapshot.expression
    )}" exportedRows="${rows.length}" capturedAt="${new Date(selection.snapshot.capturedAt).toISOString()}">`
  );

  const usedNames = new Set<string>();
  const elementNames = columns.map((column) => {
    let candidate = toXmlName(column.key);
    let suffix = 1;
    while (usedNames.has(candidate)) {
      suffix += 1;
      candidate = `${toXmlName(column.key)}_${suffix}`;
    }
    usedNames.add(candidate);
    return candidate;
  });

  for (const row of rows) {
    parts.push(`${indent}<${rowName} index="${row.index}" label="${escapeXml(row.label)}">`);
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index] as ColumnDescriptor;
      const elementName = elementNames[index] as string;
      if (isNullAt(selection.snapshot, row, column)) {
        parts.push(`${indent}${indent}<${elementName} null="true"/>`);
        continue;
      }
      const text = escapeXml(stripInvalidXmlCharacters(cellTextAt(selection.snapshot, row, column)));
      parts.push(`${indent}${indent}<${elementName}>${text}</${elementName}>`);
    }
    parts.push(`${indent}</${rowName}>`);
  }

  parts.push(`</${rootName}>`);
  return parts.join(pretty ? '\n' : '');
}

/** File extension (without dot) used for a format. */
export function extensionFor(format: ExportFormat): string {
  return format;
}

/** Human readable label of a format, used by pickers and diagnostics. */
export function labelFor(format: ExportFormat): string {
  switch (format) {
    case 'csv':
      return 'CSV';
    case 'json':
      return 'JSON';
    case 'xlsx':
      return 'Excel Workbook (XLSX)';
    case 'xml':
      return 'XML';
    default:
      return format;
  }
}

/** Maximum number of characters kept in a single exported cell. */
export const EXPORT_CELL_LIMIT = 32767;

/** Truncates cell text to the Excel hard limit. */
export function clampCellText(value: string): string {
  return truncate(value, EXPORT_CELL_LIMIT);
}
