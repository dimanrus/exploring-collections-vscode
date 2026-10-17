import { collapseWhitespace, truncate } from '../util/text';
import { kindFromText, kindFromAdapterValue, isErrorValue } from './valueKind';
import type { ColumnKind } from './types';

export type DateFormat = 'iso' | 'locale' | 'raw';

export interface FormatOptions {
  dateFormat: DateFormat;
  /** Maximum number of characters kept for a single cell. */
  maxCellLength: number;
  /** Treat empty strings as NULL, mirroring database semantics. */
  emptyStringAsNull: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  dateFormat: 'iso',
  maxCellLength: 512,
  emptyStringAsNull: false
};

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\n': '\n',
  '\\r': '\r',
  '\\t': '\t',
  '\\"': '"',
  "\\'": "'",
  '\\\\': '\\',
  '\\0': '\0'
};

/** Removes the surrounding quotes a debugger adds around string values. */
export function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).replace(/\\(?:[nrt"'\\0])/g, (match) => STRING_ESCAPES[match] ?? match);
  }
  return trimmed;
}

/** Parses a debugger rendered primitive into a JSON compatible value. */
export function parseAdapterPrimitive(text: string, kind: ColumnKind): unknown {
  const trimmed = text.trim();
  if (kind === 'null') {
    return null;
  }
  if (kind === 'boolean') {
    return trimmed.toLowerCase() === 'true';
  }
  if (kind === 'number') {
    // Hexadecimal literals are handled first: their trailing F is a digit, not
    // a type suffix, so suffix stripping must not run before this check.
    if (/^[+-]?0[xX]/.test(trimmed)) {
      const sign = trimmed.startsWith('-') ? -1 : 1;
      const digits = trimmed.replace(/^[+-]?0[xX]/, '').replace(/[uUlL]+$/, '');
      const parsed = Number.parseInt(digits, 16);
      return Number.isNaN(parsed) ? trimmed : sign * parsed;
    }
    const cleaned = trimmed.replace(/[fFdDmMlLuU]+$/, '');
    const parsed = Number(cleaned);
    return Number.isNaN(parsed) ? trimmed : parsed;
  }
  if (kind === 'string' || kind === 'date') {
    return unquote(trimmed);
  }
  return undefined;
}

interface TextAnalysis {
  text: string;
  kind: ColumnKind;
  isNull: boolean;
}

/** Normalizes the text a debugger printed for a value and refines its kind. */
export function analyzeAdapterText(
  text: string,
  typeName: string | undefined,
  options: FormatOptions = DEFAULT_FORMAT_OPTIONS
): TextAnalysis {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length === 0) {
    return { text: '', kind: 'string', isNull: false };
  }
  if (isErrorValue(collapsed)) {
    return { text: collapsed, kind: 'unknown', isNull: true };
  }

  let kind = kindFromAdapterValue(typeName, collapsed);
  let display = collapsed;

  switch (kind) {
    case 'string':
    case 'date': {
      const quoted = /^["']/.test(collapsed);
      const inner = unquote(collapsed);
      display = inner;
      if (kind === 'string' && !quoted) {
        // Re-run inference on the unquoted content: adapters sometimes label
        // strings as objects, and JSON encoded payloads arrive unquoted.
        kind = kindFromText(inner);
      }
      if (kind === 'date') {
        display = formatDate(inner, options.dateFormat);
      }
      break;
    }
    case 'null':
      display = '';
      break;
    default:
      break;
  }

  if (options.emptyStringAsNull && kind === 'string' && display.length === 0) {
    return { text: '', kind: 'null', isNull: true };
  }

  return {
    text: truncate(display, options.maxCellLength),
    kind,
    isNull: kind === 'null'
  };
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function formatDate(value: string, format: DateFormat): string {
  if (format === 'raw' || !ISO_DATE_PATTERN.test(value)) {
    return value;
  }
  if (format === 'iso') {
    return value.replace(' ', 'T');
  }
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

/** Formats a raw JSON value (helper fast path) into display text. */
export function formatRawValue(
  value: unknown,
  options: FormatOptions = DEFAULT_FORMAT_OPTIONS
): { text: string; kind: ColumnKind; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: '', kind: 'null', isNull: true };
  }
  switch (typeof value) {
    case 'string': {
      const kind = kindFromText(value);
      const text = kind === 'date' ? formatDate(value, options.dateFormat) : value;
      return {
        text: truncate(collapseWhitespace(text), options.maxCellLength),
        kind,
        isNull: options.emptyStringAsNull && text.length === 0
      };
    }
    case 'number':
    case 'bigint':
      return { text: String(value), kind: 'number', isNull: false };
    case 'boolean':
      return { text: value ? 'true' : 'false', kind: 'boolean', isNull: false };
    case 'object': {
      const isArray = Array.isArray(value);
      const size = isArray ? value.length : Object.keys(value as object).length;
      const preview = isArray ? `[${size} item${size === 1 ? '' : 's'}]` : `{${size} field${size === 1 ? '' : 's'}}`;
      return { text: preview, kind: isArray ? 'array' : 'object', isNull: false };
    }
    default:
      return { text: String(value), kind: 'unknown', isNull: false };
  }
}

/** Produces the tooltip text of a cell. */
export function buildCellTooltip(
  cell: { text: string; typeName?: string; kind: ColumnKind },
  columnTitle: string
): string {
  const parts = [columnTitle];
  if (cell.typeName && cell.typeName.length > 0 && cell.typeName !== columnTitle) {
    parts.push(`(${cell.typeName})`);
  }
  parts.push(`= ${cell.text.length > 0 ? cell.text : cell.kind === 'null' ? 'null' : '""'}`);
  return parts.join(' ');
}
