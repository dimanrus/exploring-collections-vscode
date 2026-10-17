import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeAdapterText,
  buildCellTooltip,
  formatRawValue,
  parseAdapterPrimitive,
  unquote
} from '../src/model/formatter';
import {
  classifyAdapterVariable,
  isErrorValue,
  isNumericText,
  isPrimitiveKind,
  kindFromAdapterValue,
  kindFromRawValue,
  kindFromText,
  normalizeTypeName
} from '../src/model/valueKind';
import {
  buildSnapshot,
  cellsForElement,
  createEmptySnapshot,
  flattenFields,
  mergeKinds,
  rawToFields,
  rowToObject,
  rowsFromElements,
  withRows,
  type ElementNode,
  type FieldNode
} from '../src/model/snapshotBuilder';
import type { SnapshotDiagnostics } from '../src/model/types';

const diagnostics: SnapshotDiagnostics = {
  strategy: 'variables-walk',
  durationMs: 0,
  requests: 0,
  reportedItemCount: null,
  fallbackReasons: [],
  notes: []
};

function field(name: string, text: string, kind: FieldNode['kind'], extra: Partial<FieldNode> = {}): FieldNode {
  return { name, path: [name], text, kind, ...extra };
}

function element(label: string, fields: FieldNode[]): ElementNode {
  return { label, fields };
}

describe('value kind inference', () => {
  it('normalizes debugger type names', () => {
    assert.equal(normalizeTypeName('System.Collections.Generic.List<int>'), 'list');
    assert.equal(normalizeTypeName('System.Int32'), 'int32');
    assert.equal(normalizeTypeName('int[]'), 'array');
    assert.equal(normalizeTypeName('&mut Vec<u8>'), 'vec');
    assert.equal(normalizeTypeName('map[string]int'), 'map');
    assert.equal(normalizeTypeName(undefined), '');
  });

  it('maps adapter types to column kinds', () => {
    assert.equal(kindFromAdapterValue('System.Int32', '21'), 'number');
    assert.equal(kindFromAdapterValue('float64', '1.5'), 'number');
    assert.equal(kindFromAdapterValue('bool', 'true'), 'boolean');
    assert.equal(kindFromAdapterValue('System.DateTime', '2024-04-01T00:00:00'), 'date');
    assert.equal(kindFromAdapterValue('string', 'Seoul'), 'string');
    assert.equal(kindFromAdapterValue('std::vector<int>', '[1, 2]'), 'array');
    assert.equal(kindFromAdapterValue('i32', '21'), 'number');
    assert.equal(kindFromAdapterValue('u64', '21'), 'number');
  });

  it('falls back to the rendered text', () => {
    assert.equal(kindFromText('42'), 'number');
    assert.equal(kindFromText('4.5e3'), 'number');
    assert.equal(kindFromText('0xFF'), 'number');
    assert.equal(kindFromText('true'), 'boolean');
    assert.equal(kindFromText('null'), 'null');
    assert.equal(kindFromText('{City="Seoul"}'), 'object');
    assert.equal(kindFromText('[1, 2]'), 'array');
    assert.equal(kindFromText('2024-04-01'), 'date');
    assert.equal(kindFromText('Seoul'), 'string');
  });

  it('detects numeric text, including suffixes and hex', () => {
    assert.equal(isNumericText('1'), true);
    assert.equal(isNumericText('1.5f'), true);
    assert.equal(isNumericText('0x1F'), true);
    assert.equal(isNumericText('NaN'), true);
    assert.equal(isNumericText('abc'), false);
  });

  it('classifies adapter values for the collection picker', () => {
    assert.equal(classifyAdapterVariable({ indexedVariables: 14, value: '' }), 'sequence');
    assert.equal(classifyAdapterVariable({ namedVariables: 3, type: 'map[string]int', value: '' }), 'map');
    assert.equal(classifyAdapterVariable({ namedVariables: 3, type: 'Temperature', value: '' }), 'record');
    assert.equal(classifyAdapterVariable({ value: '21' }), 'leaf');
    assert.equal(classifyAdapterVariable({ value: '[1, 2, 3]' }), 'sequence');
    assert.equal(classifyAdapterVariable({ type: 'List<int>', value: '' }), 'sequence');
  });

  it('recognizes error placeholders and primitives', () => {
    assert.equal(isErrorValue('<error>'), true);
    assert.equal(isErrorValue('Seoul'), false);
    assert.equal(isPrimitiveKind('string'), true);
    assert.equal(isPrimitiveKind('object'), false);
  });

  it('infers kinds from raw JSON payloads', () => {
    assert.equal(kindFromRawValue('2024-04-01'), 'date');
    assert.equal(kindFromRawValue([1, 2]), 'array');
    assert.equal(kindFromRawValue({ a: 1 }), 'object');
    assert.equal(kindFromRawValue(null), 'null');
    assert.equal(kindFromRawValue(21), 'number');
  });
});

describe('adapter text formatting', () => {
  it('unquotes debugger strings and decodes escapes', () => {
    assert.equal(unquote('"Seoul"'), 'Seoul');
    assert.equal(unquote("'Seoul'"), 'Seoul');
    assert.equal(unquote('"a\\nb"'), 'a\nb');
    assert.equal(unquote('Seoul'), 'Seoul');
  });

  it('normalizes text and refines the kind', () => {
    assert.deepEqual(analyzeAdapterText('"Seoul"', 'string'), { text: 'Seoul', kind: 'string', isNull: false });
    assert.deepEqual(analyzeAdapterText('  21  ', 'int'), { text: '21', kind: 'number', isNull: false });
    assert.deepEqual(analyzeAdapterText('null', undefined), { text: '', kind: 'null', isNull: true });
    assert.equal(analyzeAdapterText('<error>', undefined).isNull, true);
  });

  it('formats dates according to the configured style', () => {
    const iso = analyzeAdapterText('"2024-04-01 10:00:00"', 'DateTime', {
      dateFormat: 'iso',
      maxCellLength: 100,
      emptyStringAsNull: false
    });
    assert.equal(iso.text, '2024-04-01T10:00:00');
    assert.equal(iso.kind, 'date');

    const raw = analyzeAdapterText('"2024-04-01"', 'DateTime', {
      dateFormat: 'raw',
      maxCellLength: 100,
      emptyStringAsNull: false
    });
    assert.equal(raw.text, '2024-04-01');
  });

  it('truncates long cells', () => {
    const result = analyzeAdapterText('x'.repeat(200), 'string', {
      dateFormat: 'iso',
      maxCellLength: 10,
      emptyStringAsNull: false
    });
    assert.equal(result.text.length, 10);
    assert.match(result.text, /…$/);
  });

  it('parses primitives into comparable values', () => {
    assert.equal(parseAdapterPrimitive('21', 'number'), 21);
    assert.equal(parseAdapterPrimitive('0x1F', 'number'), 31);
    assert.equal(parseAdapterPrimitive('true', 'boolean'), true);
    assert.equal(parseAdapterPrimitive('null', 'null'), null);
    assert.equal(parseAdapterPrimitive('"Seoul"', 'string'), 'Seoul');
  });

  it('formats raw payload values and builds tooltips', () => {
    assert.deepEqual(formatRawValue([1, 2, 3]), { text: '[3 items]', kind: 'array', isNull: false });
    assert.deepEqual(formatRawValue({ a: 1 }), { text: '{1 field}', kind: 'object', isNull: false });
    assert.deepEqual(formatRawValue(null), { text: '', kind: 'null', isNull: true });
    assert.equal(
      buildCellTooltip({ text: 'Seoul', typeName: 'string', kind: 'string' }, 'City'),
      'City (string) = Seoul'
    );
  });
});

describe('snapshot building', () => {
  const elements: ElementNode[] = [
    element('[0]', [
      field('City', 'Seoul', 'string', { typeName: 'string' }),
      field('DegreeCelsius', '21', 'number', { typeName: 'int' }),
      field('Feels', 'warm', 'string')
    ]),
    element('[1]', [
      field('City', 'Lima', 'string', { typeName: 'string' }),
      field('DegreeCelsius', '19', 'number', { typeName: 'int' }),
      field('Feels', 'normal', 'string')
    ]),
    element('[2]', [field('City', 'Cape Town', 'string')])
  ];

  const snapshot = buildSnapshot({
    id: 'snap-1',
    title: 'temperatures',
    expression: 'temperatures',
    sessionId: 'session-1',
    sessionName: 'Demo',
    debugType: 'coreclr',
    language: 'csharp',
    providerId: 'csharp',
    elements,
    diagnostics
  });

  it('derives columns alphabetically with a leading index column', () => {
    assert.deepEqual(
      snapshot.columns.map((column) => column.key),
      ['#', 'City', 'DegreeCelsius', 'Feels']
    );
    assert.equal(snapshot.columns[0]!.kind, 'index');
    assert.equal(snapshot.columns[2]!.kind, 'number');
  });

  it('honours the discovery column order', () => {
    const discovery = buildSnapshot({
      id: 'snap-2',
      title: 'temperatures',
      expression: 'temperatures',
      sessionId: 'session-1',
      sessionName: 'Demo',
      debugType: 'coreclr',
      language: 'csharp',
      providerId: 'csharp',
      elements,
      diagnostics,
      columnOrder: 'discovery'
    });
    assert.deepEqual(
      discovery.columns.map((column) => column.key),
      ['#', 'City', 'DegreeCelsius', 'Feels']
    );
  });

  it('fills missing values with nulls', () => {
    const last = snapshot.rows[2]!;
    assert.equal(last.cells[0]!.text, '[2]');
    assert.equal(last.cells[1]!.text, 'Cape Town');
    assert.equal(last.cells[2]!.isNull, true);
    assert.equal(last.cells[3]!.isNull, true);
  });

  it('keeps the numeric kind aligned with the column', () => {
    assert.equal(snapshot.rows[0]!.cells[2]!.kind, 'number');
    assert.equal(snapshot.rows[0]!.cells[2]!.text, '21');
  });

  it('reports totals, truncation and diagnostics', () => {
    const truncated = buildSnapshot({
      id: 'snap-3',
      title: 'big',
      expression: 'big',
      sessionId: 's',
      sessionName: 's',
      debugType: 'coreclr',
      language: 'csharp',
      providerId: 'csharp',
      elements,
      totalItems: 100000,
      truncated: true,
      warnings: ['only the first elements were requested'],
      diagnostics: { ...diagnostics, durationMs: 12, requests: 3 }
    });
    assert.equal(truncated.totalItems, 100000);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.warnings.length, 1);
    assert.equal(truncated.diagnostics.durationMs, 12);
  });

  it('merges mixed kinds conservatively', () => {
    assert.equal(mergeKinds(['number', 'number', 'null']), 'number');
    assert.equal(mergeKinds(['number', 'string']), 'string');
    assert.equal(mergeKinds(['object', 'null']), 'object');
    assert.equal(mergeKinds(['null']), 'null');
    assert.equal(mergeKinds([]), 'unknown');
  });

  it('flattens nested objects into dotted columns', () => {
    const nested: ElementNode[] = [
      {
        label: '[0]',
        fields: [
          field('Address', '{2 fields}', 'object', {
            variablesReference: 42,
            expandable: true
          })
        ]
      }
    ];
    const flat = flattenFields(nested[0]!.fields, 2);
    // Without fetched children the container stays a single expandable column.
    assert.equal(flat.length, 1);
    assert.equal(flat[0]!.kind, 'object');
  });

  it('expands raw payload objects into columns', () => {
    const raw: ElementNode[] = [
      { label: '[0]', raw: { city: 'Seoul', address: { zip: '04524' } }, fields: [] },
      { label: '[1]', raw: { city: 'Lima', address: { zip: '15001' } }, fields: [] }
    ];
    const built = buildSnapshot({
      id: 'raw',
      title: 'raw',
      expression: 'raw',
      sessionId: 's',
      sessionName: 's',
      debugType: 'pwa-node',
      language: 'javascript',
      providerId: 'javascript',
      elements: raw,
      diagnostics
    });
    assert.deepEqual(
      built.columns.map((column) => column.key),
      ['#', 'address.zip', 'city']
    );
    assert.equal(built.rows[1]!.cells[2]!.text, 'Lima');
  });

  it('rebuilds rows for an existing column layout', () => {
    const rebuilt = rowsFromElements(elements, snapshot.columns);
    assert.equal(rebuilt.length, 3);
    assert.equal(rebuilt[0]!.cells[1]!.text, 'Seoul');
    assert.equal(rebuilt[0]!.cells[3]!.text, 'warm');

    const cells = cellsForElement(elements[1]!, snapshot.columns);
    assert.equal(cells.length, snapshot.columns.length);
    assert.equal(cells[1]!.text, 'Lima');
  });

  it('converts rows into plain objects for exports', () => {
    const object = rowToObject(snapshot, snapshot.rows[0]!);
    assert.deepEqual(object, {
      '#': '[0]',
      City: 'Seoul',
      DegreeCelsius: 21,
      Feels: 'warm'
    });
  });

  it('supports restrictive views and empty snapshots', () => {
    const restricted = withRows(snapshot, [snapshot.rows[0]!]);
    assert.equal(restricted.rows.length, 1);
    assert.equal(restricted.columns.length, snapshot.columns.length);

    const empty = createEmptySnapshot(
      {
        id: 'x',
        title: 'x',
        expression: 'x',
        sessionId: 's',
        sessionName: 's',
        debugType: 'python',
        language: 'python',
        providerId: 'python'
      },
      { ...diagnostics, strategy: 'helper-json' },
      ['nothing found']
    );
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.warnings[0], 'nothing found');
  });

  it('converts raw objects into field nodes', () => {
    const fields = rawToFields({ a: 1, list: [1, 2] });
    assert.equal(fields.length, 2);
    assert.equal(fields[0]!.kind, 'number');
    assert.equal(fields[1]!.kind, 'array');
    assert.equal(fields[1]!.expandable, true);
  });

  it('keeps large nested arrays behind a single expandable cell', () => {
    const fields = rawToFields({ big: Array.from({ length: 100 }, (_, index) => index) });
    assert.equal(fields[0]!.kind, 'array');
    assert.equal(fields[0]!.expandable, true);
    assert.match(fields[0]!.text, /100 items/);
  });
});
