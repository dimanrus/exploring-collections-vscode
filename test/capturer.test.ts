import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureCollection,
  evaluateMember,
  filterCollection,
  helperRelativePath,
  toWalkRoot,
  type CaptureRequest,
  type FilterRequest,
  type SessionHelperState
} from '../src/providers/capturer';
import {
  RequestBudget,
  elementFromRawValue,
  isIndexedName,
  unwrapSerializedPayload
} from '../src/providers/variablesWalk';
import { elementsFromPayload, readEnvelope, tryParseJson } from '../src/providers/jsonPayload';
import { createProviderRegistry } from '../src/providers';
import type { CaptureOptions, CollectionSnapshot } from '../src/model/types';
import type { DapClient } from '../src/debug/dapClient';
import { silentLogger } from '../src/util/logging';

const registry = createProviderRegistry();
const csharp = registry.byId('csharp')!;

type FakeVariable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  indexedVariables?: number;
  namedVariables?: number;
};

type Evaluation = { ok: true; result: string } | { ok: false; error: string } | undefined;

/** Stands in for a debug adapter: a variables tree plus an expression evaluator. */
class FakeDap {
  requests = 0;
  evaluated: string[] = [];

  constructor(
    private readonly tree: Map<number, FakeVariable[]>,
    private readonly evaluator: (expression: string) => Evaluation,
    /** Adapter quirks: a page size of its own, no paging, or a slow transport. */
    private readonly quirks: {
      pageCap?: number;
      ignorePaging?: boolean;
      rejectPaging?: boolean;
      latencyMs?: number;
    } = {}
  ) {}

  resetCounters(): void {
    this.requests = 0;
  }

  async variables(query: { reference: number; start?: number; count?: number }): Promise<FakeVariable[]> {
    this.requests += 1;
    if (this.quirks.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.quirks.latencyMs));
    }
    const children = this.tree.get(query.reference) ?? [];
    if (query.start === undefined && query.count === undefined) {
      return children;
    }
    if (this.quirks.rejectPaging) {
      return [];
    }
    if (this.quirks.ignorePaging) {
      return children.slice(0, this.quirks.pageCap ?? children.length);
    }
    const start = query.start ?? 0;
    const cap = Math.min(query.count ?? children.length, this.quirks.pageCap ?? Number.MAX_SAFE_INTEGER);
    return children.slice(start, start + cap);
  }

  async tryEvaluate(
    expression: string
  ): Promise<
    | { ok: true; value: { result: string; variablesReference: number } }
    | { ok: false; error: Error; unsupported: boolean }
  > {
    this.evaluated.push(expression);
    const outcome = this.evaluator(expression);
    if (!outcome) {
      return { ok: false, error: new Error(`no evaluator for '${expression}'`), unsupported: false };
    }
    if (outcome.ok) {
      return { ok: true, value: { result: outcome.result, variablesReference: 0 } };
    }
    return { ok: false, error: new Error(outcome.error), unsupported: false };
  }
}

const CITIES = ['Seoul', 'Sofia', 'Mexico City', 'Cape Town', 'Brisbane', 'Houston', 'Lima'];
const ELEMENT_COUNT = 14;

function deg(index: number): number {
  return 5 + index * 2;
}

function city(index: number): string {
  return CITIES[index % CITIES.length] as string;
}

/** The `List<Temperature> temperatures` variable of the sample program. */
function weatherTree(): Map<number, FakeVariable[]> {
  const tree = new Map<number, FakeVariable[]>();
  const elements: FakeVariable[] = [];
  for (let index = 0; index < ELEMENT_COUNT; index += 1) {
    const reference = 100 + index;
    elements.push({
      name: `[${index}]`,
      value: '{Temperature}',
      type: 'Temperature',
      variablesReference: reference,
      evaluateName: `temperatures[${index}]`,
      namedVariables: 3
    });
    tree.set(reference, [
      { name: 'City', value: `"${city(index)}"`, type: 'string', variablesReference: 0 },
      { name: 'DegreeCelsius', value: String(deg(index)), type: 'int', variablesReference: 0 },
      { name: 'Feels', value: 'normal', type: 'Feels', variablesReference: 0 }
    ]);
  }
  tree.set(1, [
    ...elements,
    { name: 'Count', value: String(ELEMENT_COUNT), type: 'int', variablesReference: 0 },
    { name: 'Capacity', value: '16', type: 'int', variablesReference: 0 }
  ]);
  return tree;
}

function weatherPayload(): string {
  const items = Array.from({ length: ELEMENT_COUNT }, (_, index) => ({
    City: city(index),
    DegreeCelsius: deg(index),
    Feels: 'normal'
  }));
  return JSON.stringify({ __ec: 1, kind: 'sequence', total: items.length, items });
}

/** A flat collection of `count` primitive elements behind variables reference 1. */
function indexedTree(count: number): Map<number, FakeVariable[]> {
  const elements: FakeVariable[] = [];
  for (let index = 0; index < count; index += 1) {
    elements.push({ name: `[${index}]`, value: String(index), type: 'int', variablesReference: 0 });
  }
  return new Map<number, FakeVariable[]>([[1, elements]]);
}

/** Splits the `Skip(items, start), count)` part out of a C# range expression. */
function rangeOf(expression: string): { start: number; count: number } | undefined {
  const match = /Skip\(items, (\d+)\), (\d+)\)/.exec(expression);
  return match ? { start: Number(match[1]), count: Number(match[2]) } : undefined;
}

/**
 * Evaluator that answers the C# range expression with a JSON page, the way a
 * real .NET evaluator does once the page is serialized.
 */
function rangeEvaluator(rows: number, cutAbove = Number.MAX_SAFE_INTEGER) {
  return (expression: string): Evaluation => {
    const range = rangeOf(expression);
    if (!range) {
      return undefined;
    }
    const length = Math.max(0, Math.min(range.count, rows - range.start));
    const items = Array.from({ length }, (_, index) => ({ Id: range.start + index }));
    const payload = JSON.stringify(items);
    // Mimics an adapter that cuts long strings: big pages come back unparseable.
    return { ok: true, result: range.count > cutAbove ? payload.slice(0, 40) : payload };
  };
}

/** A collection of `count` objects, so every element costs a request to expand. */
function objectTree(count: number): Map<number, FakeVariable[]> {
  const tree = new Map<number, FakeVariable[]>();
  const elements: FakeVariable[] = [];
  for (let index = 0; index < count; index += 1) {
    const reference = 100 + index;
    elements.push({
      name: `[${index}]`,
      value: '{item}',
      type: 'Item',
      variablesReference: reference,
      evaluateName: `items[${index}]`,
      namedVariables: 2
    });
    tree.set(reference, [
      { name: 'Id', value: String(index), type: 'int', variablesReference: 0 },
      { name: 'Name', value: `"n${index}"`, type: 'string', variablesReference: 0 }
    ]);
  }
  tree.set(1, elements);
  return tree;
}

/**
 * Mimics an adapter that elides long results in the middle, the way js-debug
 * does: the text still parses as JSON, but members are mangled and rows are gone.
 */
function elidingEvaluator(rows: number, limitChars: number) {
  return (expression: string): Evaluation => {
    const range = rangeOf(expression);
    if (!range) {
      return undefined;
    }
    const length = Math.max(0, Math.min(range.count, rows - range.start));
    const items = Array.from({ length }, (_, index) => ({ Id: range.start + index }));
    const payload = JSON.stringify({ __ec: 1, kind: 'sequence', total: items.length, items });
    return {
      ok: true,
      result:
        payload.length <= limitChars
          ? payload
          : `${payload.slice(0, limitChars - 60)}…${payload.slice(-60)}`
    };
  };
}

/** Walk root of a flat collection that reports its element count. */
function flatRoot(name: string, childCount: number) {
  return {
    name,
    variablesReference: 1,
    evaluateName: name,
    typeName: 'List<int>',
    childCount
  };
}

const options: CaptureOptions = {
  maxRows: 10000,
  captureBudgetMs: 30000,
  maxDepth: 3,
  concurrency: 4,
  timeoutMs: 1000,
  useHelpers: true,
  dictionariesAsRows: true,
  excludedMembers: ['Capacity', 'Count', 'Length']
};

const formatOptions = { dateFormat: 'iso' as const, maxCellLength: 512, emptyStringAsNull: false };
const layout = { columnOrder: 'alphabetical' as const, flattenDepth: 2 };

function captureRequest(dap: FakeDap, overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    client: dap as unknown as DapClient,
    provider: csharp,
    session: { id: 'session-1', name: 'Demo', debugType: 'coreclr' },
    title: 'temperatures',
    source: 'temperatures',
    root: {
      name: 'temperatures',
      variablesReference: 1,
      evaluateName: 'temperatures',
      typeName: 'List<Temperature>',
      childCount: ELEMENT_COUNT
    },
    frameId: 7,
    options,
    formatOptions,
    layout,
    helperOptions: { depth: 5, helperPath: (relative) => `/extension/helpers/${relative}` },
    helperState: { attempted: false, loaded: false },
    logger: silentLogger,
    ...overrides
  };
}

function filterRequest(
  dap: FakeDap,
  snapshot: CollectionSnapshot,
  filterText: string,
  overrides: Partial<FilterRequest> = {}
): FilterRequest {
  return {
    client: dap as unknown as DapClient,
    provider: csharp,
    snapshot,
    filterText,
    frameId: 7,
    options,
    formatOptions,
    helperOptions: { depth: 5 },
    helperState: { attempted: true, loaded: false },
    enablePushdown: true,
    layout,
    logger: silentLogger,
    ...overrides
  };
}

describe('capture through a serializer (fast path)', () => {
  it('uses the JSON serializer when the adapter can evaluate it', async () => {
    const dap = new FakeDap(weatherTree(), (expression) =>
      expression.startsWith('System.Text.Json.JsonSerializer.Serialize')
        ? { ok: true, result: weatherPayload() }
        : undefined
    );

    const snapshot = await captureCollection(captureRequest(dap));

    assert.equal(snapshot.diagnostics.strategy, 'helper-json');
    assert.equal(snapshot.rows.length, ELEMENT_COUNT);
    assert.equal(snapshot.totalItems, ELEMENT_COUNT);
    assert.equal(snapshot.truncated, false);
    assert.deepEqual(
      snapshot.columns.map((column) => column.key),
      ['#', 'City', 'DegreeCelsius', 'Feels']
    );
    assert.equal(snapshot.rows[0]!.cells[1]!.text, 'Seoul');
    assert.equal(snapshot.rows[0]!.cells[2]!.kind, 'number');
    assert.equal(dap.requests, 0, 'the variables tree must not be touched');
  });

  it('falls back to the next serializer candidate', async () => {
    const dap = new FakeDap(weatherTree(), (expression) =>
      expression.startsWith('Newtonsoft')
        ? { ok: true, result: weatherPayload() }
        : { ok: false, error: 'expression evaluator does not support this' }
    );

    const snapshot = await captureCollection(captureRequest(dap));

    assert.equal(snapshot.diagnostics.strategy, 'helper-json');
    assert.equal(snapshot.rows.length, ELEMENT_COUNT);
    assert.equal(
      dap.evaluated.filter((expression) => expression.includes('Serialize')).length,
      3,
      'all three serializer candidates were tried'
    );
  });

  it('loads the bundled helper assembly and uses it once per session', async () => {
    const helperState: SessionHelperState = { attempted: false, loaded: false };
    const dap = new FakeDap(weatherTree(), (expression) => {
      if (expression.startsWith('System.Reflection.Assembly.LoadFrom')) {
        return { ok: true, result: '{ExploringCollections.Helper, Version=1.0.0.0}' };
      }
      if (expression.startsWith('ExploringCollections.CollectionHelper.ToJson')) {
        return { ok: true, result: weatherPayload() };
      }
      return undefined;
    });

    const first = await captureCollection(captureRequest(dap, { helperState }));
    assert.equal(first.diagnostics.strategy, 'helper-native');
    assert.equal(helperState.attempted, true);
    assert.equal(helperState.loaded, true);

    const second = await captureCollection(captureRequest(dap, { helperState }));
    assert.equal(second.diagnostics.strategy, 'helper-native');
    assert.equal(
      dap.evaluated.filter((expression) => expression.includes('Assembly.LoadFrom')).length,
      1,
      'the assembly is loaded once per session'
    );
  });

  it('records why the helper could not be loaded and walks instead', async () => {
    const helperState: SessionHelperState = { attempted: false, loaded: false };
    const dap = new FakeDap(weatherTree(), (expression) =>
      expression.startsWith('System.Reflection.Assembly.LoadFrom')
        ? { ok: false, error: 'the expression evaluator cannot load assemblies' }
        : { ok: false, error: 'not supported' }
    );

    const snapshot = await captureCollection(captureRequest(dap, { helperState }));

    assert.equal(helperState.loaded, false);
    assert.equal(snapshot.diagnostics.strategy, 'variables-walk');
    assert.ok(snapshot.diagnostics.fallbackReasons.some((reason) => reason.includes('helper load failed')));
  });

  it('skips every helper when the user disables them', async () => {
    const dap = new FakeDap(weatherTree(), () => ({ ok: false, error: 'must not be called' }));

    const snapshot = await captureCollection(
      captureRequest(dap, { options: { ...options, useHelpers: false } })
    );

    assert.equal(snapshot.diagnostics.strategy, 'variables-walk');
    assert.equal(dap.evaluated.length, 0);
  });

  it('marks a payload as truncated when the helper returned fewer items', async () => {
    const dap = new FakeDap(weatherTree(), (expression) =>
      expression.startsWith('System.Text.Json')
        ? {
            ok: true,
            result: JSON.stringify({
              __ec: 1,
              kind: 'sequence',
              total: 1000,
              items: [{ City: 'Seoul', DegreeCelsius: 21 }]
            })
          }
        : undefined
    );

    const snapshot = await captureCollection(captureRequest(dap));

    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.totalItems, 1000);
    assert.ok(snapshot.warnings.some((warning) => warning.includes('1,000')));
  });
});

describe('capture through the variables walk', () => {
  it('enumerates the elements and derives the columns', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);

    const snapshot = await captureCollection(captureRequest(dap));

    assert.equal(snapshot.diagnostics.strategy, 'variables-walk');
    assert.equal(snapshot.rows.length, ELEMENT_COUNT);
    assert.equal(snapshot.totalItems, ELEMENT_COUNT);
    assert.deepEqual(
      snapshot.columns.map((column) => column.key),
      ['#', 'City', 'DegreeCelsius', 'Feels']
    );
    assert.equal(snapshot.rows[0]!.label, '[0]');
    assert.equal(snapshot.rows[0]!.cells[1]!.text, 'Seoul');
    assert.equal(dap.requests, ELEMENT_COUNT + 1, 'one probe plus one request per element');
    assert.equal(snapshot.diagnostics.requests, ELEMENT_COUNT + 1);
  });

  it('never turns debugger pseudo members into columns', async () => {
    const tree = weatherTree();
    tree.set(1, [
      ...(tree.get(1) as FakeVariable[]),
      ...['Raw View', '[Raw View]', 'Non-Public members', 'Static members', 'Length'].map((name) => ({
        name,
        value: '{}',
        type: 'object',
        variablesReference: 0
      }))
    ]);
    const dap = new FakeDap(tree, () => undefined);

    const snapshot = await captureCollection(captureRequest(dap));

    const keys = snapshot.columns.map((column) => column.key);
    for (const noise of ['Count', 'Capacity', 'Length', 'Raw View', 'Non-Public members', 'Static members']) {
      assert.equal(keys.includes(noise), false, `${noise} must be skipped`);
    }
  });

  it('honours maxRows and reports the truncation', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);

    const snapshot = await captureCollection(captureRequest(dap, { options: { ...options, maxRows: 3 } }));

    assert.equal(snapshot.rows.length, 3);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.totalItems, ELEMENT_COUNT);
    assert.ok(
      snapshot.warnings.some((warning) => warning.includes(`${ELEMENT_COUNT} elements`)),
      `expected a truncation warning, got ${JSON.stringify(snapshot.warnings)}`
    );
  });

  it('reads every page of an adapter with a page size of its own', async () => {
    const dap = new FakeDap(indexedTree(120), () => undefined, { pageCap: 25 });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 120) })
    );

    assert.equal(snapshot.rows.length, 120, 'a capped adapter must not cap the window');
    assert.equal(snapshot.totalItems, 120);
    assert.equal(snapshot.truncated, false);
  });

  it('keeps maxRows as the ceiling while paging', async () => {
    const dap = new FakeDap(indexedTree(120), () => undefined, { pageCap: 25 });

    const snapshot = await captureCollection(
      captureRequest(dap, {
        title: 'items',
        source: 'items',
        root: flatRoot('items', 120),
        options: { ...options, maxRows: 100 }
      })
    );

    assert.equal(snapshot.rows.length, 100);
    assert.equal(snapshot.truncated, true);
    assert.ok(snapshot.warnings.some((warning) => warning.includes('120 elements')));
  });

  it('stops instead of looping when the adapter ignores the page range', async () => {
    const dap = new FakeDap(indexedTree(120), () => undefined, { ignorePaging: true, pageCap: 25 });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 120) })
    );

    assert.equal(snapshot.rows.length, 25);
    assert.equal(snapshot.truncated, true);
    assert.ok(dap.requests <= 3, `the walk must stop early, it made ${dap.requests} requests`);
    assert.ok(
      snapshot.warnings.some(
        (warning) =>
          warning.includes('only the first 25 of 120 children') &&
          warning.includes('ignored the requested page range')
      ),
      `expected an adapter warning, got ${JSON.stringify(snapshot.warnings)}`
    );
  });

  it('falls back to one unpaged request when pages come back empty', async () => {
    const dap = new FakeDap(indexedTree(120), () => undefined, { rejectPaging: true });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 120) })
    );

    assert.equal(snapshot.rows.length, 120);
    assert.equal(snapshot.truncated, false);
  });

  it('takes the element count from the preview text when the adapter reports no counters', () => {
    // vsdbg reports no indexedVariables for a List<T>, only `Count = 5000`.
    const root = toWalkRoot({
      name: 'items',
      value: 'Count = 5000',
      type: 'List<int>',
      variablesReference: 7,
      indexedVariables: 0,
      namedVariables: 0
    });
    assert.equal(root.childCount, 5000);

    const withCounters = toWalkRoot({
      name: 'items',
      value: '{System.Collections.Generic.List<int>}',
      type: 'List<int>',
      variablesReference: 7,
      indexedVariables: 12,
      namedVariables: 2
    });
    assert.equal(withCounters.childCount, 14, 'the counters win over the preview');
  });

  it('pages until the count the preview promised is reached', async () => {
    const dap = new FakeDap(indexedTree(120), () => undefined, { pageCap: 25 });
    // Exactly the vsdbg shape: no counters, the size only in the preview text.
    const root = toWalkRoot({
      name: 'items',
      value: 'Count = 120',
      type: 'List<int>',
      variablesReference: 1,
      indexedVariables: 0,
      namedVariables: 0
    });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root })
    );

    assert.equal(snapshot.rows.length, 120);
    assert.equal(snapshot.truncated, false);
    assert.equal(snapshot.totalItems, 120);
  });

  it('reads the collection through evaluator pages when the adapter hands over a window', async () => {
    const dap = new FakeDap(indexedTree(120), rangeEvaluator(120), {
      ignorePaging: true,
      pageCap: 25
    });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 120) })
    );

    assert.equal(snapshot.diagnostics.strategy, 'expression-subrange');
    assert.equal(snapshot.rows.length, 120);
    assert.equal(snapshot.truncated, false);
    assert.deepEqual(
      snapshot.rows.slice(0, 3).map((row) => row.label),
      ['[0]', '[1]', '[2]'],
      'pages keep their absolute positions'
    );
  });

  it('reads a large declared collection through pages instead of walking it', async () => {
    const dap = new FakeDap(indexedTree(5000), rangeEvaluator(5000), { ignorePaging: true, pageCap: 25 });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 5000) })
    );

    assert.equal(snapshot.diagnostics.strategy, 'expression-subrange');
    assert.equal(snapshot.rows.length, 5000);
    assert.equal(snapshot.truncated, false);
    assert.equal(dap.requests, 0, 'a big declared window must not be walked element by element');
    const pages = dap.evaluated.filter((expression) => expression.includes('Skip(items'));
    assert.equal(pages.length, 5, `5000 elements need five pages of 1024, got ${pages.length}`);
    assert.equal(snapshot.rows[1024]?.label, '[1024]', 'labels keep their absolute position across pages');
  });

  it('shrinks the evaluator page when the payload comes back cut', async () => {
    // Only pages of 16 items and fewer survive the adapter, so the reader has to
    // back off instead of giving up.
    const dap = new FakeDap(indexedTree(120), rangeEvaluator(120, 16), {
      ignorePaging: true,
      pageCap: 25
    });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 120) })
    );

    assert.equal(snapshot.diagnostics.strategy, 'expression-subrange');
    assert.equal(snapshot.rows.length, 120);
  });

  it('never accepts a page the adapter elided in the middle', async () => {
    const dap = new FakeDap(indexedTree(120), elidingEvaluator(120, 400), {
      ignorePaging: true,
      pageCap: 25
    });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 120) })
    );

    assert.equal(snapshot.diagnostics.strategy, 'expression-subrange');
    assert.deepEqual(
      snapshot.rows.map((row) => row.label),
      Array.from({ length: 120 }, (_, index) => `[${index}]`),
      'rows must be real elements, not survivors of an elided payload'
    );
    for (const row of snapshot.rows) {
      assert.match(row.cells[1]?.text ?? '', /^\d+$/, 'every cell must carry a real value');
    }
  });

  it('keeps the walk result when the evaluator cannot express a range', async () => {
    const dap = new FakeDap(indexedTree(120), () => undefined, { ignorePaging: true, pageCap: 25 });

    const snapshot = await captureCollection(
      captureRequest(dap, { title: 'items', source: 'items', root: flatRoot('items', 120) })
    );

    assert.equal(snapshot.diagnostics.strategy, 'variables-walk');
    assert.equal(snapshot.rows.length, 25);
    assert.equal(snapshot.truncated, true);
  });

  it('stops reading when the capture budget runs out instead of hanging', async () => {
    // A slow adapter with its own small window: the walk would need thousands of
    // requests for the whole collection, so the budget has to cut it short.
    const dap = new FakeDap(objectTree(400), () => undefined, { latencyMs: 5 });

    const snapshot = await captureCollection(
      captureRequest(dap, {
        title: 'items',
        source: 'items',
        root: flatRoot('items', 400),
        options: { ...options, captureBudgetMs: 40, maxRows: 400 }
      })
    );

    assert.ok(snapshot.rows.length > 0, 'the rows read before the deadline are kept');
    assert.ok(snapshot.rows.length < 400, `the budget must cut the window, got ${snapshot.rows.length} rows`);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.totalItems, 400);
    assert.ok(
      snapshot.warnings.some((warning) => warning.includes('captureBudgetMs')),
      `expected a budget warning, got ${JSON.stringify(snapshot.warnings)}`
    );
  });

  it('renders a dictionary as one row per entry', async () => {
    const tree = new Map<number, FakeVariable[]>([
      [
        1,
        [
          { name: 'Seoul', value: '21', type: 'int', variablesReference: 0 },
          { name: 'Lima', value: '19', type: 'int', variablesReference: 0 },
          { name: 'Cape Town', value: '11', type: 'int', variablesReference: 0 }
        ]
      ]
    ]);
    const dap = new FakeDap(tree, () => undefined);

    const snapshot = await captureCollection(
      captureRequest(dap, {
        title: 'lookup',
        source: 'lookup',
        root: { name: 'lookup', variablesReference: 1, typeName: 'Dictionary<string,int>', childCount: 3 }
      })
    );

    assert.deepEqual(
      snapshot.columns.map((column) => column.key),
      ['#', 'value']
    );
    assert.equal(snapshot.rows.length, 3);
    assert.deepEqual(
      snapshot.rows.map((row) => row.label),
      ['Seoul', 'Lima', 'Cape Town']
    );
    assert.equal(snapshot.rows[0]!.cells[1]!.text, '21');
  });

  it('keeps a dictionary as columns when the option is disabled', async () => {
    const tree = new Map<number, FakeVariable[]>([
      [
        1,
        [
          { name: 'Seoul', value: '21', type: 'int', variablesReference: 0 },
          { name: 'Lima', value: '19', type: 'int', variablesReference: 0 }
        ]
      ]
    ]);
    const dap = new FakeDap(tree, () => undefined);

    const snapshot = await captureCollection(
      captureRequest(dap, {
        options: { ...options, dictionariesAsRows: false },
        root: { name: 'lookup', variablesReference: 1, typeName: 'Dictionary<string,int>' }
      })
    );

    assert.equal(snapshot.rows.length, 1);
    assert.deepEqual(
      // Columns are ordered alphabetically by default: Lima comes before Seoul.
      snapshot.rows[0]!.cells.map((cell) => cell.text),
      ['lookup', '19', '21']
    );
  });

  it('renders a plain object as a single record row', async () => {
    const tree = new Map<number, FakeVariable[]>([
      [
        1,
        [
          { name: 'City', value: '"Seoul"', type: 'string', variablesReference: 0 },
          { name: 'DegreeCelsius', value: '21', type: 'int', variablesReference: 0 }
        ]
      ]
    ]);
    const dap = new FakeDap(tree, () => undefined);

    const snapshot = await captureCollection(
      captureRequest(dap, {
        title: 'temperature',
        source: 'temperature',
        root: { name: 'temperature', variablesReference: 1, typeName: 'Temperature' }
      })
    );

    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.totalItems, 1);
    assert.deepEqual(
      snapshot.columns.map((column) => column.key),
      ['#', 'City', 'DegreeCelsius']
    );
    assert.equal(snapshot.rows[0]!.cells[1]!.text, 'Seoul');
  });

  it('reports a variable without children instead of throwing', async () => {
    const dap = new FakeDap(new Map(), () => undefined);

    const snapshot = await captureCollection(
      captureRequest(dap, { root: { name: 'x', variablesReference: 0 } })
    );

    assert.equal(snapshot.rows.length, 0);
    assert.equal(snapshot.totalItems, 0);
    assert.ok(snapshot.warnings.some((warning) => warning.includes('no expandable children')));
  });

  it('stops when the request budget is exhausted', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);

    const snapshot = await captureCollection(captureRequest(dap, { requestBudget: 3 }));

    assert.ok(
      snapshot.warnings.some((warning) => warning.includes('stopped after')),
      `expected a budget warning, got ${JSON.stringify(snapshot.warnings)}`
    );
    assert.ok(dap.requests <= ELEMENT_COUNT + 1);
  });
});

describe('filtering a snapshot', () => {
  it('filters on the client when every row was fetched', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);
    const snapshot = await captureCollection(captureRequest(dap));

    const outcome = await filterCollection(filterRequest(dap, snapshot, 'x => x.City == "Seoul"'));

    assert.equal(outcome.result.location, 'client');
    assert.ok(outcome.result.rows.length > 0);
    assert.ok(outcome.result.rows.length < snapshot.rows.length);
    for (const row of outcome.result.rows) {
      assert.equal(row.cells[1]!.text, 'Seoul');
    }
    assert.equal(outcome.snapshot.rows.length, outcome.result.rows.length);
    assert.equal(dap.evaluated.filter((expression) => expression.includes('Enumerable.Where')).length, 0);
  });

  it('pushes an exact filter down when the window is incomplete', async () => {
    const pushed = [
      { City: 'Sofia', DegreeCelsius: 24, Feels: 'normal' },
      { City: 'Houston', DegreeCelsius: 22, Feels: 'normal' }
    ];
    const dap = new FakeDap(weatherTree(), (expression) =>
      expression.includes('Enumerable.Where')
        ? { ok: true, result: JSON.stringify({ __ec: 1, kind: 'sequence', total: pushed.length, items: pushed }) }
        : undefined
    );
    const captured = await captureCollection(captureRequest(dap, { options: { ...options, maxRows: 3 } }));
    assert.equal(captured.truncated, true);

    const outcome = await filterCollection(filterRequest(dap, captured, 'x => x.DegreeCelsius > 20'));

    assert.equal(outcome.result.location, 'debugger');
    assert.equal(outcome.result.rows.length, 2);
    assert.match(outcome.result.executed, /Enumerable\.Where/);
    assert.deepEqual(
      outcome.snapshot.columns.map((column) => column.key),
      captured.columns.map((column) => column.key),
      'columns stay stable after a pushdown'
    );
  });

  it('does not push down a filter that cannot be translated exactly', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);
    const captured = await captureCollection(captureRequest(dap, { options: { ...options, maxRows: 3 } }));

    const outcome = await filterCollection(filterRequest(dap, captured, 'x => like(x.City, "S%")'));

    assert.equal(outcome.result.location, 'client');
    assert.ok(
      outcome.result.warnings.some((warning) => warning.includes('exactly')),
      `expected an exactness warning, got ${JSON.stringify(outcome.result.warnings)}`
    );
    assert.equal(dap.evaluated.filter((expression) => expression.includes('Enumerable.Where')).length, 0);
  });

  it('falls back to the client when the pushdown request fails', async () => {
    const dap = new FakeDap(weatherTree(), (expression) =>
      expression.includes('Enumerable.Where')
        ? { ok: false, error: 'the expression evaluator does not support lambda expressions' }
        : undefined
    );
    const captured = await captureCollection(captureRequest(dap, { options: { ...options, maxRows: 3 } }));

    const outcome = await filterCollection(filterRequest(dap, captured, 'x => x.City == "Seoul"'));

    assert.equal(outcome.result.location, 'client');
    assert.ok(outcome.result.warnings.some((warning) => warning.includes('Pushdown failed')));
  });

  it('resolves free identifiers through the debugger', async () => {
    const dap = new FakeDap(weatherTree(), (expression) =>
      expression === 'threshold' ? { ok: true, result: '20' } : undefined
    );
    const snapshot = await captureCollection(captureRequest(dap));

    const outcome = await filterCollection(filterRequest(dap, snapshot, 'x => x.DegreeCelsius > threshold'));

    assert.ok(dap.evaluated.includes('threshold'));
    assert.ok(outcome.result.rows.length > 0);
    for (const row of outcome.result.rows) {
      assert.ok(Number(row.cells[2]!.text) > 20);
    }
  });

  it('rejects a filter with a syntax error', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);
    const snapshot = await captureCollection(captureRequest(dap));

    await assert.rejects(
      filterCollection(filterRequest(dap, snapshot, 'x => x.City ==')),
      /unexpected|syntax/i
    );
  });

  it('warns when the window is incomplete and pushdown is disabled', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);
    const captured = await captureCollection(captureRequest(dap, { options: { ...options, maxRows: 3 } }));

    const outcome = await filterCollection(
      filterRequest(dap, captured, 'x => x.City == "Seoul"', { enablePushdown: false })
    );

    assert.equal(outcome.result.location, 'client');
    assert.ok(
      outcome.result.warnings.some((warning) => warning.includes('larger than the fetched window')),
      `expected a window warning, got ${JSON.stringify(outcome.result.warnings)}`
    );
  });

  it('keeps every fetched row when the filter is cleared', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);
    const snapshot = await captureCollection(captureRequest(dap));

    const outcome = await filterCollection(filterRequest(dap, snapshot, '   '));

    assert.equal(outcome.result.rows.length, snapshot.rows.length);
    assert.equal(outcome.result.location, 'client');
    assert.equal(outcome.result.executed, '');
  });

  it('accepts an F# style lambda over the same collection', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);
    const snapshot = await captureCollection(captureRequest(dap));

    const outcome = await filterCollection(
      filterRequest(dap, snapshot, 'fun x -> x.DegreeCelsius >= 20 && x.City <> ""')
    );

    assert.ok(outcome.result.rows.length > 0);
    for (const row of outcome.result.rows) {
      assert.ok(Number(row.cells[2]!.text) >= 20);
    }
  });
});

describe('value pane drill-down', () => {
  it('builds a member expression and evaluates it', async () => {
    const dap = new FakeDap(new Map(), (expression) =>
      expression === 'temperatures[0].City' ? { ok: true, result: '"Seoul"' } : undefined
    );

    const member = await evaluateMember(
      dap as unknown as DapClient,
      csharp,
      'temperatures[0]',
      ['City'],
      7,
      options,
      formatOptions
    );

    assert.equal(member?.text, 'Seoul');
    assert.equal(member?.kind, 'string');
  });

  it('returns undefined when the adapter rejects the member path', async () => {
    const dap = new FakeDap(new Map(), () => undefined);

    const member = await evaluateMember(
      dap as unknown as DapClient,
      csharp,
      'temperatures[0]',
      ['Missing'],
      7,
      options,
      formatOptions
    );

    assert.equal(member, undefined);
  });
});

describe('helper plumbing', () => {
  it('resolves the bundled helper per provider', () => {
    assert.equal(helperRelativePath('csharp'), 'dotnet/dist/ExploringCollections.Helper.dll');
    assert.equal(helperRelativePath('fsharp'), 'dotnet/dist/ExploringCollections.Helper.dll');
    assert.equal(helperRelativePath('python'), 'python/exploring_collections_helper.py');
    assert.equal(helperRelativePath('go'), 'go/exploring_collections.go');
    assert.equal(helperRelativePath('rust'), 'rust/exploring_collections.rs');
    assert.equal(helperRelativePath('cpp'), 'cc/exploring_collections.h');
    assert.equal(helperRelativePath('c'), 'cc/exploring_collections.h');
  });

  it('unwraps quoted payloads', () => {
    assert.equal(unwrapSerializedPayload('"[1,2]"'), '[1,2]');
    assert.equal(unwrapSerializedPayload('[1,2]'), '[1,2]');
    assert.equal(unwrapSerializedPayload("  '{}'  "), '{}');
  });

  it('parses envelopes, bare arrays and decorated output', () => {
    const envelope = readEnvelope(tryParseJson('{"__ec":1,"kind":"mapping","total":1,"items":[["a",1]]}'));
    assert.equal(envelope?.kind, 'mapping');
    assert.equal(envelope?.total, 1);
    assert.deepEqual(envelope?.items, [['a', 1]]);

    assert.equal(elementsFromPayload('[{"a":1},{"a":2}]', 10)?.length, 2);
    assert.equal(elementsFromPayload('{"__ec":1,"kind":"sequence","total":2,"items":[1,2]}', 10)?.length, 2);
    assert.equal(elementsFromPayload('"{\\"__ec\\":1,\\"kind\\":\\"sequence\\",\\"items\\":[1,2]}"', 10)?.length, 2);
    assert.equal(elementsFromPayload('definitely not json', 10), undefined);
  });

  it('recognizes indexed child names across languages', () => {
    for (const name of ['[0]', '0', '[12]', '007']) {
      assert.equal(isIndexedName(name), true, name);
    }
    for (const name of ['City', 'Count', 'first', '[-1]']) {
      assert.equal(isIndexedName(name), false, name);
    }
  });

  it('tracks the request budget', () => {
    const budget = new RequestBudget(3);
    assert.equal(budget.remaining, 3);
    assert.equal(budget.consume(), true);
    assert.equal(budget.consume(2), true);
    assert.equal(budget.exhausted, true);
    assert.equal(budget.consume(), false);
    assert.equal(budget.consumed, 3);
  });

  it('wraps primitive and structured elements from helper payloads', () => {
    const primitives = elementsFromPayload('[1,"a",true,null]', 10);
    assert.equal(primitives?.length, 4);
    assert.equal(primitives?.[0]?.fields[0]?.text, '1');
    assert.equal(primitives?.[3]?.fields[0]?.kind, 'null');

    const nested = elementFromRawValue({ a: 1 }, 3);
    assert.equal(nested.label, '[3]');
    assert.equal(elementFromRawValue('x', 1, 'key').label, 'key');
  });
});

describe('snapshot metadata', () => {
  it('carries the session, provider and provider notes', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);

    const snapshot = await captureCollection(captureRequest(dap));

    assert.equal(snapshot.id.startsWith('snap-'), true);
    assert.equal(snapshot.providerId, 'csharp');
    assert.equal(snapshot.language, 'csharp');
    assert.equal(snapshot.sessionId, 'session-1');
    assert.equal(snapshot.expression, 'temperatures');
    assert.ok(snapshot.diagnostics.notes.length > 0);
    assert.ok(snapshot.diagnostics.durationMs >= 0);
    assert.ok(snapshot.capturedAt > 0);
  });

  it('produces a stable id for the same session and expression', async () => {
    const dap = new FakeDap(weatherTree(), () => undefined);

    const first = await captureCollection(captureRequest(dap));
    const second = await captureCollection(captureRequest(dap));

    assert.equal(first.id, second.id);
  });
});
