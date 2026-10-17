/**
 * Reads collection literals straight out of the source text.
 *
 * A debug session is not always available: while a developer writes fixture
 * data into the code there is nothing to attach a debugger to, yet the data is
 * already there. This module finds declarations such as
 *
 * ```ts
 * const temperatures = [{ city: 'Seoul', degrees: 21 }, { city: 'Busan', degrees: 24 }];
 * ```
 *
 * and turns them into rows, so the viewer can be opened without debugging.
 *
 * The parser is deliberately forgiving: anything it cannot represent becomes a
 * `null` cell and the number of such values is reported back to the caller.
 */

import type { FormatOptions } from '../model/formatter';
import { buildSnapshot, withRows, type ElementNode } from '../model/snapshotBuilder';
import type { CollectionSnapshot } from '../model/types';
import { applyFilter } from '../filter/evaluator';
import { formatExpression, parseFilter } from '../filter/expression';
import type { FilterOutcome } from '../providers/capturer';

/**
 * Languages whose collection literals the preview understands.
 *
 * JSON documents use the property pattern, everything else the assignment
 * pattern.
 */
export const LITERAL_LANGUAGES = [
  'csharp',
  'fsharp',
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'json',
  'jsonc'
];

/** Marker for a value the parser could not represent. */
const UNKNOWN = Symbol('unknown');

type ParsedValue = unknown | typeof UNKNOWN;

/** A literal collection found in a document. */
export interface LiteralCollection {
  /** Zero based line of the declaration that owns the literal. */
  line: number;
  /** Identifier the literal is assigned to, when the source names one. */
  name?: string;
  /** Rows ready for the snapshot builder. */
  rows: Record<string, unknown>[];
  /** Values that had to be replaced with `null`. */
  unknownValues: number;
  /** Offset of the opening bracket inside the document text. */
  offset: number;
  /** Offset just behind the literal. */
  end: number;
}

export interface LiteralSnapshotOptions {
  formatOptions: FormatOptions;
  columnOrder: 'alphabetical' | 'discovery';
  flattenDepth: number;
  /** Session identifier stored in the snapshot; kept stable so the panel is reused. */
  sessionId?: string;
  /** Notes added to the snapshot diagnostics. */
  notes?: string[];
  /** Warnings added to the snapshot. */
  warnings?: string[];
  /** Document uri the literal was read from. */
  uri?: string;
  /** Language id of the document, shown in the viewer. */
  language?: string;
}

/* ------------------------------------------------------------------ parser */

class LiteralParser {
  private readonly text: string;
  private unknowns = 0;
  private stringKeys = 0;
  private totalKeys = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(offset: number): { value: unknown; next: number; unknownValues: number } | undefined {
    const parsed = this.value(offset);
    if (!parsed || parsed.value === UNKNOWN) {
      return undefined;
    }
    return { value: parsed.value, next: parsed.next, unknownValues: this.unknowns };
  }

  /** True when every key of the parsed objects was a quoted string. */
  get quotedKeys(): boolean {
    return this.totalKeys > 0 && this.stringKeys === this.totalKeys;
  }

  /* -- trivia ------------------------------------------------------------ */

  private skip(i: number): number {
    const text = this.text;
    for (;;) {
      while (i < text.length && isSpace(text[i] as string)) {
        i += 1;
      }
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i);
        i = end === -1 ? text.length : end + 1;
        continue;
      }
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
        continue;
      }
      // `#` is not a comment in the supported languages, but the scanner also
      // sees embedded JSON and must not treat a `#` inside a string as one.
      if (text[i] === '#' && text[i + 1] !== '[' && text[i + 1] !== '!') {
        const end = text.indexOf('\n', i);
        i = end === -1 ? text.length : end + 1;
        continue;
      }
      return i;
    }
  }

  /* -- values ------------------------------------------------------------ */

  private value(i: number): { value: ParsedValue; next: number } | undefined {
    const start = this.skip(i);
    const ch = this.text[start];
    if (ch === undefined) {
      return undefined;
    }
    if (ch === '[') {
      return this.array(start);
    }
    if (ch === '{') {
      return this.braces(start);
    }
    if (ch === '(') {
      return this.paren(start);
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      return this.string(start);
    }
    if (ch === '@' && this.text[start + 1] === '"') {
      return this.string(start + 1, true);
    }
    if (ch === '&') {
      const inner = this.value(this.skip(start + 1));
      if (!inner) {
        return undefined;
      }
      return inner;
    }
    if (ch === '-' || ch === '+' || isDigit(ch)) {
      const number = this.number(start);
      if (number) {
        return number;
      }
    }
    const word = this.word(start);
    if (!word) {
      return undefined;
    }
    switch (word.value) {
      case 'true':
      case 'True':
        return { value: true, next: word.next };
      case 'false':
      case 'False':
        return { value: false, next: word.next };
      case 'null':
      case 'None':
      case 'nil':
      case 'undefined':
        return { value: null, next: word.next };
      case 'NaN':
        return { value: null, next: word.next };
      case 'new':
        return this.constructed(word.next);
      case 'vec': {
        const bang = this.skip(word.next);
        if (this.text[bang] === '!') {
          const bracket = this.skip(bang + 1);
          if (this.text[bracket] === '[') {
            return this.array(bracket);
          }
        }
        return { value: UNKNOWN, next: word.next };
      }
      case 'array':
      case 'list':
      case 'set':
      case 'tuple':
      case 'dict':
      case 'List':
      case 'Vector': {
        const paren = this.skip(word.next);
        if (this.text[paren] === '(') {
          return this.paren(paren);
        }
        return { value: UNKNOWN, next: word.next };
      }
      case 'mut':
        return this.value(word.next);
      default:
        break;
    }
    // A member, index or call expression such as `items[0]`, `City.Name` or
    // `Compute()` is not a literal: consume the whole chain so the container
    // does not try to parse its parts as values.
    const chain =
      /^[A-Za-z_$][\w$]*(?:\s*(?:\.|::)\s*[A-Za-z_$][\w$]*|\[[^\]\n]{0,80}\])*/.exec(
        this.text.slice(start)
      );
    let end = chain ? start + chain[0].length : word.next;
    const paren = /^\s*\(/.exec(this.text.slice(end));
    if (paren) {
      const open = end + paren[0].length - 1;
      const close = matchBracket(this.text, open, '(', ')');
      end = close === undefined ? end : close + 1;
    }
    // `Temperature { Celsius = 21 }` (record/struct literal, C# object
    // initializer without `new`): a type name followed by a brace block.
    const after = this.skip(end);
    if (this.text[after] === '{' && !CONTROL_KEYWORDS.has(word.value) && /^[A-Z]/.test(word.value)) {
      return this.braces(after);
    }
    return { value: UNKNOWN, next: end > start ? end : word.next };
  }

  /** Parses what follows `new`: `new[] {…}`, `new T(…)`, `new T {…}`. */
  private constructed(i: number): { value: ParsedValue; next: number } | undefined {
    let cursor = this.skip(i);
    if (this.text[cursor] === '[' && this.text[cursor + 1] === ']') {
      const brace = this.skip(cursor + 2);
      if (this.text[brace] === '{') {
        return this.braces(brace);
      }
    }
    const type = this.typeName(cursor);
    if (type) {
      cursor = type.next;
    }
    const after = this.skip(cursor);
    if (this.text[after] === '(') {
      return this.paren(after);
    }
    if (this.text[after] === '{') {
      return this.braces(after);
    }
    if (this.text[after] === '[' && this.text[after + 1] === ']') {
      const brace = this.skip(after + 2);
      if (this.text[brace] === '{') {
        return this.braces(brace);
      }
    }
    return type ? { value: UNKNOWN, next: type.next } : undefined;
  }

  /** Reads a type expression such as `List<Temperature>`, `[]int` or `Foo.Bar`. */
  private typeName(i: number): { next: number } | undefined {
    const match = /^[A-Za-z_$][\w$.]*(?:<(?:[^<>{}]|<[^<>{}]*>)*>)?(?:\[\])?/.exec(this.text.slice(i));
    if (!match || match[0].length === 0) {
      return undefined;
    }
    return { next: i + match[0].length };
  }

  /* -- containers -------------------------------------------------------- */

  private array(i: number): { value: unknown[]; next: number } | undefined {
    const items: unknown[] = [];
    let unreadable = 0;
    // A container whose values could not be read at all is not a collection:
    // `{ readings }` is a shorthand property list, `[Load(), Parse()]` is code.
    const done = (
      next: number
    ): { value: unknown[]; next: number } | undefined =>
      items.length === 0 || unreadable === items.length ? undefined : { value: items, next };

    let cursor = this.skip(i + 1);
    if (this.text[cursor] === ']') {
      return undefined;
    }
    let guard = 0;
    while (cursor < this.text.length && guard < 10000) {
      guard += 1;
      if (this.text[cursor] === ']') {
        return done(cursor + 1);
      }
      const item = this.value(cursor);
      if (!item) {
        this.unknowns += 1;
        unreadable += 1;
        items.push(null);
        const skipped = this.skipEntry(cursor);
        if (skipped === undefined) {
          break;
        }
        cursor = this.skip(skipped);
      } else {
        if (item.value === UNKNOWN) {
          this.unknowns += 1;
          unreadable += 1;
        }
        items.push(item.value === UNKNOWN ? null : item.value);
        cursor = this.skip(item.next);
      }
      const separator = this.text[cursor];
      if (separator === ',' || separator === ';') {
        const next = this.skip(cursor + 1);
        if (this.text[next] === ']') {
          return done(next + 1);
        }
        cursor = next;
        continue;
      }
      if (separator === ']') {
        return done(cursor + 1);
      }
      // A newline separated list (F#) has no separator at all: try to
      // read the next element, and fall back to what was read so far when the
      // token cannot start a value (`1..10`, a spread, an unparsable element).
      const next = this.value(cursor);
      if (next && next.next > cursor) {
        items.push(next.value === UNKNOWN ? null : next.value);
        if (next.value === UNKNOWN) {
          this.unknowns += 1;
          unreadable += 1;
        }
        cursor = this.skip(next.next);
        continue;
      }
      break;
    }
    return done(cursor);
  }

  /** Parses the entries of a brace block that holds values instead of members. */
  private arrayLike(i: number, closing: string): { value: unknown[]; next: number } | undefined {
    const items: unknown[] = [];
    let unreadable = 0;
    let cursor = i;
    let guard = 0;
    while (cursor < this.text.length && guard < 10000) {
      guard += 1;
      if (this.text[cursor] === closing) {
        cursor = this.skip(cursor + 1);
        break;
      }
      const item = this.value(cursor);
      if (!item) {
        this.unknowns += 1;
        unreadable += 1;
        items.push(null);
        const skipped = this.skipEntry(cursor);
        if (skipped === undefined) {
          break;
        }
        cursor = this.skip(skipped);
      } else {
        if (item.value === UNKNOWN) {
          this.unknowns += 1;
          unreadable += 1;
        }
        items.push(item.value === UNKNOWN ? null : item.value);
        cursor = this.skip(item.next);
      }
      if (this.text[cursor] === ',' || this.text[cursor] === ';') {
        cursor = this.skip(cursor + 1);
      }
    }
    if (items.length === 0 || unreadable === items.length) {
      return undefined;
    }
    return { value: items, next: cursor };
  }

  /** Parses `{ … }` either as an object/map or as a plain list of values. */
  private braces(i: number): { value: unknown; next: number } | undefined {
    const first = this.skip(i + 1);
    if (this.text[first] === '}') {
      return { value: {}, next: first + 1 };
    }
    if (!this.entryIsMember(first)) {
      return this.arrayLike(first, '}');
    }
    return this.members(i);
  }

  private members(i: number): { value: Record<string, unknown>; next: number } {
    const result: Record<string, unknown> = {};
    let cursor = this.skip(i + 1);
    let guard = 0;
    while (cursor < this.text.length && this.text[cursor] !== '}' && guard < 10000) {
      guard += 1;
      const key = this.memberKey(cursor);
      if (!key) {
        this.unknowns += 1;
        const skipped = this.skipEntry(cursor);
        if (skipped === undefined) {
          break;
        }
        cursor = this.skip(skipped);
        if (this.text[cursor] === ',' || this.text[cursor] === ';') {
          cursor = this.skip(cursor + 1);
        }
        continue;
      }
      this.totalKeys += 1;
      if (key.quoted) {
        this.stringKeys += 1;
      }
      let valueAt = this.skip(key.next);
      if (this.text[valueAt] === ':' || (this.text[valueAt] === '=' && this.text[valueAt + 1] !== '=')) {
        valueAt = this.skip(valueAt + 1);
      } else if (this.text.startsWith('=>', valueAt)) {
        valueAt = this.skip(valueAt + 2);
      }
      const item = this.value(valueAt);
      if (!item) {
        this.unknowns += 1;
        setPath(result, key.path, null);
        const skipped = this.skipEntry(valueAt);
        if (skipped === undefined) {
          break;
        }
        cursor = this.skip(skipped);
      } else {
        if (item.value === UNKNOWN) {
          this.unknowns += 1;
        }
        setPath(result, key.path, item.value === UNKNOWN ? null : item.value);
        cursor = this.skip(item.next);
      }
      if (this.text[cursor] === ',' || this.text[cursor] === ';') {
        cursor = this.skip(cursor + 1);
      }
    }
    return { value: result, next: cursor < this.text.length ? cursor + 1 : cursor };
  }

  /** Parses `( … )`: named constructor arguments or positional ones. */
  private paren(i: number): { value: unknown; next: number } | undefined {
    const positional: unknown[] = [];
    const named: Record<string, unknown> = {};
    let namedCount = 0;
    let cursor = this.skip(i + 1);
    if (this.text[cursor] === ')') {
      return { value: {}, next: cursor + 1 };
    }
    let guard = 0;
    let closed = false;
    while (cursor < this.text.length && this.text[cursor] !== ')' && guard < 10000) {
      guard += 1;
      const key = this.memberKey(cursor);
      const afterKey = key ? this.skip(key.next) : cursor;
      const isNamed =
        key !== undefined &&
        (this.text[afterKey] === ':' ||
          (this.text[afterKey] === '=' && this.text[afterKey + 1] !== '='));
      if (key && isNamed) {
        this.totalKeys += 1;
        if (key.quoted) {
          this.stringKeys += 1;
        }
        const item = this.value(this.skip(afterKey + 1));
        namedCount += 1;
        if (!item) {
          this.unknowns += 1;
          setPath(named, key.path, null);
          const skipped = this.skipEntry(this.skip(afterKey + 1));
          if (skipped === undefined) {
            break;
          }
          cursor = this.skip(skipped);
        } else {
          if (item.value === UNKNOWN) {
            this.unknowns += 1;
          }
          setPath(named, key.path, item.value === UNKNOWN ? null : item.value);
          cursor = this.skip(item.next);
        }
      } else {
        const item = this.value(cursor);
        if (!item) {
          this.unknowns += 1;
          positional.push(null);
          const skipped = this.skipEntry(cursor);
          if (skipped === undefined) {
            break;
          }
          cursor = this.skip(skipped);
        } else {
          if (item.value === UNKNOWN) {
            this.unknowns += 1;
          }
          positional.push(item.value === UNKNOWN ? null : item.value);
          cursor = this.skip(item.next);
        }
      }
      if (this.text[cursor] === ',' || this.text[cursor] === ';') {
        cursor = this.skip(cursor + 1);
        continue;
      }
      if (this.text[cursor] === ')') {
        closed = true;
        cursor += 1;
        break;
      }
      break;
    }
    if (!closed && this.text[cursor] === ')') {
      cursor += 1;
      closed = true;
    }
    const result: Record<string, unknown> = { ...named };
    positional.forEach((item, index) => {
      result[`Item${index + 1}`] = item;
    });
    if (Object.keys(result).length === 0 && positional.length === 0 && namedCount === 0) {
      return { value: {}, next: cursor };
    }
    return { value: result, next: cursor };
  }

  /* -- leaves ------------------------------------------------------------ */

  private memberKey(
    i: number
  ): { path: string[]; next: number; quoted: boolean } | undefined {
    const ch = this.text[i];
    if (ch === undefined) {
      return undefined;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const parsed = this.string(i);
      if (!parsed) {
        return undefined;
      }
      return { path: [String(parsed.value)], next: parsed.next, quoted: true };
    }
    if (ch === '@' && this.text[i + 1] === '"') {
      const parsed = this.string(i + 1, true);
      return parsed ? { path: [String(parsed.value)], next: parsed.next, quoted: true } : undefined;
    }
    if (ch === '@') {
      const word = this.word(i + 1);
      return word ? { path: [word.value], next: word.next, quoted: false } : undefined;
    }
    if (ch === '[') {
      const end = matchBracket(this.text, i, '[', ']');
      if (end === undefined) {
        return undefined;
      }
      const inner = this.text.slice(i + 1, end).trim();
      // `["Seoul"] = 21` is a dictionary entry with a quoted key.
      const quoted = /^["'`].*["'`]$/.test(inner);
      return {
        path: [quoted ? inner.slice(1, -1) : inner],
        next: end + 1,
        quoted
      };
    }
    if (isDigit(ch)) {
      const number = this.number(i);
      return number
        ? { path: [formatNumber(number.value)], next: number.next, quoted: false }
        : undefined;
    }
    if (isIdentifierStart(ch)) {
      const match = /^[A-Za-z_$][\w$]*(?:\s*(?:\.|::)\s*[A-Za-z_$][\w$]*)*/.exec(this.text.slice(i));
      if (!match) {
        return undefined;
      }
      const path = match[0]
        .split(/\.|::/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      return { path, next: i + match[0].length, quoted: false };
    }
    return undefined;
  }

  private string(
    i: number,
    verbatim = false
  ): { value: string | typeof UNKNOWN; next: number } | undefined {
    const quote = this.text[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      return undefined;
    }
    const triple = this.text.startsWith(quote.repeat(3), i);
    if (triple) {
      const end = this.text.indexOf(quote.repeat(3), i + 3);
      if (end === -1) {
        return undefined;
      }
      return { value: this.text.slice(i + 3, end), next: end + 3 };
    }
    let value = '';
    let cursor = i + 1;
    while (cursor < this.text.length) {
      const ch = this.text[cursor] as string;
      if (ch === '\\' && !verbatim) {
        const escaped = this.escape(cursor);
        if (!escaped) {
          value += ch;
          cursor += 1;
          continue;
        }
        value += escaped.text;
        cursor = escaped.next;
        continue;
      }
      if (ch === quote) {
        if (this.text[cursor + 1] === quote && quote !== '`') {
          value += quote;
          cursor += 2;
          continue;
        }
        return { value, next: cursor + 1 };
      }
      if (quote === '`' && ch === '$' && this.text[cursor + 1] === '{') {
        return { value: UNKNOWN, next: cursor + 1 };
      }
      if (ch === '\n' && quote !== '`') {
        return undefined;
      }
      value += ch;
      cursor += 1;
    }
    return undefined;
  }

  private escape(i: number): { text: string; next: number } | undefined {
    const ch = this.text[i + 1];
    if (ch === undefined) {
      return undefined;
    }
    const simple: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      0: '\0',
      b: '\b',
      f: '\f',
      v: '\v'
    };
    if (ch in simple) {
      return { text: simple[ch] as string, next: i + 2 };
    }
    if (ch === 'u' || ch === 'x') {
      const length = ch === 'u' ? 4 : 2;
      const digits = this.text.slice(i + 2, i + 2 + length);
      if (new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) {
        return { text: String.fromCharCode(Number.parseInt(digits, 16)), next: i + 2 + length };
      }
    }
    return { text: ch, next: i + 2 };
  }

  private number(i: number): { value: number; next: number } | undefined {
    const match =
      /^[-+]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?)(?:[fFdDmMlLuU]*)/.exec(
        this.text.slice(i)
      );
    if (!match) {
      return undefined;
    }
    let raw = match[0].replace(/_/g, '');
    let consumed = match[0].length;
    // `1..10` is a range, not a decimal with a trailing dot.
    if (raw.endsWith('.') && this.text[i + consumed] === '.') {
      raw = raw.slice(0, -1);
      consumed -= 1;
    }
    let value: number;
    if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(raw)) {
      value = Number.parseInt(raw, 16);
    } else if (/^[-+]?0[bB][01]+$/.test(raw)) {
      const negative = raw.startsWith('-');
      value = Number.parseInt(raw.replace(/^[-+]?0[bB]/, ''), 2) * (negative ? -1 : 1);
    } else {
      value = Number.parseFloat(raw.replace(/[fFdDmMlLuU]+$/, ''));
    }
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return { value, next: i + consumed };
  }

  private word(i: number): { value: string; next: number } | undefined {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.text.slice(i));
    return match ? { value: match[0], next: i + match[0].length } : undefined;
  }

  /* -- helpers ----------------------------------------------------------- */

  /**
   * True when the entry starts with `Name:` / `Name =` / `Name =>`.
   *
   * This separates the members of an object initializer from the elements of a
   * collection initializer: `new List<T> { new T { A = 1 } }` holds elements,
   * because its entries start with a constructor call rather than a member name.
   */
  private entryIsMember(i: number): boolean {
    const pattern =
      /^\s*(?:@?[A-Za-z_$][\w$]*(?:\s*(?:\.|::)\s*[A-Za-z_$][\w$]*)*|["'][^"'\n]{0,80}["']|\[[^\]]{0,80}\])\s*(?::|=(?!=)|=>)/;
    return pattern.test(this.text.slice(i, i + 400));
  }

  /** Moves to the end of the entry that starts at `i`. */
  private skipEntry(i: number): number | undefined {
    let cursor = i;
    let depth = 0;
    const limit = i + 4000;
    while (cursor < this.text.length && cursor < limit) {
      const ch = this.text[cursor] as string;
      if (ch === '"' || ch === "'" || ch === '`') {
        const parsed = this.string(cursor);
        if (!parsed) {
          cursor += 1;
          continue;
        }
        cursor = parsed.next;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        cursor += 1;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) {
          return cursor;
        }
        depth -= 1;
        cursor += 1;
        continue;
      }
      if ((ch === ',' || ch === ';') && depth === 0) {
        return cursor;
      }
      cursor += 1;
    }
    return undefined;
  }
}

const CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'match',
  'try',
  'catch',
  'finally',
  'return',
  'func',
  'fn',
  'def',
  'function',
  'class',
  'struct',
  'impl',
  'with',
  'using',
  'lock',
  'yield',
  'await',
  'async',
  'import',
  'from',
  'export'
]);

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function formatNumber(value: number): string {
  return String(value);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

/** Writes `path` into `target`, creating nested objects on the way. */
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) {
    return;
  }
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[path[path.length - 1] as string] = value;
}

/** Offset of the closing bracket, honouring nesting and string literals. */
function matchBracket(text: string, i: number, open: string, close: string): number | undefined {
  let depth = 0;
  let cursor = i;
  while (cursor < text.length) {
    const ch = text[cursor] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, cursor);
      if (end === undefined) {
        return undefined;
      }
      cursor = end;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }
  return undefined;
}

function skipString(text: string, i: number): number | undefined {
  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return undefined;
  }
  let cursor = i + 1;
  while (cursor < text.length) {
    const ch = text[cursor] as string;
    if (ch === '\\') {
      cursor += 2;
      continue;
    }
    if (ch === quote) {
      return cursor + 1;
    }
    if (ch === '\n' && quote !== '`') {
      return undefined;
    }
    cursor += 1;
  }
  return undefined;
}

/** Skips whitespace and comments in raw text, used while scanning for literals. */
function skipTrivia(text: string, i: number): number {
  let cursor = i;
  for (;;) {
    while (cursor < text.length && isSpace(text[cursor] as string)) {
      cursor += 1;
    }
    if (text.startsWith('//', cursor)) {
      const end = text.indexOf('\n', cursor);
      cursor = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', cursor)) {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    return cursor;
  }
}

/**
 * Walks from just behind an assignment operator to the opening bracket of the
 * literal, skipping the tokens that may sit in between (`new`, a type name,
 * `vec!`, `&`, `mut`, an empty argument list).
 *
 * Returns `-1` when the text is not a literal: `total = item[0]` must not be
 * mistaken for a one element list.
 */
function bracketAfterAssignment(text: string, i: number): number {
  let cursor = i;
  let sawType = false;
  for (let guard = 0; guard < 40; guard += 1) {
    cursor = skipTrivia(text, cursor);
    const ch = text[cursor];
    if (ch === undefined) {
      return -1;
    }
    if (ch === '[') {
      // `[]Temperature` (Go), `int[]` and `new[]` are element types, never an
      // index access, so they do not count as a type on their own.
      if (text[cursor + 1] === ']') {
        cursor += 2;
        continue;
      }
      return sawType ? -1 : cursor;
    }
    if (ch === '{') {
      return cursor;
    }
    if (ch === '&') {
      cursor += 1;
      continue;
    }
    if (text.startsWith('vec!', cursor)) {
      cursor += 4;
      continue;
    }
    if (/^mut\b/.test(text.slice(cursor))) {
      cursor += 3;
      continue;
    }
    if (/^new\b/.test(text.slice(cursor))) {
      cursor += 3;
      continue;
    }
    if (ch === '(' && text[cursor + 1] === ')') {
      cursor += 2;
      continue;
    }
    const goMap = /^map\s*\[[^\[\]\n]{0,80}\]/.exec(text.slice(cursor));
    if (goMap) {
      cursor += goMap[0].length;
      continue;
    }
    if (isIdentifierStart(ch)) {
      if (sawType) {
        return -1;
      }
      const match = /^[A-Za-z_$][\w$.]*(?:<(?:[^<>{}]|<[^<>{}]*>)*>)?/.exec(text.slice(cursor));
      if (!match || match[0].length === 0) {
        return -1;
      }
      cursor += match[0].length;
      sawType = true;
      continue;
    }
    return -1;
  }
  return -1;
}

/** Characters that turn `=` into a compound operator (`+=`, `<=`, `==`, …). */
const ASSIGNMENT_BLOCKERS = '-+*/%!<>=&|^?:';

/** Candidate found while scanning a document. */
interface Candidate {
  name: string;
  offset: number;
  bracket: number;
}

/**
 * Single pass over the document that yields assignment operators and JSON like
 * property declarations, ignoring everything inside strings and comments.
 */
function scanForAssignments(
  text: string,
  withProperties: boolean
): Candidate[] {
  const candidates: Candidate[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const ch = text[cursor] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, cursor);
      if (end === undefined) {
        cursor += 1;
        continue;
      }
      if (withProperties) {
        let after = skipTrivia(text, end);
        if (text[after] === ':') {
          after = skipTrivia(text, after + 1);
          if (text[after] === '[' || text[after] === '{') {
            candidates.push({
              name: text.slice(cursor + 1, end - 1),
              offset: cursor,
              bracket: after
            });
          }
        }
      }
      cursor = end;
      continue;
    }
    if (text.startsWith('//', cursor)) {
      const end = text.indexOf('\n', cursor);
      cursor = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', cursor)) {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '#' && text[cursor + 1] !== '[' && text[cursor + 1] !== '!') {
      const end = text.indexOf('\n', cursor);
      cursor = end === -1 ? text.length : end + 1;
      continue;
    }
    let operator = 0;
    if (ch === '=' && text[cursor + 1] !== '=' && text[cursor + 1] !== '>') {
      if (!ASSIGNMENT_BLOCKERS.includes(text[cursor - 1] ?? '')) {
        operator = 1;
      }
    } else if (ch === ':' && text[cursor + 1] === '=') {
      operator = 2;
    } else if (ch === '<' && text[cursor + 1] === '-') {
      operator = 2;
    }
    if (operator > 0) {
      const name = identifierBefore(text, cursor);
      if (name) {
        const bracket = bracketAfterAssignment(text, cursor + operator);
        if (bracket >= 0) {
          candidates.push({ name: name.name, offset: name.offset, bracket });
        }
      }
      cursor += operator;
      continue;
    }
    cursor += 1;
  }
  return candidates;
}

/**
 * Last identifier in front of an assignment operator, so `std::vector<int>
 * values = …` and `int values[] = …` are named after `values`.
 */
/**
 * Name of the variable that receives the value, taken from the statement in
 * front of the operator.
 *
 * The region is stripped of the type that may sit next to the name, so
 * `std::vector<int> values = …`, `int values[] = …`, `Record<string, number>[]
 * rows = …` and `var temps []Temperature = …` are all named after the variable
 * instead of after the last type token.
 */
function identifierBefore(
  text: string,
  operator: number
): { name: string; offset: number } | undefined {
  let start = operator;
  while (start > 0 && !/[;\n{}()]/.test(text[start - 1] as string)) {
    start -= 1;
  }
  let region = text.slice(start, operator);
  for (let guard = 0; guard < 20; guard += 1) {
    region = region.replace(/\s+$/, '');
    const last = region[region.length - 1];
    if (last === ']' || last === '>') {
      const open = matchBackwards(region, region.length - 1, last === ']' ? '[' : '<', last);
      if (open <= 0) {
        break;
      }
      region = region.slice(0, open);
      continue;
    }
    if (last === ':' || last === '&' || last === '*' || last === '?') {
      region = region.slice(0, -1);
      continue;
    }
    const identifier = /([A-Za-z_$][\w$]*)$/.exec(region);
    if (!identifier) {
      break;
    }
    const before = region.slice(0, region.length - (identifier[1] as string).length).replace(/\s+$/, '');
    const marker = before[before.length - 1];
    // `temps: List<int>` puts a type behind the name; `[]Temperature` does the
    if (marker === ':') {
      region = before;
      continue;
    }
    break;
  }
  const match = /([A-Za-z_$][\w$]*)$/.exec(region.replace(/\s+$/, ''));
  if (!match) {
    return undefined;
  }
  const name = match[1] as string;
  if (NON_NAMES.has(name)) {
    return undefined;
  }
  return { name, offset: start + region.replace(/\s+$/, '').length - name.length };
}

/** Keywords that can never be the name of a collection. */
const NON_NAMES = new Set([
  'const',
  'let',
  'var',
  'val',
  'static',
  'readonly',
  'public',
  'private',
  'protected',
  'internal',
  'final',
  'auto',
  'return',
  'new',
  'mut',
  'dim',
  'local'
]);

/** Matching opening bracket in front of `end`, honouring nesting. */
function matchBackwards(text: string, end: number, open: string, close: string): number {
  let depth = 0;
  for (let index = end; index >= 0; index -= 1) {
    const character = text[index];
    if (character === close) {
      depth += 1;
    } else if (character === open) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

const MAX_LITERALS = 40;

/**
 * Finds the collection literals of a document.
 *
 * Only literals that yield at least one row are returned, and nested literals
 * are dropped in favour of the declaration that encloses them.
 */
export function findLiteralCollections(text: string, languageId?: string): LiteralCollection[] {
  const found: LiteralCollection[] = [];
  const ranges: [number, number][] = [];

  const consider = (name: string | undefined, bracket: number, declarationOffset: number): void => {
    if (bracket < 0 || ranges.some(([from, to]) => bracket >= from && bracket < to)) {
      return;
    }
    const parser = new LiteralParser(text);
    const parsed = parser.parse(bracket);
    if (!parsed) {
      return;
    }
    const rows = rowsFromLiteralValue(parsed.value, parser.quotedKeys);
    if (!rows || rows.length === 0) {
      return;
    }
    if (found.length >= MAX_LITERALS) {
      return;
    }
    found.push({
      line: lineIndexAt(text, declarationOffset),
      name: name?.trim() || undefined,
      rows,
      unknownValues: parsed.unknownValues,
      offset: bracket,
      end: parsed.next
    });
    ranges.push([bracket, Math.max(bracket, parsed.next)]);
  };

  const withProperties = languageId === 'json' || languageId === 'jsonc';
  for (const candidate of scanForAssignments(text, withProperties)) {
    consider(candidate.name, candidate.bracket, candidate.offset);
  }

  return found.sort((left, right) => left.line - right.line);
}

/** Zero based line of a character offset. */
function lineIndexAt(text: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1;
    }
  }
  return line;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts a parsed literal into rows.
 *
 * A list becomes one row per element. A record (a single object whose members
 * are named) becomes a single row, except when its members are containers
 * themselves: then every member becomes a row with its key in front, which is
 * how a dictionary of records reads best.
 */
export function rowsFromLiteralValue(
  value: unknown,
  quotedKeys = false
): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => (isPlainObject(item) ? item : { value: item }));
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [];
  }
  const allContainers = entries.every(([, item]) => isPlainObject(item) || Array.isArray(item));
  if (allContainers) {
    return entries.map(([key, item]) => (isPlainObject(item) ? { key, ...item } : { key, value: item }));
  }
  const allScalars = entries.every(([, item]) => !isPlainObject(item) && !Array.isArray(item));
  // `{ 'Seoul': 21, 'Busan': 24 }` reads best as a key/value table; anything
  // mixed is a single record whose nested members become columns.
  if (allScalars && quotedKeys && entries.length > 1) {
    return entries.map(([key, item]) => ({ key, value: item }));
  }
  return [value];
}

/** Builds a snapshot for a literal collection so the viewer can display it. */
export function snapshotFromLiteral(
  literal: LiteralCollection,
  title: string,
  options: LiteralSnapshotOptions
): CollectionSnapshot {
  const elements: ElementNode[] = literal.rows.map((row, index) => ({
    label: `[${index}]`,
    typeName: undefined,
    raw: row,
    fields: []
  }));
  const warnings = [...(options.warnings ?? [])];
  if (literal.unknownValues > 0) {
    warnings.push(
      `${literal.unknownValues} value(s) could not be read from the source and are shown as empty.`
    );
  }
  return buildSnapshot({
    id: `source:${literal.line}:${literal.offset}`,
    title,
    expression: literal.name ?? `literal at line ${literal.line + 1}`,
    sessionId: options.sessionId ?? 'source',
    sessionName: 'Source code',
    debugType: 'design-time',
    language: options.language ?? 'plaintext',
    providerId: 'source-literal',
    elements,
    totalItems: literal.rows.length,
    truncated: false,
    warnings,
    diagnostics: {
      strategy: 'source-literal',
      durationMs: 0,
      requests: 0,
      reportedItemCount: literal.rows.length,
      fallbackReasons: [],
      notes: options.notes ?? []
    },
    formatOptions: options.formatOptions,
    columnOrder: options.columnOrder,
    flattenDepth: options.flattenDepth,
    source: { kind: 'source-literal', uri: options.uri ?? '', line: literal.line }
  });
}


/**
 * Applies a filter to a snapshot that was read from the source text.
 *
 * Every row is already in memory, so the expression runs on the client and acts
 * on the whole collection instead of the page that was fetched.
 */
export function filterLiteralSnapshot(
  snapshot: CollectionSnapshot,
  filterText: string
): FilterOutcome {
  if (filterText.trim().length === 0) {
    return {
      snapshot,
      result: { rows: snapshot.rows, executed: '', location: 'client', warnings: [] }
    };
  }
  const parsed = parseFilter(filterText);
  const rows = applyFilter(parsed, snapshot.rows, snapshot.columns);
  return {
    snapshot: withRows(snapshot, rows),
    result: {
      rows,
      executed: formatExpression(parsed.expression, parsed.parameter ?? 'x'),
      location: 'client',
      warnings: []
    }
  };
}
