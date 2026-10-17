import type { ColumnKind } from './types';

/**
 * Maps a debug adapter type name or a raw JavaScript value to a semantic
 * column kind. The tables are intentionally permissive: debuggers report
 * wildly different type spellings for the same concept (`int32_t`, `int`,
 * `System.Int32`, `i32`, `numpy.int64`, ...).
 */

const NUMBER_TYPES = new Set([
  'byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
  'integer', 'float', 'double', 'single', 'decimal', 'float32', 'float64',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t',
  'uint64_t', 'size_t', 'ssize_t', 'number', 'bigint',
  'i8', 'i16', 'i32', 'i64', 'isize', 'u8', 'u16', 'u32', 'u64', 'usize',
  'f32', 'f64', 'rune', 'numpy.int64', 'numpy.float64'
]);

const BOOLEAN_TYPES = new Set(['bool', 'boolean', 'system.boolean']);

const STRING_TYPES = new Set([
  'string', 'char', 'wchar_t', 'std::string', 'std::wstring', 'stringbuilder',
  'str', 'bytes', 'unicode', 'symbol', 'text', 'char16_t', 'char32_t',
  'cstring', 'qstring', 'nsstring'
]);

const DATE_TYPES = new Set([
  'dateonly', 'datetime', 'datetimeoffset', 'timespan', 'timestamp',
  'date', 'time', 'system.datetime', 'system.dateonly', 'system.timespan',
  'instant', 'duration', 'naivedatetime'
]);

const OBJECT_TYPES = new Set([
  'object', 'dict', 'dictionary', 'map', 'hashmap', 'treemap', 'record',
  'struct', 'class', 'tuple', 'value', 'interface', 'anonymous', 'dynamic'
]);

const ARRAY_TYPES = new Set(['array', 'list', 'slice', 'vec', 'set', 'hashset', 'vector']);

/** Normalizes a debugger type name: strips namespaces, generics and decorators. */
export function normalizeTypeName(typeName: string | undefined): string {
  if (!typeName) {
    return '';
  }
  let value = typeName.trim();

  // Go spells its container types with brackets: map[string]int, []byte, chan int.
  if (/^map\s*\[/.test(value)) {
    return 'map';
  }
  if (/^\[\]/.test(value)) {
    return 'array';
  }
  if (/^chan\b/.test(value)) {
    return 'chan';
  }
  if (/^func\s*\(/.test(value)) {
    return 'func';
  }

  // Strip generic arguments, but keep the outer name: List<int> -> list
  const genericIndex = value.indexOf('<');
  if (genericIndex > 0) {
    value = value.slice(0, genericIndex);
  }
  // Arrays: int[] -> array
  if (value.endsWith('[]') || /\[\d+\]$/.test(value)) {
    return 'array';
  }
  // C# and F# style references and pointers, including `in T` and `out T`.
  value = value.replace(/^(?:[&*]+\s*(?:mut\s+)?|mut\s+)+/, '').replace(/\s*[&]+$/, '');
  // Qualified names: System.Collections.Generic.List -> list
  const lastSegment = value.split(/[.:]/).filter((part) => part.length > 0).pop();
  return (lastSegment ?? value).trim().toLowerCase();
}

function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
}

/** Infers the kind of a raw JSON value produced by a serializing helper. */
export function kindFromRawValue(value: unknown): ColumnKind {
  if (value === null || value === undefined) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return looksLikeIsoDate(value) ? 'date' : 'string';
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return Array.isArray(value) ? 'array' : 'object';
    default:
      return 'unknown';
  }
}

/** Infers the kind of a value using the adapter type name and its text form. */
export function kindFromAdapterValue(typeName: string | undefined, text: string): ColumnKind {
  const normalized = normalizeTypeName(typeName);
  if (normalized.length > 0) {
    if (NUMBER_TYPES.has(normalized)) {
      return 'number';
    }
    if (BOOLEAN_TYPES.has(normalized)) {
      return 'boolean';
    }
    if (DATE_TYPES.has(normalized)) {
      return 'date';
    }
    if (STRING_TYPES.has(normalized)) {
      return 'string';
    }
    if (ARRAY_TYPES.has(normalized)) {
      return 'array';
    }
    if (OBJECT_TYPES.has(normalized)) {
      return 'object';
    }
    const kindHint = typeKindHint(normalized);
    if (kindHint) {
      return kindHint;
    }
  }
  return kindFromText(text);
}

function typeKindHint(normalized: string): ColumnKind | undefined {
  if (normalized.endsWith('int') || normalized.endsWith('float') || normalized.endsWith('double')) {
    return 'number';
  }
  if (normalized.endsWith('string') || normalized.endsWith('char')) {
    return 'string';
  }
  if (normalized.endsWith('bool')) {
    return 'boolean';
  }
  if (normalized.includes('date') || normalized.includes('time')) {
    return 'date';
  }
  return undefined;
}

/** Infers the kind of a debugger rendered text value. */
export function kindFromText(text: string): ColumnKind {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 'string';
  }
  if (trimmed === 'null' || trimmed === 'nil' || trimmed === 'None' || trimmed === 'none') {
    return 'null';
  }
  if (trimmed === 'true' || trimmed === 'false' || trimmed === 'True' || trimmed === 'False') {
    return 'boolean';
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed.startsWith('[') ? 'array' : 'object';
  }
  if (isNumericText(trimmed)) {
    return 'number';
  }
  if (looksLikeIsoDate(trimmed.replace(/^"|"$/g, ''))) {
    return 'date';
  }
  return 'string';
}

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdDmMlLuU]?$/;
const HEX_PATTERN = /^[+-]?0[xX][0-9a-fA-F]+[uUlL]*$/;
const NAN_PATTERN = /^(nan|NaN|-?inf|-?Infinity|∞)$/;

/** Returns true when the debugger text represents a numeric value. */
export function isNumericText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return NUMBER_PATTERN.test(trimmed) || HEX_PATTERN.test(trimmed) || NAN_PATTERN.test(trimmed);
}

/** Returns true when the adapter reports the value as an error/placeholder. */
export function isErrorValue(text: string): boolean {
  return (
    text.includes('<error>') ||
    text.startsWith('error:') ||
    text.startsWith('not available') ||
    text.includes('invalid expression')
  );
}

/**
 * Classifies an adapter variable as a collection, a record or a leaf. Used to
 * decide whether a variable is worth offering in the "Explore collection"
 * picker and how to walk it.
 */
export function classifyAdapterVariable(variable: {
  indexedVariables?: number;
  namedVariables?: number;
  type?: string;
  value: string;
}): 'sequence' | 'map' | 'record' | 'leaf' {
  const indexed = variable.indexedVariables ?? 0;
  const named = variable.namedVariables ?? 0;
  const normalized = normalizeTypeName(variable.type);

  if (indexed > 0) {
    return 'sequence';
  }
  if (named > 0) {
    if (OBJECT_TYPES.has(normalized)) {
      return 'map';
    }
    if (ARRAY_TYPES.has(normalized) || normalized.endsWith('list') || normalized.endsWith('set')) {
      return 'map';
    }
    return 'record';
  }
  if (normalized === 'array' || normalized === 'list' || normalized === 'vec' || normalized === 'slice') {
    return 'sequence';
  }
  if (variable.value.startsWith('[') && variable.value.endsWith(']')) {
    return 'sequence';
  }
  return 'leaf';
}

/** True when the kind represents a primitive that cannot be expanded. */
export function isPrimitiveKind(kind: ColumnKind): boolean {
  return kind !== 'object' && kind !== 'array' && kind !== 'unknown';
}
