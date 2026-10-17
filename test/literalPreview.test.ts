import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findLiteralCollections, rowsFromLiteralValue, snapshotFromLiteral } from '../src/services/literalPreview';

/** Convenience wrapper: literals of a document without the language hint. */
function literals(text: string, languageId?: string) {
  return findLiteralCollections(text, languageId);
}

describe('literal preview: lists of records', () => {
  it('reads a JavaScript array of objects', () => {
    const source = [
      'const temperatures = [',
      "  { city: 'Seoul', degrees: 21 },",
      "  { city: 'Busan', degrees: 24 }",
      '];'
    ].join('\n');

    const [found] = literals(source);
    assert.ok(found);
    assert.equal(found.name, 'temperatures');
    assert.equal(found.line, 0);
    assert.equal(found.rows.length, 2);
    assert.deepEqual(found.rows[0], { city: 'Seoul', degrees: 21 });
    assert.deepEqual(found.rows[1], { city: 'Busan', degrees: 24 });
  });

  it('reads a TypeScript array with a type annotation and generics', () => {
    const source = [
      'export const rows: Record<string, number>[] = [',
      '  { a: 1 },',
      '  { a: 2 },',
      '];'
    ].join('\n');

    const [found] = literals(source);
    assert.ok(found);
    assert.equal(found.name, 'rows');
    assert.equal(found.rows.length, 2);
  });




  it('reads an F# list of records', () => {
    const source = [
      'let temperatures = [',
      '    { City = "Seoul"; Degrees = 21 }',
      '    { City = "Busan"; Degrees = 24 }',
      ']'
    ].join('\n');

    const [found] = literals(source, 'fsharp');
    assert.ok(found);
    assert.equal(found.rows.length, 2);
    assert.deepEqual(found.rows[0], { City: 'Seoul', Degrees: 21 });
  });

  it('reads a C# object initializer list', () => {
    const source = [
      'class Program',
      '{',
      '    static void Main()',
      '    {',
      '        var temperatures = new List<Temperature>',
      '        {',
      '            new Temperature { City = "Seoul", Degrees = 21 },',
      '            new Temperature("Busan", 24)',
      '        };',
      '    }',
      '}'
    ].join('\n');

    const [found] = literals(source, 'csharp');
    assert.ok(found);
    assert.equal(found.name, 'temperatures');
    assert.equal(found.line, 4);
    assert.deepEqual(found.rows[0], { City: 'Seoul', Degrees: 21 });
    assert.deepEqual(found.rows[1], { Item1: 'Busan', Item2: 24 });
  });

  it('reads a C# array initializer of primitives', () => {
    const source = 'static readonly int[] values = new[] { 1, 2, 3 };';
    const [found] = literals(source, 'csharp');
    assert.ok(found);
    assert.equal(found.name, 'values');
    assert.deepEqual(
      found.rows.map((row) => row.value),
      [1, 2, 3]
    );
  });

});

describe('literal preview: maps and records', () => {
  it('turns a map with quoted keys into key/value rows', () => {
    const source = "const lookup = { 'Seoul': 21, 'Busan': 24 };";
    const [found] = literals(source);
    assert.ok(found);
    assert.deepEqual(found.rows, [
      { key: 'Seoul', value: 21 },
      { key: 'Busan', value: 24 }
    ]);
  });

  it('keeps a single record as one row', () => {
    const source = 'var sample = new Temperature { City = "Seoul", Degrees = 21 };';
    const [found] = literals(source, 'csharp');
    assert.ok(found);
    assert.equal(found.rows.length, 1);
    assert.deepEqual(found.rows[0], { City: 'Seoul', Degrees: 21 });
  });

  it('spreads a dictionary of records into rows with the key in front', () => {
    const source = [
      'const byCity = {',
      '  seoul: { degrees: 21 },',
      '  busan: { degrees: 24 }',
      '};'
    ].join('\n');

    const [found] = literals(source);
    assert.ok(found);
    assert.deepEqual(found.rows, [
      { key: 'seoul', degrees: 21 },
      { key: 'busan', degrees: 24 }
    ]);
  });

  it('reads a C# dictionary initializer with index keys', () => {
    const source = [
      'var lookup = new Dictionary<string, int>',
      '{',
      '    ["Seoul"] = 21,',
      '    ["Busan"] = 24',
      '};'
    ].join('\n');

    const [found] = literals(source, 'csharp');
    assert.ok(found);
    assert.deepEqual(found.rows, [
      { key: 'Seoul', value: 21 },
      { key: 'Busan', value: 24 }
    ]);
  });

  it('reads JSON collections through the property pattern', () => {
    const source = ['{', '  "temperatures": [', '    { "city": "Seoul" },', '    { "city": "Busan" }', '  ]', '}'].join(
      '\n'
    );

    assert.equal(literals(source).length, 0);
    const [found] = literals(source, 'json');
    assert.ok(found);
    assert.equal(found.name, 'temperatures');
    assert.equal(found.rows.length, 2);
  });
});

describe('literal preview: values', () => {
  it('reads numbers, strings and literals of each language', () => {
    const source = [
      'const values = [',
      '  1_000,',
      '  -2.5,',
      '  0xFF,',
      '  1e3,',
      '  21.5f,',
      '  true,',
      '  false,',
      '  null,',
      '  "quoted \\"text\\""',
      '];'
    ].join('\n');

    const [found] = literals(source);
    assert.ok(found);
    assert.deepEqual(
      found.rows.map((row) => row.value),
      [1000, -2.5, 255, 1000, 21.5, true, false, null, 'quoted "text"']
    );
    assert.equal(found.unknownValues, 0);
  });


  it('reads C# verbatim strings', () => {
    const source = 'var paths = new[] { @"C:\\temp", "plain" };';
    const [found] = literals(source, 'csharp');
    assert.ok(found);
    assert.deepEqual(
      found.rows.map((row) => row.value),
      ['C:\\temp', 'plain']
    );
  });

  it('replaces values it cannot read with empty cells and counts them', () => {
    const source = 'var values = new[] { 1, Compute(), 3 };';
    const [found] = literals(source, 'csharp');
    assert.ok(found);
    assert.equal(found.rows.length, 3);
    assert.equal(found.rows[1]?.value, null);
    assert.equal(found.unknownValues, 1);
  });

  it('nests dotted member names instead of flattening them by hand', () => {
    const source = 'var entry = new Entry { Address.City = "Seoul", Name = "demo" };';
    const [found] = literals(source, 'csharp');
    assert.ok(found);
    assert.deepEqual(found.rows[0], { Address: { City: 'Seoul' }, Name: 'demo' });
  });

  it('reads tuples as positional items', () => {
    const source = ["const pairs = [('a', 1), ('b', 2)];"].join('\n');
    const [found] = literals(source);
    assert.ok(found);
    assert.deepEqual(found.rows, [
      { Item1: 'a', Item2: 1 },
      { Item1: 'b', Item2: 2 }
    ]);
  });
});

describe('literal preview: what is not a collection', () => {
  it('ignores scalars', () => {
    assert.deepEqual(literals('const answer = 42;'), []);
    assert.deepEqual(literals('const name = "demo";'), []);
  });

  it('does not mistake an index access for an array literal', () => {
    assert.deepEqual(literals('const total = items[0];'), []);
    assert.deepEqual(literals('total = customers[1] + items[2];'), []);
  });

  it('ignores comparisons and empty collections', () => {
    assert.deepEqual(literals('if (a == b) {\n  console.log(a);\n}'), []);
    assert.deepEqual(literals('const empty = [];'), []);
    assert.deepEqual(literals('const empty = {};'), []);
  });

  it('ignores literals inside comments', () => {
    assert.deepEqual(literals('// const demo = [1, 2, 3];'), []);
  });

  it('ignores shorthand property lists and unreadable elements', () => {
    assert.deepEqual(literals('module.exports = { readings };'), []);
    assert.deepEqual(literals('const computed = [Load(), Read(), Parse()];'), []);
  });

  it('keeps explicit nulls', () => {
    const [found] = literals('const values = [null, null];');
    assert.ok(found);
    assert.equal(found.unknownValues, 0);
    assert.equal(found.rows.length, 2);
  });

  it('reports the outermost literal and drops nested ones', () => {
    const source = ['const outer = [', '  { city: "Seoul", values: [1, 2] },', '  { city: "Busan", values: [3] }', '];'].join(
      '\n'
    );
    const found = literals(source);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.rows[0]?.values, [1, 2]);
  });

  it('handles several declarations in one document in source order', () => {
    const source = ['const first = [1, 2];', 'const second = [3, 4];'].join('\n');
    const found = literals(source);
    assert.deepEqual(
      found.map((literal) => literal.name),
      ['first', 'second']
    );
    assert.deepEqual(
      found.map((literal) => literal.line),
      [0, 1]
    );
  });
});

describe('literal preview: snapshots', () => {
  it('builds a snapshot with one column per member', () => {
    const source = [
      'const temperatures = [',
      '  { city: "Seoul", degrees: 21 },',
      '  { city: "Busan", degrees: 24 }',
      '];'
    ].join('\n');
    const [literal] = literals(source);
    assert.ok(literal);

    const snapshot = snapshotFromLiteral(literal, 'temperatures', {
      formatOptions: { dateFormat: 'iso', maxCellLength: 512, emptyStringAsNull: false },
      columnOrder: 'alphabetical',
      flattenDepth: 2,
      uri: 'file:///demo.js'
    });

    assert.equal(snapshot.providerId, 'source-literal');
    assert.equal(snapshot.diagnostics.strategy, 'source-literal');
    assert.equal(snapshot.debugType, 'design-time');
    assert.equal(snapshot.source?.kind, 'source-literal');
    assert.equal(snapshot.rows.length, 2);
    assert.deepEqual(
      snapshot.columns.map((column) => column.key),
      ['#', 'city', 'degrees']
    );
    assert.equal(snapshot.rows[0]?.cells[2]?.text, '21');
    assert.equal(snapshot.rows[0]?.label, '[0]');
  });

  it('warns about values that could not be read', () => {
    const [literal] = literals('var values = new[] { 1, Compute() };', 'csharp');
    assert.ok(literal);
    const snapshot = snapshotFromLiteral(literal, 'values', {
      formatOptions: { dateFormat: 'iso', maxCellLength: 512, emptyStringAsNull: false },
      columnOrder: 'discovery',
      flattenDepth: 2
    });
    assert.equal(snapshot.warnings.length, 1);
    assert.match(snapshot.warnings[0] as string, /could not be read/u);
  });
});

describe('literal preview: row shaping', () => {
  it('wraps scalars of a list in a value column', () => {
    assert.deepEqual(rowsFromLiteralValue([1, 'two', null]), [
      { value: 1 },
      { value: 'two' },
      { value: null }
    ]);
  });

  it('rejects scalars and empty objects', () => {
    assert.equal(rowsFromLiteralValue(5), undefined);
    assert.deepEqual(rowsFromLiteralValue({}), []);
    assert.deepEqual(rowsFromLiteralValue([]), []);
  });
});
