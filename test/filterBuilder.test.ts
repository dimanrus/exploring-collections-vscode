import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConditionText,
  buildFilterText,
  conditionsFromText,
  createCondition,
  defaultOperatorFor,
  filterableColumns,
  isConditionComplete,
  isRange,
  isValueLess,
  operatorsForKind,
  type FilterCondition
} from '../webview/filterBuilder';
import type { ColumnDescriptor, ColumnKind } from '../src/model/types';

function column(key: string, kind: ColumnKind): ColumnDescriptor {
  return { key, title: key, kind, path: key.split('.'), nested: false };
}

const columns: ColumnDescriptor[] = [
  column('#', 'index'),
  column('City', 'string'),
  column('DegreeCelsius', 'number'),
  column('Date', 'date'),
  column('Feels', 'string'),
  column('Active', 'boolean'),
  column('Location.Lat', 'number')
];

const condition = (overrides: Partial<FilterCondition>): FilterCondition => ({
  columnKey: 'City',
  operator: 'contains',
  value: '',
  value2: '',
  ...overrides
});

function text(overrides: Partial<FilterCondition>): string | undefined {
  const merged = condition(overrides);
  return buildConditionText(
    columns.find((candidate) => candidate.key === merged.columnKey),
    merged
  );
}

describe('the condition builder', () => {
  it('offers operators that fit the column kind', () => {
    assert.deepEqual(operatorsForKind('string').slice(0, 4), ['contains', 'notContains', 'equals', 'notEquals']);
    assert.ok(operatorsForKind('string').includes('regex'));
    assert.ok(operatorsForKind('number').includes('between'));
    assert.equal(operatorsForKind('number').includes('contains'), false);
    assert.deepEqual(operatorsForKind('boolean').slice(0, 2), ['isTrue', 'isFalse']);
    assert.deepEqual(operatorsForKind('object'), ['isNull', 'isNotNull']);
    assert.equal(defaultOperatorFor('number'), 'gte');
    assert.equal(defaultOperatorFor('string'), 'contains');
  });

  it('knows which operators need a value', () => {
    for (const operator of ['empty', 'notEmpty', 'isNull', 'isNotNull', 'isTrue', 'isFalse'] as const) {
      assert.equal(isValueLess(operator), true, operator);
    }
    assert.equal(isValueLess('contains'), false);
    assert.equal(isRange('between'), true);
    assert.equal(isRange('gt'), false);
  });

  it('skips the index column', () => {
    assert.deepEqual(
      filterableColumns(columns).map((entry) => entry.key),
      ['City', 'DegreeCelsius', 'Date', 'Feels', 'Active', 'Location.Lat']
    );
    assert.equal(createCondition(columns).columnKey, 'City');
  });

  it('builds a text condition', () => {
    assert.equal(text({ operator: 'contains', value: 'Seo' }), 'contains(x.City, "Seo")');
    assert.equal(text({ operator: 'notContains', value: 'Seo' }), '!contains(x.City, "Seo")');
    assert.equal(text({ operator: 'equals', value: 'Seoul' }), 'x.City == "Seoul"');
    assert.equal(text({ operator: 'notEquals', value: 'Seoul' }), 'x.City != "Seoul"');
    assert.equal(text({ operator: 'startsWith', value: 'S' }), 'startswith(x.City, "S")');
    assert.equal(text({ operator: 'endsWith', value: 'l' }), 'endswith(x.City, "l")');
    assert.equal(text({ operator: 'regex', value: '^S.+' }), 'matches(x.City, "^S.+" )'.replace(' )', ')'));
    assert.equal(text({ operator: 'empty' }), 'isempty(x.City)');
    assert.equal(text({ operator: 'notEmpty' }), '!isempty(x.City)');
    assert.equal(text({ operator: 'isNotNull' }), 'isnotnull(x.City)');
  });

  it('builds a numeric condition without quotes', () => {
    assert.equal(text({ columnKey: 'DegreeCelsius', operator: 'gt', value: '20' }), 'x.DegreeCelsius > 20');
    assert.equal(text({ columnKey: 'DegreeCelsius', operator: 'gte', value: '20' }), 'x.DegreeCelsius >= 20');
    assert.equal(text({ columnKey: 'DegreeCelsius', operator: 'lt', value: '5' }), 'x.DegreeCelsius < 5');
    assert.equal(text({ columnKey: 'DegreeCelsius', operator: 'lte', value: '5' }), 'x.DegreeCelsius <= 5');
    assert.equal(
      text({ columnKey: 'DegreeCelsius', operator: 'between', value: '10', value2: '30' }),
      'x.DegreeCelsius >= 10 && x.DegreeCelsius <= 30'
    );
  });

  it('keeps a numeric looking string quoted when the column is text', () => {
    assert.equal(text({ columnKey: 'City', operator: 'equals', value: '42' }), 'x.City == "42"');
  });

  it('escapes quotes and backslashes in values', () => {
    assert.equal(
      text({ operator: 'equals', value: 'He said "hi"\\there' }),
      'x.City == "He said \\"hi\\"\\\\there"'
    );
  });

  it('treats a nested column as a member path', () => {
    assert.equal(
      text({ columnKey: 'Location.Lat', operator: 'gt', value: '10' }),
      'x.Location.Lat > 10'
    );
  });

  it('builds boolean conditions', () => {
    assert.equal(text({ columnKey: 'Active', operator: 'isTrue' }), 'x.Active == true');
    assert.equal(text({ columnKey: 'Active', operator: 'isFalse' }), 'x.Active == false');
    assert.equal(text({ columnKey: 'Active', operator: 'isNull' }), 'isnull(x.Active)');
  });

  it('refuses an incomplete condition', () => {
    assert.equal(isConditionComplete(condition({ value: '' })), false);
    assert.equal(isConditionComplete(condition({ value: '  ' })), false);
    assert.equal(isConditionComplete(condition({ value: 'x' })), true);
    assert.equal(isConditionComplete(condition({ operator: 'empty' })), true);
    assert.equal(isConditionComplete(condition({ operator: 'between', value: '1' })), false);
    assert.equal(isConditionComplete(condition({ operator: 'between', value: '1', value2: '2' })), true);
    assert.equal(text({ operator: 'contains', value: '' }), undefined);
  });

  it('joins every condition with AND', () => {
    const both = [
      condition({ columnKey: 'City', operator: 'equals', value: 'Seoul' }),
      condition({ columnKey: 'DegreeCelsius', operator: 'gt', value: '20' })
    ];

    assert.equal(
      buildFilterText(both, columns),
      'x.City == "Seoul" && x.DegreeCelsius > 20'
    );
  });

  it('keeps a range together when the conditions are joined', () => {
    const text = buildFilterText(
      [
        condition({ columnKey: 'City', operator: 'equals', value: 'Seoul' }),
        condition({ columnKey: 'DegreeCelsius', operator: 'between', value: '10', value2: '30' })
      ],
      columns
    );

    assert.equal(
      text,
      'x.City == "Seoul" && (x.DegreeCelsius >= 10 && x.DegreeCelsius <= 30)'
    );
  });

  it('ignores incomplete conditions and returns nothing when none is usable', () => {
    assert.equal(buildFilterText([condition({ value: '' })], columns), '');
    assert.equal(buildFilterText([], columns), '');
  });
});

describe('reading a filter back into the builder', () => {
  it('understands the comparisons it produces', () => {
    const long = conditionsFromText('x.City == "Seoul" && x.DegreeCelsius > 20', columns);

    assert.deepEqual(long?.conditions, [
      { columnKey: 'City', operator: 'equals', value: 'Seoul', value2: '' },
      { columnKey: 'DegreeCelsius', operator: 'gt', value: '20', value2: '' }
    ]);
  });

  it('understands a range as a single condition', () => {
    const parsed = conditionsFromText('x.DegreeCelsius >= 10 && x.DegreeCelsius <= 30', columns);

    assert.deepEqual(parsed?.conditions, [
      { columnKey: 'DegreeCelsius', operator: 'between', value: '10', value2: '30' }
    ]);
  });

  it('understands the function calls it produces', () => {
    assert.deepEqual(conditionsFromText('contains(x.City, "Seo")', columns)?.conditions, [
      { columnKey: 'City', operator: 'contains', value: 'Seo', value2: '' }
    ]);
    assert.deepEqual(conditionsFromText('!contains(x.City, "Seo")', columns)?.conditions, [
      { columnKey: 'City', operator: 'notContains', value: 'Seo', value2: '' }
    ]);
    assert.deepEqual(conditionsFromText('isempty(x.City)', columns)?.conditions, [
      { columnKey: 'City', operator: 'empty', value: '', value2: '' }
    ]);
    assert.deepEqual(conditionsFromText('matches(x.City, "^S")', columns)?.conditions, [
      { columnKey: 'City', operator: 'regex', value: '^S', value2: '' }
    ]);
    assert.deepEqual(conditionsFromText('isnull(x.City)', columns)?.conditions, [
      { columnKey: 'City', operator: 'isNull', value: '', value2: '' }
    ]);
  });

  it('accepts an F# style lambda and a WHERE prefix', () => {
    assert.deepEqual(conditionsFromText('fun x -> x.City == "Seoul"', columns)?.conditions, [
      { columnKey: 'City', operator: 'equals', value: 'Seoul', value2: '' }
    ]);
    assert.deepEqual(conditionsFromText('WHERE x => x.City != "Seoul"', columns)?.conditions, [
      { columnKey: 'City', operator: 'notEquals', value: 'Seoul', value2: '' }
    ]);
  });

  it('reads conditions joined with AND', () => {
    assert.equal(conditionsFromText('x.City == "a" && x.City == "b"', columns)?.conditions.length, 2);
  });

  it('gives up on expressions the builder cannot show', () => {
    assert.equal(conditionsFromText('len(x.City) > 2', columns), undefined);
    assert.equal(conditionsFromText('x.City == "a" || x.City == "b"', columns), undefined);
    assert.equal(conditionsFromText('x.City == "a" && x.Feels == "b" || x.Active == true', columns), undefined);
    assert.equal(conditionsFromText('x.City ==', columns), undefined);
    assert.equal(conditionsFromText('x.Missing == 1', columns), undefined);
  });

  it('round trips what it builds', () => {
    const original = [
      condition({ columnKey: 'City', operator: 'contains', value: 'Seo' }),
      condition({ columnKey: 'DegreeCelsius', operator: 'between', value: '10', value2: '30' }),
      condition({ columnKey: 'Feels', operator: 'notEmpty' })
    ];
    const built = buildFilterText(original, columns);
    const parsed = conditionsFromText(built, columns);

    assert.ok(parsed);
    assert.deepEqual(
      parsed.conditions.map((entry) => ({ operator: entry.operator, columnKey: entry.columnKey })),
      original.map((entry) => ({ operator: entry.operator, columnKey: entry.columnKey }))
    );
    assert.equal(buildFilterText(parsed.conditions, columns), built);
  });

  it('treats an empty filter as no condition at all', () => {
    assert.deepEqual(conditionsFromText('   ', columns), { conditions: [] });
  });
});
