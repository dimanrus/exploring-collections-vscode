/**
 * A small expression language used for collection filters. The canonical syntax
 * is expression flavoured (`x => x.City == "Seoul" && x.DegreeCelsius > 20`), which is
 * the form most people type, but it also accepts F# style `fun x -> ...`, SQL style
 * `WHERE ...`, and `and` / `or` / `not` keywords.
 */

export type FilterExpression =
  | { kind: 'literal'; value: unknown; raw: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'member'; object: FilterExpression; name: string }
  | { kind: 'index'; object: FilterExpression; index: FilterExpression }
  | { kind: 'call'; callee: FilterExpression; name: string; args: FilterExpression[] }
  | { kind: 'unary'; operator: string; operand: FilterExpression }
  | { kind: 'binary'; operator: string; left: FilterExpression; right: FilterExpression }
  | { kind: 'lambda'; parameter: string; body: FilterExpression }
  | { kind: 'array'; elements: FilterExpression[] };

export interface ParsedFilter {
  expression: FilterExpression;
  /** Parameter name of the lambda when the filter used one. */
  parameter?: string;
}

export class FilterSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number
  ) {
    super(message);
    this.name = 'FilterSyntaxError';
  }
}

type TokenType =
  | 'identifier'
  | 'number'
  | 'string'
  | 'boolean'
  | 'null'
  | 'operator'
  | 'punctuation'
  | 'lambda';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const OPERATORS: readonly string[] = [
  '===',
  '!==',
  '=>',
  '->',
  '==',
  '!=',
  '<>',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '=',
  '<',
  '>',
  '!',
  '+',
  '-',
  '*',
  '/',
  '%'
];

const PUNCTUATION = ['(', ')', '[', ']', ',', '.'];

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'like', 'where', 'fun']);

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const character = input[index] as string;

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const start = index;
      const quote = character;
      index += 1;
      let value = '';
      let closed = false;
      while (index < input.length) {
        const current = input[index] as string;
        if (current === '\\' && index + 1 < input.length) {
          const escaped = input[index + 1] as string;
          value += unescapeCharacter(escaped);
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed) {
        throw new FilterSyntaxError('unterminated string literal', start);
      }
      tokens.push({ type: 'string', value, position: start });
      continue;
    }

    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(input[index + 1] ?? ''))) {
      const start = index;
      while (index < input.length && /[0-9.eE+\-_xa-fA-F]/.test(input[index] as string)) {
        const current = input[index] as string;
        if ((current === '+' || current === '-') && !/[eE]/.test(input[index - 1] ?? '')) {
          break;
        }
        if (current === '.') {
          const next = input[index + 1] ?? '';
          if (!/[0-9]/.test(next) && !/[eE]/.test(input[index - 1] ?? '')) {
            break;
          }
        }
        if ((current === '_' ) && !/0[xX]/.test(input.slice(start, index))) {
          break;
        }
        index += 1;
      }
      tokens.push({ type: 'number', value: input.slice(start, index), position: start });
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      while (index < input.length && isIdentifierPart(input[index] as string)) {
        index += 1;
      }
      if (index === start) {
        // Defensive: never emit an empty token without consuming input, which
        // would make the tokenizer loop forever.
        throw new FilterSyntaxError(`unexpected character '${character}'`, index);
      }
      const value = input.slice(start, index);
      const lowered = value.toLowerCase();
      if (lowered === 'true' || lowered === 'false') {
        tokens.push({ type: 'boolean', value: lowered, position: start });
      } else if (lowered === 'null' || lowered === 'none' || lowered === 'nil') {
        tokens.push({ type: 'null', value: 'null', position: start });
      } else if (KEYWORDS.has(lowered)) {
        tokens.push({ type: 'identifier', value: lowered, position: start });
      } else {
        tokens.push({ type: 'identifier', value, position: start });
      }
      continue;
    }

    const matchedPunctuation = PUNCTUATION.find((candidate) => input.startsWith(candidate, index));
    if (matchedPunctuation) {
      tokens.push({ type: 'punctuation', value: matchedPunctuation, position: index });
      index += matchedPunctuation.length;
      continue;
    }

    const matchedOperator = OPERATORS.find((candidate) => input.startsWith(candidate, index));
    if (matchedOperator) {
      tokens.push({ type: 'operator', value: matchedOperator, position: index });
      index += matchedOperator.length;
      continue;
    }

    throw new FilterSyntaxError(`unexpected character '${character}'`, index);
  }

  return tokens;
}

function unescapeCharacter(character: string): string {
  switch (character) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '0':
      return '\0';
    default:
      return character;
  }
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '??': 1,
  or: 2,
  '||': 2,
  and: 3,
  '&&': 3,
  in: 4,
  like: 4,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<>': 4,
  '=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7
};

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ParsedFilter {
    const parameter = this.tryParseLambdaParameter();
    if (this.tokens.length === 0 && parameter === undefined) {
      throw new FilterSyntaxError('the filter is empty', 0);
    }
    if (parameter !== undefined) {
      this.expectOperator('=>') || this.expectOperator('->');
    }
    const expression = this.parseExpression(0);
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as Token;
      throw new FilterSyntaxError(`unexpected '${token.value}'`, token.position);
    }
    return parameter === undefined ? { expression } : { expression: { kind: 'lambda', parameter, body: expression }, parameter };
  }

  /** Recognizes `x =>`, `(x) =>`, `fun x ->` and SQL `WHERE`. */
  private tryParseLambdaParameter(): string | undefined {
    const first = this.peek();
    if (!first) {
      return undefined;
    }

    if (first.type === 'identifier' && first.value === 'where') {
      this.index += 1;
      return this.tryParseLambdaParameter();
    }

    if (first.type === 'identifier' && first.value === 'fun') {
      this.index += 1;
      const parameter = this.peek();
      if (parameter && parameter.type === 'identifier') {
        this.index += 1;
        this.expectOperator('->');
        return parameter.value;
      }
      throw new FilterSyntaxError('expected a parameter name after `fun`', first.position);
    }

    const next = this.tokens[this.index + 1];
    if (next && next.type === 'operator' && next.value === '=>' && first.type === 'identifier') {
      this.index += 1;
      return first.value;
    }
    if (
      first.type === 'punctuation' &&
      first.value === '(' &&
      next &&
      next.type === 'identifier'
    ) {
      const closing = this.tokens[this.index + 2];
      const arrow = this.tokens[this.index + 3];
      if (
        closing &&
        closing.type === 'punctuation' &&
        closing.value === ')' &&
        arrow &&
        arrow.type === 'operator' &&
        arrow.value === '=>'
      ) {
        this.index += 4;
        return next.value;
      }
    }
    return undefined;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private expectOperator(value: string): boolean {
    const token = this.peek();
    if (token && token.type === 'operator' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private parseExpression(minPrecedence: number): FilterExpression {
    let left = this.parseUnary();

    while (true) {
      const token = this.peek();
      if (!token) {
        break;
      }
      let operator: string | undefined;
      if (token.type === 'operator' && BINARY_PRECEDENCE[token.value] !== undefined) {
        operator = token.value;
      } else if (token.type === 'identifier' && BINARY_PRECEDENCE[token.value] !== undefined) {
        operator = token.value;
      } else if (token.type === 'operator' && token.value === '=') {
        operator = '=';
      }
      if (operator === undefined) {
        break;
      }
      const precedence = BINARY_PRECEDENCE[operator] ?? 0;
      if (precedence < minPrecedence) {
        break;
      }
      this.index += 1;
      const right = this.parseExpression(precedence + 1);
      left = { kind: 'binary', operator, left, right };
    }

    return left;
  }

  private parseUnary(): FilterExpression {
    const token = this.peek();
    if (token && token.type === 'operator' && (token.value === '!' || token.value === '-')) {
      this.index += 1;
      return { kind: 'unary', operator: token.value, operand: this.parseUnary() };
    }
    if (token && token.type === 'identifier' && token.value === 'not') {
      this.index += 1;
      return { kind: 'unary', operator: '!', operand: this.parseUnary() };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePrimary(): FilterExpression {
    const token = this.peek();
    if (!token) {
      throw new FilterSyntaxError('unexpected end of expression', this.previousPosition());
    }
    this.index += 1;

    switch (token.type) {
      case 'number':
        return { kind: 'literal', value: parseNumberLiteral(token.value), raw: token.value };
      case 'string':
        // `raw` keeps a quoted, escaped form so the literal can be re-emitted for
        // another language (native pushdown) without corrupting its content.
        return { kind: 'literal', value: token.value, raw: quoteString(token.value) };
      case 'boolean':
        return { kind: 'literal', value: token.value === 'true', raw: token.value };
      case 'null':
        return { kind: 'literal', value: null, raw: 'null' };
      case 'identifier':
        return { kind: 'identifier', name: token.value };
      case 'punctuation':
        if (token.value === '(') {
          // `(a, b)` is an implicit array, used by the `in` operator.
          if (this.currentIsCommaSeparatedList()) {
            return this.parseArrayLiteral();
          }
          const expression = this.parseExpression(0);
          const closing = this.peek();
          if (!closing || closing.type !== 'punctuation' || closing.value !== ')') {
            throw new FilterSyntaxError('expected `)`', token.position);
          }
          this.index += 1;
          return expression;
        }
        if (token.value === '[') {
          return this.parseArrayLiteral();
        }
        throw new FilterSyntaxError(`unexpected '${token.value}'`, token.position);
      default:
        throw new FilterSyntaxError(`unexpected '${token.value}'`, token.position);
    }
  }

  private currentIsCommaSeparatedList(): boolean {
    const next = this.peek();
    if (!next) {
      return false;
    }
    if (next.type === 'punctuation' && next.value === ')') {
      return true;
    }
    return this.hasTopLevelCommaUntilClose();
  }

  private hasTopLevelCommaUntilClose(): boolean {
    let depth = 0;
    for (let cursor = this.index; cursor < this.tokens.length; cursor += 1) {
      const token = this.tokens[cursor] as Token;
      if (token.type === 'punctuation' && (token.value === '(' || token.value === '[')) {
        depth += 1;
        continue;
      }
      if (token.type === 'punctuation' && (token.value === ')' || token.value === ']')) {
        if (depth === 0) {
          return false;
        }
        depth -= 1;
        continue;
      }
      if (token.type === 'punctuation' && token.value === ',' && depth === 0) {
        return true;
      }
    }
    return false;
  }

  private parseArrayLiteral(): FilterExpression {
    const elements: FilterExpression[] = [];
    const opener = this.tokens[this.index - 1] as Token;
    const closer = opener.value === '[' ? ']' : ')';
    if (this.peekIsPunctuation(closer)) {
      this.index += 1;
      return { kind: 'array', elements };
    }
    while (true) {
      elements.push(this.parseExpression(0));
      if (this.peekIsPunctuation(',')) {
        this.index += 1;
        continue;
      }
      break;
    }
    if (!this.peekIsPunctuation(closer)) {
      throw new FilterSyntaxError(`expected '${closer}'`, opener.position);
    }
    this.index += 1;
    return { kind: 'array', elements };
  }

  private peekIsPunctuation(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.type === 'punctuation' && token.value === value;
  }

  private parsePostfix(expression: FilterExpression): FilterExpression {
    let current = expression;
    while (true) {
      const token = this.peek();
      if (!token) {
        return current;
      }
      if (token.type === 'punctuation' && token.value === '.') {
        this.index += 1;
        const nameToken = this.peek();
        if (!nameToken || (nameToken.type !== 'identifier' && nameToken.type !== 'number')) {
          throw new FilterSyntaxError('expected a member name after `.`', token.position);
        }
        this.index += 1;
        current = { kind: 'member', object: current, name: nameToken.value };
        continue;
      }
      if (token.type === 'punctuation' && token.value === '[') {
        this.index += 1;
        const indexExpression = this.parseExpression(0);
        if (!this.peekIsPunctuation(']')) {
          throw new FilterSyntaxError('expected `]`', token.position);
        }
        this.index += 1;
        current = { kind: 'index', object: current, index: indexExpression };
        continue;
      }
      if (token.type === 'punctuation' && token.value === '(') {
        const name = calleeName(current);
        this.index += 1;
        const args: FilterExpression[] = [];
        if (!this.peekIsPunctuation(')')) {
          while (true) {
            args.push(this.parseExpression(0));
            if (this.peekIsPunctuation(',')) {
              this.index += 1;
              continue;
            }
            break;
          }
        }
        if (!this.peekIsPunctuation(')')) {
          throw new FilterSyntaxError('expected `)`', token.position);
        }
        this.index += 1;
        current = { kind: 'call', callee: current, name, args };
        continue;
      }
      return current;
    }
  }

  private previousPosition(): number {
    const previous = this.tokens[this.index - 1];
    return previous ? previous.position + previous.value.length : 0;
  }
}

/** Quotes and escapes a string so it can be emitted as source code. */
export function quoteString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** The name a call is dispatched on: the last member or the identifier itself. */
export function calleeName(expression: FilterExpression): string {
  if (expression.kind === 'member') {
    return expression.name;
  }
  if (expression.kind === 'identifier') {
    return expression.name;
  }
  return '';
}

function parseNumberLiteral(raw: string): number {
  const cleaned = raw.replace(/_/g, '').replace(/[fFdDmMlLuU]+$/, '');
  if (/^[+-]?0[xX]/.test(cleaned)) {
    return Number.parseInt(cleaned.replace(/^[+-]?0[xX]/, ''), 16);
  }
  const value = Number(cleaned);
  return Number.isNaN(value) ? Number.NaN : value;
}

/** Parses a filter string into an expression tree. */
export function parseFilter(input: string): ParsedFilter {
  const tokens = tokenize(input);
  return new Parser(tokens).parse();
}

/** Names referenced by the expression that are not the lambda parameter. */
export function collectFreeIdentifiers(parsed: ParsedFilter): string[] {
  const free = new Set<string>();
  const parameter = parsed.parameter;

  const visit = (node: FilterExpression): void => {
    switch (node.kind) {
      case 'identifier':
        if (node.name !== parameter) {
          free.add(node.name);
        }
        return;
      case 'member':
        visit(node.object);
        return;
      case 'index':
        visit(node.object);
        visit(node.index);
        return;
      case 'call':
        // Only dispatch names, not method receivers, are candidates for locals.
        if (node.callee.kind === 'identifier' && node.callee.name !== parameter) {
          // A bare `foo(...)` may still be a column holding a function value; the
          // caller decides whether the name exists as a column or a local.
          free.add(node.callee.name);
        } else {
          visit(node.callee);
        }
        for (const argument of node.args) {
          visit(argument);
        }
        return;
      case 'unary':
        visit(node.operand);
        return;
      case 'binary':
        visit(node.left);
        visit(node.right);
        return;
      case 'lambda':
        visit(node.body);
        return;
      case 'array':
        for (const element of node.elements) {
          visit(element);
        }
        return;
      default:
        return;
    }
  };

  visit(parsed.expression);
  return [...free];
}

/** Re-serializes an expression using the canonical `x => x.A == 1` syntax. */
export function formatExpression(expression: FilterExpression, parameter = 'x'): string {
  switch (expression.kind) {
    case 'literal':
      return expression.raw;
    case 'identifier':
      return expression.name;
    case 'member':
      return `${formatExpression(expression.object, parameter)}.${expression.name}`;
    case 'index':
      return `${formatExpression(expression.object, parameter)}[${formatExpression(expression.index, parameter)}]`;
    case 'call':
      return `${formatExpression(expression.callee, parameter)}(${expression.args
        .map((argument) => formatExpression(argument, parameter))
        .join(', ')})`;
    case 'unary':
      return `${expression.operator}${formatExpression(expression.operand, parameter)}`;
    case 'binary':
      return `${formatExpression(expression.left, parameter)} ${expression.operator} ${formatExpression(
        expression.right,
        parameter
      )}`;
    case 'lambda':
      return `${expression.parameter} => ${formatExpression(expression.body, parameter)}`;
    case 'array':
      return `(${expression.elements.map((element) => formatExpression(element, parameter)).join(', ')})`;
    default:
      return '';
  }
}
