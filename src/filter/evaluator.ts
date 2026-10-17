import type { ColumnDescriptor, RowDescriptor } from '../model/types';
import { calleeName, type FilterExpression, type ParsedFilter } from './expression';
import { isNumericText } from '../model/valueKind';

/** Names resolved by the evaluator itself rather than by the debugger. */
export const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  'isnull', 'isempty', 'isnotnull', 'len', 'length', 'count',
  'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'min', 'max',
  'lower', 'lowercase', 'upper', 'uppercase', 'trim',
  'contains', 'startswith', 'endswith', 'indexof', 'matches',
  'like', 'ilike', 'date', 'year', 'month', 'day', 'hour', 'minute', 'second',
  'dayofweek', 'dayofyear', 'now', 'today', 'int', 'float', 'string', 'bool',
  'substring', 'replace', 'concat', 'sum', 'avg'
]);

/** Method names dispatched on the receiver value. */
const METHOD_FUNCTIONS: ReadonlySet<string> = new Set([
  'contains', 'includes', 'startswith', 'endswith', 'tolower', 'tolowercase',
  'toupper', 'touppercase', 'trim', 'trimstart', 'trimend', 'indexof',
  'substring', 'substr', 'slice', 'length', 'count', 'any', 'tostring',
  'keys', 'values', 'getvalueordefault', 'trygetvalue', 'has', 'hasownproperty'
]);

export interface EvaluationContext {
  row: RowDescriptor;
  columns: readonly ColumnDescriptor[];
  parameter: string;
  locals: ReadonlyMap<string, unknown>;
}

/** Converts a table cell into a comparable value. */
export function cellValue(cell: RowDescriptor['cells'][number], column: ColumnDescriptor): unknown {
  if (cell.raw !== undefined) {
    return cell.raw;
  }
  switch (column.kind) {
    case 'number':
      return isNumericText(cell.text) ? Number(cell.text.replace(/[fFdDmMlLuU]+$/, '')) : cell.text;
    case 'boolean':
      return cell.text.toLowerCase() === 'true';
    case 'null':
      return null;
    default:
      return cell.text;
  }
}

/** Builds the object a filter expression operates on, honoring nested columns. */
export function buildRowObject(row: RowDescriptor, columns: readonly ColumnDescriptor[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index] as ColumnDescriptor;
    const cell = row.cells[index];
    if (!cell || column.key === '#') {
      continue;
    }
    const value = cellValue(cell, column);
    let target = root;
    for (let depth = 0; depth < column.path.length - 1; depth += 1) {
      const segment = column.path[depth] as string;
      const existing = target[segment];
      if (typeof existing === 'object' && existing !== null) {
        target = existing as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        target[segment] = created;
        target = created;
      }
    }
    const leaf = column.path[column.path.length - 1];
    if (leaf !== undefined) {
      target[leaf] = value;
    }
  }
  return root;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value !== 0 : false;
  }
  if (typeof value === 'string') {
    return value.length > 0 && value !== 'false' && value !== 'False';
  }
  return true;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && isNumericText(value)) {
    return Number(value.replace(/[fFdDmMlLuU]+$/, ''));
  }
  return undefined;
}

function toDateValue(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed)) {
      const parsed = Date.parse(trimmed.replace(' ', 'T'));
      return Number.isNaN(parsed) ? undefined : parsed;
    }
  }
  return undefined;
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) {
    return right === null || right === undefined || right === '';
  }
  if (right === null || right === undefined) {
    return left === null || left === undefined || left === '';
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right;
  }
  const leftDate = toDateValue(left);
  const rightDate = toDateValue(right);
  if (leftDate !== undefined && rightDate !== undefined) {
    return leftDate === rightDate;
  }
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber === rightNumber;
  }
  return String(left) === String(right);
}

function compareValues(left: unknown, right: unknown): number | undefined {
  const leftDate = toDateValue(left);
  const rightDate = toDateValue(right);
  const dateLike =
    (typeof left === 'string' || left instanceof Date) && (typeof right === 'string' || right instanceof Date);
  if (dateLike && leftDate !== undefined && rightDate !== undefined) {
    return leftDate === rightDate ? 0 : leftDate < rightDate ? -1 : 1;
  }
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  if (left === null || left === undefined || right === null || right === undefined) {
    return undefined;
  }
  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) {
    return 0;
  }
  return leftText < rightText ? -1 : 1;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function lengthOf(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length;
  }
  if (value instanceof Map || value instanceof Set) {
    return value.size;
  }
  if (isPlainRecord(value)) {
    return Object.keys(value).length;
  }
  return 0;
}

/** Translates a SQL style pattern into a regular expression. */
export function likeToRegExp(pattern: string, caseInsensitive = true): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
  const translated = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${translated}$`, caseInsensitive ? 'i' : '');
}

function memberOf(target: unknown, name: string): unknown {
  if (target === null || target === undefined) {
    return undefined;
  }
  if (typeof target === 'string') {
    if (name === 'Length' || name === 'length' || name === 'Count') {
      return target.length;
    }
  }
  if (Array.isArray(target)) {
    if (name === 'Length' || name === 'length' || name === 'Count') {
      return target.length;
    }
    if (/^\d+$/.test(name)) {
      return target[Number(name)];
    }
  }
  if (target instanceof Map) {
    if (name === 'Count' || name === 'Size' || name === 'size') {
      return target.size;
    }
    return target.get(name);
  }
  if (isPlainRecord(target)) {
    return target[name];
  }
  return undefined;
}

interface CallOutcome {
  handled: boolean;
  value: unknown;
}

function callMethod(receiver: unknown, name: string, args: readonly unknown[]): CallOutcome {
  const lowered = name.toLowerCase();
  if (!METHOD_FUNCTIONS.has(lowered)) {
    return { handled: false, value: undefined };
  }
  switch (lowered) {
    case 'contains':
    case 'includes':
      if (typeof receiver === 'string') {
        return { handled: true, value: receiver.includes(toText(args[0])) };
      }
      if (Array.isArray(receiver)) {
        return { handled: true, value: receiver.some((item) => looseEquals(item, args[0])) };
      }
      if (receiver instanceof Map) {
        return { handled: true, value: receiver.has(args[0]) };
      }
      if (receiver instanceof Set) {
        return { handled: true, value: receiver.has(args[0]) };
      }
      return { handled: true, value: toText(receiver).includes(toText(args[0])) };
    case 'startswith':
      return { handled: true, value: toText(receiver).startsWith(toText(args[0])) };
    case 'endswith':
      return { handled: true, value: toText(receiver).endsWith(toText(args[0])) };
    case 'tolower':
    case 'tolowercase':
      return { handled: true, value: toText(receiver).toLowerCase() };
    case 'toupper':
    case 'touppercase':
      return { handled: true, value: toText(receiver).toUpperCase() };
    case 'trim':
      return { handled: true, value: toText(receiver).trim() };
    case 'trimstart':
      return { handled: true, value: toText(receiver).replace(/^\s+/, '') };
    case 'trimend':
      return { handled: true, value: toText(receiver).replace(/\s+$/, '') };
    case 'indexof':
      return { handled: true, value: toText(receiver).indexOf(toText(args[0])) };
    case 'substring':
    case 'substr':
    case 'slice': {
      const text = toText(receiver);
      const start = args.length > 0 ? Number(toNumber(args[0]) ?? 0) : 0;
      return {
        handled: true,
        value: args.length > 1 ? text.slice(start, start + Number(toNumber(args[1]) ?? 0)) : text.slice(start)
      };
    }
    case 'length':
    case 'count':
      return { handled: true, value: lengthOf(receiver) };
    case 'any':
      return { handled: true, value: lengthOf(receiver) > 0 };
    case 'tostring':
      return { handled: true, value: toText(receiver) };
    case 'keys': {
      if (receiver instanceof Map) {
        return { handled: true, value: [...receiver.keys()] };
      }
      return { handled: true, value: isPlainRecord(receiver) ? Object.keys(receiver) : [] };
    }
    case 'values': {
      if (receiver instanceof Map) {
        return { handled: true, value: [...receiver.values()] };
      }
      return { handled: true, value: isPlainRecord(receiver) ? Object.values(receiver) : [] };
    }
    case 'has':
    case 'hasownproperty':
      return { handled: true, value: receiver instanceof Map ? receiver.has(args[0]) : memberOf(receiver, toText(args[0])) !== undefined };
    case 'getvalueordefault':
      return { handled: true, value: memberOf(receiver, toText(args[0])) ?? args[1] };
    case 'trygetvalue':
      return { handled: true, value: memberOf(receiver, toText(args[0])) };
    default:
      return { handled: false, value: undefined };
  }
}

function callBuiltin(name: string, args: readonly unknown[]): CallOutcome {
  const lowered = name.toLowerCase();
  if (!BUILTIN_FUNCTIONS.has(lowered)) {
    return { handled: false, value: undefined };
  }
  switch (lowered) {
    case 'isnull':
      return { handled: true, value: args[0] === null || args[0] === undefined || args[0] === '' };
    case 'isnotnull':
      return { handled: true, value: !(args[0] === null || args[0] === undefined || args[0] === '') };
    case 'isempty':
      return { handled: true, value: lengthOf(args[0]) === 0 };
    case 'len':
    case 'length':
    case 'count':
      return { handled: true, value: lengthOf(args[0]) };
    case 'abs':
      return { handled: true, value: Math.abs(toNumber(args[0]) ?? Number.NaN) };
    case 'round': {
      const digits = args.length > 1 ? Number(toNumber(args[1]) ?? 0) : 0;
      const factor = 10 ** digits;
      const value = toNumber(args[0]);
      return { handled: true, value: value === undefined ? Number.NaN : Math.round(value * factor) / factor };
    }
    case 'floor':
      return { handled: true, value: Math.floor(toNumber(args[0]) ?? Number.NaN) };
    case 'ceil':
      return { handled: true, value: Math.ceil(toNumber(args[0]) ?? Number.NaN) };
    case 'sqrt':
      return { handled: true, value: Math.sqrt(toNumber(args[0]) ?? Number.NaN) };
    case 'pow':
      return { handled: true, value: (toNumber(args[0]) ?? Number.NaN) ** (toNumber(args[1]) ?? Number.NaN) };
    case 'min':
      return { handled: true, value: Math.min(...args.map((argument) => toNumber(argument) ?? Number.NaN)) };
    case 'max':
      return { handled: true, value: Math.max(...args.map((argument) => toNumber(argument) ?? Number.NaN)) };
    case 'lower':
    case 'lowercase':
      return { handled: true, value: toText(args[0]).toLowerCase() };
    case 'upper':
    case 'uppercase':
      return { handled: true, value: toText(args[0]).toUpperCase() };
    case 'trim':
      return { handled: true, value: toText(args[0]).trim() };
    case 'contains':
      return { handled: true, value: toText(args[0]).includes(toText(args[1])) };
    case 'startswith':
      return { handled: true, value: toText(args[0]).startsWith(toText(args[1])) };
    case 'endswith':
      return { handled: true, value: toText(args[0]).endsWith(toText(args[1])) };
    case 'indexof':
      return { handled: true, value: toText(args[0]).indexOf(toText(args[1])) };
    case 'matches': {
      try {
        return { handled: true, value: new RegExp(toText(args[1])).test(toText(args[0])) };
      } catch {
        return { handled: true, value: false };
      }
    }
    case 'like':
    case 'ilike':
      return {
        handled: true,
        value: likeToRegExp(toText(args[1]), lowered === 'ilike').test(toText(args[0]))
      };
    case 'date': {
      const value = toDateValue(args[0]);
      return { handled: true, value: value ?? Number.NaN };
    }
    case 'now':
      return { handled: true, value: Date.now() };
    case 'today': {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return { handled: true, value: today.getTime() };
    }
    case 'year':
    case 'month':
    case 'day':
    case 'hour':
    case 'minute':
    case 'second':
    case 'dayofweek':
    case 'dayofyear': {
      const time = toDateValue(args[0]);
      if (time === undefined) {
        return { handled: true, value: Number.NaN };
      }
      const date = new Date(time);
      const value = (() => {
        switch (lowered) {
          case 'year':
            return date.getFullYear();
          case 'month':
            return date.getMonth() + 1;
          case 'day':
            return date.getDate();
          case 'hour':
            return date.getHours();
          case 'minute':
            return date.getMinutes();
          case 'second':
            return date.getSeconds();
          case 'dayofweek':
            return date.getDay();
          default: {
            const start = new Date(date.getFullYear(), 0, 1);
            return Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
          }
        }
      })();
      return { handled: true, value };
    }
    case 'int':
      return { handled: true, value: Math.trunc(toNumber(args[0]) ?? Number.NaN) };
    case 'float':
      return { handled: true, value: toNumber(args[0]) ?? Number.NaN };
    case 'string':
      return { handled: true, value: toText(args[0]) };
    case 'bool':
      return { handled: true, value: truthy(args[0]) };
    case 'concat':
      return { handled: true, value: args.map((argument) => toText(argument)).join('') };
    case 'replace':
      return { handled: true, value: toText(args[0]).split(toText(args[1])).join(toText(args[2])) };
    case 'sum': {
      const numbers = (Array.isArray(args[0]) ? args[0] : args).map((argument) => toNumber(argument) ?? 0);
      return { handled: true, value: numbers.reduce((total, value) => total + value, 0) };
    }
    case 'avg': {
      const numbers = (Array.isArray(args[0]) ? args[0] : args).map((argument) => toNumber(argument) ?? 0);
      return { handled: true, value: numbers.length === 0 ? Number.NaN : numbers.reduce((total, value) => total + value, 0) / numbers.length };
    }
    default:
      return { handled: false, value: undefined };
  }
}

class Evaluator {
  constructor(private readonly context: PreparedContext) {}

  evaluate(node: FilterExpression): unknown {
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'identifier':
        return this.resolveIdentifier(node.name);
      case 'member':
        return memberOf(this.evaluate(node.object), node.name);
      case 'index': {
        const target = this.evaluate(node.object);
        const key = this.evaluate(node.index);
        if (Array.isArray(target)) {
          return target[Number(toNumber(key) ?? 0)];
        }
        return memberOf(target, toText(key));
      }
      case 'call':
        return this.evaluateCall(node);
      case 'unary':
        return node.operator === '!' ? !truthy(this.evaluate(node.operand)) : -(toNumber(this.evaluate(node.operand)) ?? Number.NaN);
      case 'binary':
        return this.evaluateBinary(node.operator, node.left, node.right);
      case 'lambda':
        return this.evaluate(node.body);
      case 'array':
        return node.elements.map((element) => this.evaluate(element));
      default:
        return undefined;
    }
  }

  private resolveIdentifier(name: string): unknown {
    if (name === this.context.parameter) {
      return this.context.rowObject;
    }
    if (this.context.locals.has(name)) {
      return this.context.locals.get(name);
    }
    const index = this.context.columnIndex.get(`${name}`.toLowerCase());
    if (index !== undefined) {
      const column = this.context.columns[index] as ColumnDescriptor;
      const cell = this.context.row.cells[index];
      if (cell) {
        return cellValue(cell, column);
      }
    }
    if (this.context.locals.has(name.toLowerCase())) {
      return this.context.locals.get(name.toLowerCase());
    }
    return undefined;
  }

  private evaluateCall(node: Extract<FilterExpression, { kind: 'call' }>): unknown {
    const methodName = node.callee.kind === 'member' ? node.callee.name : '';
    if (methodName) {
      const receiver = this.evaluate((node.callee as Extract<FilterExpression, { kind: 'member' }>).object);
      const args = node.args.map((argument) => this.evaluate(argument));
      const outcome = callMethod(receiver, methodName, args);
      if (outcome.handled) {
        return outcome.value;
      }
      // Unknown method: fall back to a matching builtin so that `x.City.len()`
      // and similar shapes do not silently return undefined.
      const builtin = callBuiltin(methodName, [receiver, ...args]);
      if (builtin.handled) {
        return builtin.value;
      }
      return undefined;
    }

    const name = calleeName(node.callee);
    const args = node.args.map((argument) => this.evaluate(argument));
    const builtin = callBuiltin(name, args);
    if (builtin.handled) {
      return builtin.value;
    }
    if (this.context.locals.has(name)) {
      const candidate = this.context.locals.get(name);
      if (typeof candidate !== 'function') {
        return candidate;
      }
    }
    return undefined;
  }

  private evaluateBinary(
    operator: string,
    leftNode: FilterExpression,
    rightNode: FilterExpression
  ): unknown {
    if (operator === 'and' || operator === '&&') {
      return truthy(this.evaluate(leftNode)) && truthy(this.evaluate(rightNode));
    }
    if (operator === 'or' || operator === '||') {
      return truthy(this.evaluate(leftNode)) || truthy(this.evaluate(rightNode));
    }
    if (operator === '??') {
      const left = this.evaluate(leftNode);
      return left === null || left === undefined ? this.evaluate(rightNode) : left;
    }

    const left = this.evaluate(leftNode);
    const right = this.evaluate(rightNode);

    switch (operator) {
      case '==':
      case '===':
      case '=':
        return looseEquals(left, right);
      case '!=':
      case '!==':
      case '<>':
        return !looseEquals(left, right);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const comparison = compareValues(left, right);
        if (comparison === undefined) {
          return false;
        }
        switch (operator) {
          case '<':
            return comparison < 0;
          case '<=':
            return comparison <= 0;
          case '>':
            return comparison > 0;
          default:
            return comparison >= 0;
        }
      }
      case 'in': {
        if (Array.isArray(right)) {
          return right.some((item) => looseEquals(left, item));
        }
        if (typeof right === 'string') {
          return right.includes(toText(left));
        }
        return false;
      }
      case 'like':
      case 'ilike':
        return likeToRegExp(toText(right), operator === 'ilike').test(toText(left));
      case '+':
        if (typeof left === 'string' || typeof right === 'string') {
          return toText(left) + toText(right);
        }
        return (toNumber(left) ?? Number.NaN) + (toNumber(right) ?? Number.NaN);
      case '-':
        return (toNumber(left) ?? Number.NaN) - (toNumber(right) ?? Number.NaN);
      case '*':
        return (toNumber(left) ?? Number.NaN) * (toNumber(right) ?? Number.NaN);
      case '/': {
        const divisor = toNumber(right);
        if (divisor === undefined || divisor === 0) {
          return Number.NaN;
        }
        return (toNumber(left) ?? Number.NaN) / divisor;
      }
      case '%': {
        const divisor = toNumber(right);
        if (divisor === undefined || divisor === 0) {
          return Number.NaN;
        }
        return (toNumber(left) ?? Number.NaN) % divisor;
      }
      default:
        return undefined;
    }
  }
}

/** Context prepared for a single row, exposing extra lookup tables. */
interface PreparedContext extends EvaluationContext {
  rowObject: Record<string, unknown>;
  columnIndex: Map<string, number>;
}

/** Evaluates a filter against one row. */
export function evaluateRow(
  expression: FilterExpression,
  row: RowDescriptor,
  columns: readonly ColumnDescriptor[],
  parameter: string,
  locals: ReadonlyMap<string, unknown> = new Map()
): unknown {
  const context = prepareContext(row, columns, parameter, locals);
  return new Evaluator(context).evaluate(expression);
}

function prepareContext(
  row: RowDescriptor,
  columns: readonly ColumnDescriptor[],
  parameter: string,
  locals: ReadonlyMap<string, unknown>
): PreparedContext {
  const columnIndex = new Map<string, number>();
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index] as ColumnDescriptor;
    columnIndex.set(column.key.toLowerCase(), index);
    if (column.path.length === 1) {
      columnIndex.set((column.path[0] as string).toLowerCase(), index);
    }
  }
  const normalizedLocals = new Map<string, unknown>();
  for (const [key, value] of locals) {
    normalizedLocals.set(key, value);
    normalizedLocals.set(key.toLowerCase(), value);
  }
  return {
    row,
    columns,
    parameter: parameter.length > 0 ? parameter : 'x',
    locals: normalizedLocals,
    rowObject: buildRowObject(row, columns),
    columnIndex
  };
}

/** Returns true when the row satisfies the parsed filter. */
export function matchRow(
  parsed: ParsedFilter,
  row: RowDescriptor,
  columns: readonly ColumnDescriptor[],
  locals: ReadonlyMap<string, unknown> = new Map()
): boolean {
  return truthy(evaluateRow(parsed.expression, row, columns, parsed.parameter ?? 'x', locals));
}

/** Applies a parsed filter to a set of rows. */
export function applyFilter(
  parsed: ParsedFilter,
  rows: readonly RowDescriptor[],
  columns: readonly ColumnDescriptor[],
  locals: ReadonlyMap<string, unknown> = new Map()
): RowDescriptor[] {
  return rows.filter((row) => matchRow(parsed, row, columns, locals));
}

/** Names that must be resolved by the debugger: free identifiers that are neither
 * columns nor builtin function names. */
export function unresolvedIdentifiers(
  freeIdentifiers: readonly string[],
  columns: readonly ColumnDescriptor[]
): string[] {
  const known = new Set<string>();
  for (const column of columns) {
    known.add(column.key.toLowerCase());
    if (column.path.length === 1) {
      known.add((column.path[0] as string).toLowerCase());
    }
  }
  return freeIdentifiers.filter((name) => {
    const lowered = name.toLowerCase();
    return !known.has(lowered) && !BUILTIN_FUNCTIONS.has(lowered) && !METHOD_FUNCTIONS.has(lowered);
  });
}
