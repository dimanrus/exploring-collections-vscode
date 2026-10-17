import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFreeIdentifiers,
  formatExpression,
  parseFilter,
  tokenize
} from '../src/filter/expression';
import {
  applyFilter,
  buildRowObject,
  cellValue,
  likeToRegExp,
  matchRow,
  unresolvedIdentifiers
} from '../src/filter/evaluator';
import { emitBody } from '../src/filter/emit';
import {
  CSHARP_DIALECT,
  FSHARP_DIALECT,
  JAVASCRIPT_DIALECT,
  PYTHON_DIALECT
} from '../src/filter/dialects';
import type { ColumnDescriptor, RowDescriptor } from '../src/model/types';

function columns(...specs: Array<[string, ColumnDescriptor['kind']]>): ColumnDescriptor[] {
  return [
    { key: '#', title: '#', path: [], kind: 'index', nested: false },
    ...specs.map(([key, kind]) => ({
      key,
      title: key.includes('.') ? key.split('.').pop()! : key,
      path: key.split('.'),
      kind,
      nested: key.includes('.'),
      typeName: undefined
    }))
  ];
}

function row(index: number, values: unknown[], descriptors: ColumnDescriptor[]): RowDescriptor {
  // `values` holds the data cells; the synthetic `#` cell is prepended.
  const dataCells = values.map((value, position) => {
    const descriptor = descriptors[position + 1];
    return {
      text: value === null || value === undefined ? '' : String(value),
      kind: value === null || value === undefined ? ('null' as const) : descriptor?.kind ?? ('string' as const),
      isNull: value === null || value === undefined,
      expandable: false,
      raw: typeof value === 'object' && value !== null ? value : undefined
    };
  });
  return {
    index,
    label: `[${index}]`,
    cells: [
      { text: String(index), kind: 'index' as const, isNull: false, expandable: true },
      ...dataCells
    ]
  };
}

const weatherColumns = columns(
  ['City', 'string'],
  ['DegreeCelsius', 'number'],
  ['Feels', 'string'],
  ['Address.City', 'string']
);

const weatherRows: RowDescriptor[] = [
  row(0, ['Seoul', 21, 'warm', 'Seoul'], weatherColumns),
  row(1, ['Lima', 19, 'normal', 'Lima'], weatherColumns),
  row(2, ['Cape Town', 11, 'normal', 'Cape Town'], weatherColumns),
  row(3, [null, null, 'cold', null], weatherColumns)
];

describe('filter tokenizer and parser', () => {
  it('tokenizes operators, strings and numbers', () => {
    const tokens = tokenize('x.City == "Seoul" && x.DegreeCelsius >= 20');
    assert.deepEqual(
      tokens.map((token) => token.value),
      ['x', '.', 'City', '==', 'Seoul', '&&', 'x', '.', 'DegreeCelsius', '>=', '20']
    );
  });

  it('tokenizes comments-free strings with escapes', () => {
    const tokens = tokenize('"a\\"b\\n"');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.value, 'a"b\n');
  });

  it('rejects unterminated strings', () => {
    assert.throws(() => tokenize('"abc'), /unterminated string/);
  });

  it('parses the canonical lambda form', () => {
    const parsed = parseFilter('x => x.City == "Seoul"');
    assert.equal(parsed.parameter, 'x');
    assert.equal(formatExpression(parsed.expression, 'x'), 'x => x.City == "Seoul"');
  });

  it('accepts WHERE, fun x -> and a bare body', () => {
    assert.equal(formatExpression(parseFilter('WHERE x => x.City == "Seoul"').expression), 'x => x.City == "Seoul"');
    assert.equal(formatExpression(parseFilter('fun x -> x.City == "Seoul"').expression), 'x => x.City == "Seoul"');
    assert.equal(formatExpression(parseFilter('City == "Seoul"').expression), 'City == "Seoul"');
  });

  it('keeps string literals quoted so they can be re-emitted', () => {
    const parsed = parseFilter('x => x.Feels == "a==b"');
    const literal = (parsed.expression as { body: { right: { raw: string } } }).body.right;
    assert.match(literal.raw, /^"a==b"$/);
  });

  it('honours operator precedence', () => {
    const parsed = parseFilter('x => x.A == 1 || x.B == 2 && x.C == 3');
    assert.equal(formatExpression(parsed.expression), 'x => x.A == 1 || x.B == 2 && x.C == 3');
  });

  it('parses method calls, functions, arrays and the in operator', () => {
    const parsed = parseFilter('x => x.City.StartsWith("S") && len(x.City) > 2 && x.City in ("a", "b")');
    assert.equal(
      formatExpression(parsed.expression),
      'x => x.City.StartsWith("S") && len(x.City) > 2 && x.City in ("a", "b")'
    );
  });

  it('reports a readable syntax error position', () => {
    assert.throws(() => parseFilter('x => x.City =='), /unexpected end of expression/);
    assert.throws(() => parseFilter('x => x.City @ 1'), /unexpected character '@'/);
  });

  it('collects free identifiers but not the lambda parameter', () => {
    const parsed = parseFilter('x => x.DegreeCelsius > threshold && x.City != excluded');
    assert.deepEqual(collectFreeIdentifiers(parsed).sort(), ['excluded', 'threshold']);
  });
});

describe('filter evaluation', () => {
  const apply = (text: string): number[] => {
    const parsed = parseFilter(text);
    return applyFilter(parsed, weatherRows, weatherColumns).map((entry) => entry.index);
  };

  it('compares strings and numbers', () => {
    assert.deepEqual(apply('x => x.City == "Seoul"'), [0]);
    assert.deepEqual(apply('x => x.DegreeCelsius > 19'), [0]);
  });

  it('supports empty cells through null semantics', () => {
    assert.deepEqual(apply('x => isnull(x.City)'), [3]);
    assert.deepEqual(apply('x => x.City != null'), [0, 1, 2]);
  });

  it('supports string methods and functions', () => {
    assert.deepEqual(apply('x => x.City.StartsWith("C")'), [2]);
    assert.deepEqual(apply('x => x.City.EndsWith("a")'), [1]);
    assert.deepEqual(apply('x => x.City.Contains("e")'), [0, 2]);
    assert.deepEqual(apply('x => lower(x.City) == "seoul"'), [0]);
    assert.deepEqual(apply('x => len(x.City) == 4'), [1]);
  });

  it('supports and/or/not and arithmetic', () => {
    assert.deepEqual(apply('x => x.DegreeCelsius > 10 && x.Feels == "warm"'), [0]);
    assert.deepEqual(apply('x => x.Feels == "warm" || x.Feels == "cold"'), [0, 3]);
    assert.deepEqual(apply('not (x.City == "Seoul")'), [1, 2, 3]);
    assert.deepEqual(apply('x => x.DegreeCelsius + 1 == 20'), [1]);
  });

  it('supports in, like and math helpers', () => {
    assert.deepEqual(apply('x => x.City in ("Seoul", "Lima")'), [0, 1]);
    assert.deepEqual(apply('like(x.City, "C%")'), [2]);
    assert.deepEqual(apply('like(x.City, "%o%")'), [0, 2]);
    assert.deepEqual(apply('x => abs(x.DegreeCelsius - 20) <= 1'), [0, 1]);
  });

  it('resolves nested member paths', () => {
    assert.deepEqual(apply('x => x.Address.City == "Lima"'), [1]);
  });

  it('uses locals supplied by the debugger', () => {
    const parsed = parseFilter('x => x.DegreeCelsius > threshold');
    const locals = new Map<string, unknown>([['threshold', 20]]);
    assert.equal(applyFilter(parsed, weatherRows, weatherColumns, locals).length, 1);
  });

  it('reports unresolved identifiers, but not columns or builtins', () => {
    const parsed = parseFilter('x => x.City == threshold && lower(x.Feels) != x.City && x.DegreeCelsius > abs(1)');
    const unresolved = unresolvedIdentifiers(collectFreeIdentifiers(parsed), weatherColumns);
    assert.deepEqual(unresolved, ['threshold']);
  });

  it('builds comparable cell values from raw payloads', () => {
    const descriptor = columns(['Value', 'number'])[1]!;
    assert.equal(cellValue({ text: '1 234', kind: 'string', isNull: false, expandable: false }, descriptor), '1 234');
    assert.equal(
      cellValue({ text: '1.5', kind: 'number', isNull: false, expandable: false }, descriptor),
      1.5
    );
    assert.equal(
      cellValue({ text: '9', kind: 'number', isNull: false, expandable: false, raw: 9 }, descriptor),
      9
    );
  });

  it('builds a nested object for member access', () => {
    const object = buildRowObject(weatherRows[0]!, weatherColumns);
    assert.equal(object.City, 'Seoul');
    assert.deepEqual(object.Address, { City: 'Seoul' });
  });

  it('translates SQL patterns case insensitively', () => {
    assert.equal(likeToRegExp('a%b_c').test('AxBxC'), true);
    assert.equal(likeToRegExp('a%b_c', false).test('AxBxC'), false);
  });
});

describe('filter emission for pushdown', () => {
  const emit = (text: string, dialect = CSHARP_DIALECT) => {
    const parsed = parseFilter(text);
    const body = parsed.expression.kind === 'lambda' ? parsed.expression.body : parsed.expression;
    return emitBody(body, { sourceParameter: parsed.parameter ?? 'x', targetParameter: 'x', dialect });
  };

  it('emits C# operators and LINQ friendly helpers', () => {
    const result = emit('x => x.City == "Seoul" && len(x.City) > 2');
    assert.equal(result.text, '(x.City == "Seoul") && (System.Linq.Enumerable.Count(x.City) > 2)');
    assert.equal(result.exact, true);
  });

  it('does not corrupt string literals that contain operator characters', () => {
    const result = emit('x => x.Feels == "a==b"');
    assert.equal(result.text, 'x.Feels == "a==b"');
  });

  it('emits F# equality operators', () => {
    const result = emit('x => x.City == "Seoul" && x.DegreeCelsius != 0', FSHARP_DIALECT);
    assert.equal(result.text, '(x.City = "Seoul") && (x.DegreeCelsius <> 0)');
    assert.equal(result.exact, true);
  });

  it('emits JavaScript strict equality and method names', () => {
    const result = emit('x => x.City.Contains("Se") && x.Feels == "warm"', JAVASCRIPT_DIALECT);
    assert.equal(result.text, 'x.City.includes("Se") && (x.Feels === "warm")');
    assert.equal(result.exact, true);
  });

  it('emits Python operators and membership tests', () => {
    const result = emit('x => x.City.Contains("Se") && x.Feels == "warm"', PYTHON_DIALECT);
    assert.equal(result.text, '("Se" in x.City) and (x.Feels == "warm")');
    assert.equal(result.exact, true);
  });

  it('marks unsupported operators as inexact instead of guessing', () => {
    const result = emit('x => like(x.City, "S%")');
    assert.equal(result.exact, false);
    assert.match(result.notes.join(' '), /client/);
  });

  it('renames the lambda parameter to the target name', () => {
    const parsed = parseFilter('it => it.City == "Seoul"');
    const body = parsed.expression.kind === 'lambda' ? parsed.expression.body : parsed.expression;
    const result = emitBody(body, {
      sourceParameter: 'it',
      targetParameter: 'x',
      dialect: JAVASCRIPT_DIALECT
    });
    assert.equal(result.text, 'x.City === "Seoul"');
  });
});

describe('matchRow', () => {
  it('matches a single row without a pipeline', () => {
    const parsed = parseFilter('x => x.DegreeCelsius >= 19');
    assert.equal(matchRow(parsed, weatherRows[0]!, weatherColumns), true);
    assert.equal(matchRow(parsed, weatherRows[2]!, weatherColumns), false);
  });
});
