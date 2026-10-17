import { calleeName, formatExpression, type FilterExpression } from './expression';

/**
 * Emits a filter expression in the syntax of a target language. Translating the
 * AST instead of rewriting text keeps string literals intact and makes the
 * difference between languages explicit and testable.
 */
export interface EmitDialect {
  /** Equality operator, e.g. `==` (C#), `=` (F#) or `===` (JavaScript). */
  equality: string;
  /** Inequality operator, e.g. `!=`, `<>` or `!==`. */
  inequality: string;
  and: string;
  or: string;
  not: string;
  /** Literal used for null, e.g. `null` or `None`. */
  nullLiteral: string;
  /** Emits a boolean literal (`true` / `True`). */
  booleanLiteral(parameter: boolean): string;
  /** Overrides a method call; return `undefined` for the default rendering. */
  method?(receiver: string, name: string, args: string[]): string | undefined;
  /** Overrides a global function call; return `undefined` for the default. */
  call?(
    name: string,
    args: string[],
    emit: (expression: FilterExpression) => string
  ): string | undefined;
  /** Emits a member access such as `x.City`. */
  member?(object: string, name: string): string | undefined;
  /** Operators that the dialect cannot express, e.g. `like` in F#. */
  unsupported?: ReadonlySet<string>;
}

export interface EmitResult {
  text: string;
  /** False when something had to be approximated. */
  exact: boolean;
  notes: string[];
}

export interface EmitBodyOptions {
  /** Lambda parameter used by the parsed filter (usually `x`). */
  sourceParameter: string;
  /** Parameter name the emitted code must use. */
  targetParameter: string;
  dialect: EmitDialect;
}

/** Emits the body of a lambda in the syntax described by the dialect. */
export function emitBody(body: FilterExpression, options: EmitBodyOptions): EmitResult {
  const { sourceParameter, targetParameter, dialect } = options;
  const notes: string[] = [];
  let exact = true;

  const emit = (expression: FilterExpression): string => {
    switch (expression.kind) {
      case 'literal':
        if (expression.value === null) {
          return dialect.nullLiteral;
        }
        if (typeof expression.value === 'boolean') {
          return dialect.booleanLiteral(expression.value);
        }
        if (typeof expression.value === 'string') {
          return expression.raw.startsWith('"') ? expression.raw : JSON.stringify(expression.value);
        }
        return expression.raw;
      case 'identifier':
        return expression.name === sourceParameter ? targetParameter : expression.name;
      case 'member': {
        const object = emit(expression.object);
        const custom = dialect.member?.(object, expression.name);
        return custom ?? `${object}.${expression.name}`;
      }
      case 'index':
        return `${emit(expression.object)}[${emit(expression.index)}]`;
      case 'call': {
        const args = expression.args.map((argument) => emit(argument));
        if (expression.callee.kind === 'member') {
          const receiver = emit(expression.callee.object);
          const custom = dialect.method?.(receiver, expression.callee.name, args);
          if (custom !== undefined) {
            return custom;
          }
          return `${receiver}.${expression.callee.name}(${args.join(', ')})`;
        }
        const name = calleeName(expression.callee);
        const custom = dialect.call?.(name, args, emit);
        if (custom !== undefined) {
          return custom;
        }
        notes.push(`'${name}' is evaluated on the client`);
        exact = false;
        return `${name}(${args.join(', ')})`;
      }
      case 'unary':
        return expression.operator === '!'
          ? `${dialect.not}${wrap(emit(expression.operand))}`
          : `-${wrap(emit(expression.operand))}`;
      case 'binary': {
        const operator = mapOperator(expression.operator, dialect);
        if (dialect.unsupported?.has(expression.operator)) {
          notes.push(`the '${expression.operator}' operator is evaluated on the client`);
          exact = false;
        }
        const left = emit(expression.left);
        const right = emit(expression.right);
        if (operator === null) {
          notes.push(`the '${expression.operator}' operator is evaluated on the client`);
          exact = false;
          return `${wrap(left)} && ${wrap(right)}`;
        }
        return `${wrap(left)} ${operator} ${wrap(right)}`;
      }
      case 'array':
        return `[${expression.elements.map((element) => emit(element)).join(', ')}]`;
      case 'lambda':
        return emit(expression.body);
      default:
        return '';
    }
  };

  const text = emit(body);
  return { text, exact, notes };
}

function wrap(value: string): string {
  return needsParentheses(value) ? `(${value})` : value;
}

/**
 * Reports whether an emitted fragment needs parentheses when it becomes the
 * operand of another operator. Anything without a top level operator (a call, a
 * member access, a literal or an already parenthesized group) can stay as it is,
 * which keeps the generated expression readable.
 */
function needsParentheses(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith('(') && isBalanced(trimmed)) {
    return false;
  }
  let depth = 0;
  let inString = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] as string;
    if (inString) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '(' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ' 	<>=!&|+*/%'.includes(character)) {
      return true;
    }
    if (depth === 0 && character === '-' && index > 0) {
      return true;
    }
  }
  return false;
}

/** True when the fragment is fully wrapped in one pair of parentheses. */
function isBalanced(value: string): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (inString) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0 && index < value.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

function mapOperator(operator: string, dialect: EmitDialect): string | null {
  switch (operator) {
    case '==':
    case '===':
    case '=':
      return dialect.equality;
    case '!=':
    case '!==':
    case '<>':
      return dialect.inequality;
    case '&&':
    case 'and':
      return dialect.and;
    case '||':
    case 'or':
      return dialect.or;
    case 'in':
      return null;
    case 'like':
    case 'ilike':
      return null;
    default:
      return operator;
  }
}

/** Canonical text of a body, used for diagnostics and for the UI echo. */
export function canonicalBody(body: FilterExpression, parameter: string): string {
  return formatExpression(body, parameter);
}
