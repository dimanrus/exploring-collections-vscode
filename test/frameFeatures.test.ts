import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub, type VscodeStub } from './vscodeStub';
import type { AdapterVariable } from '../src/model/types';
import type * as CodeLensModule from '../src/services/codeLens';
import type * as FrameCollectionsModule from '../src/services/frameCollections';

type TextDocument = {
  uri: {
    fsPath: string;
    path: string;
    scheme: string;
    toString(): string;
  };
  languageId: string;
  lineCount: number;
  getText(): string;
  lineAt(line: number): { text: string };
  getWordRangeAtPosition(position: unknown, pattern: RegExp): unknown;
};

const notes: string[] = [];
const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  record: (line: string) => notes.push(line)
};

const SOURCE = [
  'public class Program',
  '{',
  '  public static void Main()',
  '  {',
  '    var temperatures = new List<Temperature>();',
  '    var lookup = new Dictionary<string, int>();',
  '    Console.WriteLine(temperatures.Count);',
  '  }',
  '}'
].join('\n');

/** The frame is stopped on the `Console.WriteLine` statement (zero based line 6). */
const STOPPED_LINE = 6;

function documentFrom(source: string, languageId = 'csharp'): TextDocument {
  const lines = source.split('\n');
  return {
    uri: {
      fsPath: '/work/Program.cs',
      path: '/work/Program.cs',
      scheme: 'file',
      toString: () => 'file:///work/Program.cs'
    },
    languageId,
    lineCount: lines.length,
    getText: () => source,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
    getWordRangeAtPosition: () => undefined
  };
}

function collection(name: string, elementCount = 14) {
  return {
    name,
    expression: name,
    typeName: 'List<Temperature>',
    preview: `Count = ${elementCount}`,
    variablesReference: 42,
    elementCount,
    classification: 'sequence' as const
  };
}

interface Harness {
  stub: VscodeStub;
  codeLens: typeof CodeLensModule;
  frameCollections: typeof FrameCollectionsModule;
}

let harness: Harness;

async function harnessFor(): Promise<Harness> {
  const stub = installVscodeStub();
  // Both modules import `vscode`, so they are imported after the stub is in place.
  const [codeLens, frameCollections] = await Promise.all([
    import('../src/services/codeLens'),
    import('../src/services/frameCollections')
  ]);
  return { stub, codeLens, frameCollections };
}

function configure(stub: VscodeStub, values: Record<string, unknown>): void {
  const workspace = stub.api.workspace as { getConfiguration: unknown };
  workspace.getConfiguration = () => ({
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    has: () => false,
    update: async () => undefined,
    inspect: () => undefined
  });
}

function registryStub(frameId: number | undefined, sourcePath: string | undefined) {
  const session = { id: 'session-1', type: 'coreclr', name: 'Demo' };
  return {
    session,
    registry: {
      activeSession: () => session,
      sessionById: (id: string) => (id === session.id ? session : undefined),
      resolve: async () => (frameId === undefined ? undefined : { frameId, sourcePath }),
      describeContextSync: () => ({ provider: { editorLanguages: ['csharp'] }, match: {} }),
      onDidChange: () => ({ dispose: () => undefined })
    } as never
  };
}

function collectionsStub(entries: unknown[]) {
  return {
    forFrame: async () => entries,
    forActiveFrame: async () => entries,
    onDidChange: () => ({ dispose: () => undefined }),
    invalidate: () => undefined
  } as never;
}

function token(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => undefined })
  } as never;
}

interface LensShape {
  range: { start: { line: number } };
  command?: { command: string; title: string; tooltip?: string; arguments?: unknown[] };
}

function providerFor(
  frameId: number | undefined,
  sourcePath: string | undefined,
  entries: unknown[]
): InstanceType<typeof CodeLensModule.CollectionCodeLensProvider> {
  const { registry } = registryStub(frameId, sourcePath);
  return new harness.codeLens.CollectionCodeLensProvider(registry, collectionsStub(entries), logger);
}

describe('code lens on collection variables', () => {
  before(async () => {
    harness = await harnessFor();
  });

  it('offers one lens per collection, above the code the user is reading', async () => {
    const lenses = (await providerFor(STOPPED_LINE, '/work/Program.cs', [
      collection('temperatures'),
      collection('lookup', 3)
    ]).provideCodeLenses(documentFrom(SOURCE) as never, token())) as unknown as LensShape[];

    assert.equal(lenses.length, 2);
    assert.equal(lenses[0]!.range.start.line, 4, 'the declaration of temperatures');
    assert.equal(lenses[1]!.range.start.line, 5, 'the declaration of lookup');

    assert.equal(lenses[0]!.command?.command, 'exploringCollections.explore');
    assert.match(lenses[0]!.command?.title ?? '', /Explore collection/);
    assert.match(lenses[0]!.command?.title ?? '', /temperatures/);
    assert.match(lenses[0]!.command?.title ?? '', /14/);
    assert.match(lenses[0]!.command?.tooltip ?? '', /List<Temperature>/);
  });

  it('hands the debug variable to the explore command', async () => {
    const lenses = (await providerFor(STOPPED_LINE, '/work/Program.cs', [
      collection('temperatures')
    ]).provideCodeLenses(documentFrom(SOURCE) as never, token())) as unknown as LensShape[];

    const argument = (lenses[0]!.command?.arguments?.[0] ?? {}) as {
      sessionId?: string;
      variable?: AdapterVariable;
    };

    assert.equal(argument.sessionId, 'session-1');
    assert.equal(argument.variable?.name, 'temperatures');
    assert.equal(argument.variable?.evaluateName, 'temperatures');
    assert.equal(argument.variable?.variablesReference, 42);
  });

  it('stays out of documents the debugger is not stopped in', async () => {
    const lenses = await providerFor(STOPPED_LINE, '/work/Other.cs', [
      collection('temperatures')
    ]).provideCodeLenses(documentFrom(SOURCE) as never, token());

    assert.deepEqual(lenses, []);
  });

  it('offers nothing without a stopped frame', async () => {
    const lenses = await providerFor(undefined, undefined, [collection('temperatures')]).provideCodeLenses(
      documentFrom(SOURCE) as never,
      token()
    );

    assert.deepEqual(lenses, []);
  });

  it('offers nothing when the frame holds no collection', async () => {
    const lenses = await providerFor(STOPPED_LINE, '/work/Program.cs', []).provideCodeLenses(
      documentFrom(SOURCE) as never,
      token()
    );

    assert.deepEqual(lenses, []);
  });

  it('drops a cancelled request', async () => {
    const lenses = await providerFor(STOPPED_LINE, '/work/Program.cs', [
      collection('temperatures')
    ]).provideCodeLenses(documentFrom(SOURCE) as never, token(true));

    assert.deepEqual(lenses, []);
  });

  it('can be turned off with a setting', async () => {
    configure(harness.stub, { showCodeLens: false });

    const lenses = await providerFor(STOPPED_LINE, '/work/Program.cs', [
      collection('temperatures')
    ]).provideCodeLenses(documentFrom(SOURCE) as never, token());
    assert.deepEqual(lenses, [], 'the setting must win');

    configure(harness.stub, {});
    const restored = await providerFor(STOPPED_LINE, '/work/Program.cs', [
      collection('temperatures')
    ]).provideCodeLenses(documentFrom(SOURCE) as never, token());
    assert.equal(restored.length, 1);
  });

  it('refreshes the editor when the frame changes', () => {
    const provider = providerFor(STOPPED_LINE, '/work/Program.cs', []);
    let refreshes = 0;
    provider.onDidChangeCodeLenses(() => {
      refreshes += 1;
    });

    provider.refresh();

    assert.equal(refreshes, 1);
    provider.dispose();
  });
});

describe('finding the line a collection lives on', () => {
  before(async () => {
    harness = await harnessFor();
  });

  const ownerLine = (source: string, name: string, stoppedLine: number): number =>
    harness.codeLens.findOwnerLine(source.split('\n'), name, stoppedLine);

  it('prefers the declaration at or above the stopped line', () => {
    assert.equal(ownerLine(SOURCE, 'temperatures', STOPPED_LINE), 4);
  });

  it('falls back to the stopped line when the name is absent', () => {
    assert.equal(ownerLine(SOURCE, 'missing', 6), 6);
  });

  it('uses a usage below the stopped line when there is nothing above', () => {
    assert.equal(ownerLine(SOURCE, 'lookup', 1), 5);
  });

  it('never matches inside a longer identifier or a comment', () => {
    const source = ['var temperaturesCopy = 1;', '// temperatures are cold', 'var x = 2;'].join('\n');

    assert.equal(ownerLine(source, 'temperatures', 2), 2);
  });

  it('puts the lens on the declaring line, not on the breakpoint', () => {
    assert.equal(ownerLine('var data = new int[3];\nConsole.WriteLine(data);', 'data', 1), 0);
  });

  it('tries the identifier spellings the adapter reports', () => {
    const variants = harness.codeLens.identifierVariants({
      name: '_items',
      expression: 'this._items'
    } as never);

    assert.deepEqual(variants, ['this._items', '_items']);
    assert.deepEqual(
      harness.codeLens.identifierVariants({ name: 'Items', expression: 'response.Body.Items' } as never),
      ['response.Body.Items', 'Items', 'Body.Items']
    );
  });

  it('falls back to the enclosing scope instead of the breakpoint', () => {
    const source = [
      'public class Program',
      '{',
      '  public static void Main()',       // 2: the enclosing scope
      '  {',
      '    if (ready)',
      '    {',
      '      Console.WriteLine(count);',    // 6: the stopped line
      '    }',
      '  }',
      '}'
    ].join('\n');

    // `this._count` never occurs in this file: a member of another type.
    const placement = harness.codeLens.resolveOwnerLine(
      source.split('\n'),
      harness.codeLens.identifierVariants({ name: '_count', expression: 'this._count' } as never),
      6
    );

    assert.equal(placement.anchor, 'scope');
    assert.equal(placement.line, 2, 'the lens belongs above the enclosing method');
    assert.notEqual(placement.line, 6, 'the lenses must not pile up on the breakpoint');
  });

  it('keeps the stop line only when there is no scope at all', () => {
    assert.equal(harness.codeLens.enclosingScopeLine(['count++;'], 0), 0);
    assert.equal(
      harness.codeLens.enclosingScopeLine(['  if (ready) {', '    count++;'].join('\n').split('\n'), 1),
      0,
      'a control flow block is better than nothing'
    );
  });

  it('skips a read-only statement to reach the declaration', () => {
    const source = [
      'void Process()',
      '{',
      '  var temperatures = Load();',      // declaration, line 2
      '  var total = temperatures.Count;', // read, line 3
      '  Console.WriteLine(total);',       // breakpoint, line 4
      '}'
    ].join('\n');

    assert.equal(ownerLine(source, 'temperatures', 4), 2, 'the lens belongs above the collection');
  });

  it('recognises the many ways a collection is declared', () => {
    const { isDeclaration } = harness.codeLens;

    assert.equal(isDeclaration('var temperatures = Load();', 'temperatures'), true);
    assert.equal(isDeclaration('temperatures = []', 'temperatures'), true);
    assert.equal(isDeclaration('    temperatures := make([]int, 0)', 'temperatures'), true);
    assert.equal(isDeclaration('let temperatures: Vec<i32> = vec![];', 'temperatures'), true);
    assert.equal(isDeclaration('self.temperatures <- []', 'temperatures'), true);
    assert.equal(isDeclaration('void Process(List<int> temperatures)', 'temperatures'), true);
    assert.equal(isDeclaration('def process(temperatures):', 'temperatures'), true);
    assert.equal(isDeclaration('run(temperatures);', 'temperatures'), false, 'a call is not a declaration');
    assert.equal(isDeclaration('Console.WriteLine(temperatures.Count);', 'temperatures'), false);
    assert.equal(isDeclaration('  return temperatures;', 'temperatures'), false);
  });

  it('uses the stopped line when the collection is only used there', () => {
    assert.equal(ownerLine('var x = 1;\nConsole.WriteLine(items);', 'items', 1), 1);
  });

  it('recognises the stopped file across path separators', () => {
    const document = documentFrom(SOURCE);

    assert.equal(harness.codeLens.sameDocument(document as never, '/work/Program.cs'), true);
    assert.equal(harness.codeLens.sameDocument(document as never, 'C:\\work\\Program.cs'), true);
    assert.equal(harness.codeLens.sameDocument(document as never, '/elsewhere/Program.cs'), false);
    assert.equal(harness.codeLens.sameDocument(document as never, undefined), false);
  });
});

describe('hover links', () => {
  before(async () => {
    harness = await harnessFor();
  });

  it('encodes the explore command as a markdown command URI', () => {
    const uri = harness.frameCollections.exploreCommandUri('session-9', collection('temperatures'));

    assert.ok(uri.startsWith('command:exploringCollections.explore?'));
    const payload = JSON.parse(decodeURIComponent(uri.split('?')[1] as string)) as unknown[];
    assert.equal(payload.length, 1);
    const argument = payload[0] as { sessionId: string; variable: AdapterVariable };
    assert.equal(argument.sessionId, 'session-9');
    assert.equal(argument.variable.evaluateName, 'temperatures');
    assert.equal(argument.variable.variablesReference, 42);
  });

  it('builds the same argument the context menu passes', () => {
    const argument = harness.frameCollections.exploreArgumentFor('s1', collection('lookup', 5));

    assert.equal(argument.sessionId, 's1');
    assert.equal(argument.variable.name, 'lookup');
    assert.equal(argument.variable.value, 'Count = 5');
    assert.equal(argument.variable.type, 'List<Temperature>');
  });
});

describe('collection discovery', () => {
  before(async () => {
    harness = await harnessFor();
  });

  const variable = (overrides: Partial<AdapterVariable>): AdapterVariable => ({
    name: 'v',
    value: 'Count = 3',
    variablesReference: 7,
    indexedVariables: 3,
    namedVariables: 0,
    ...overrides
  });

  it('keeps sequences and maps, drops everything else', () => {
    assert.ok(harness.frameCollections.toFrameCollection(variable({ name: 'list', type: 'List<int>' })));
    assert.ok(
      harness.frameCollections.toFrameCollection(
        variable({ name: 'map', type: 'Dictionary<string,int>', indexedVariables: 0, namedVariables: 4 })
      )
    );
    assert.equal(
      harness.frameCollections.toFrameCollection(variable({ name: 'one', indexedVariables: 1, namedVariables: 0 })),
      undefined,
      'a single element is not worth a viewer'
    );
    assert.equal(
      harness.frameCollections.toFrameCollection(
        variable({ name: 'text', value: '"hello"', indexedVariables: 0, type: 'string' })
      ),
      undefined
    );
  });

  it('recognises a leading count in the preview of adapters without counters', () => {
    const entry = harness.frameCollections.toFrameCollection(
      variable({
        name: 'temperatures',
        type: 'Array',
        value: '(12) [{…}, {…}, {…}]',
        evaluateName: 'temperatures',
        indexedVariables: undefined,
        namedVariables: undefined
      })
    );

    assert.equal(entry?.classification, 'sequence');
    assert.equal(entry?.elementCount, 12);
  });

  it('recognises an object preview as a mapping without counters', () => {
    const entry = harness.frameCollections.toFrameCollection(
      variable({
        name: 'lookup',
        type: 'Object',
        value: '{cityCount: 3, sampleCount: 12}',
        evaluateName: 'lookup',
        indexedVariables: undefined,
        namedVariables: undefined
      })
    );

    assert.equal(entry?.classification, 'map');
    assert.equal(entry?.elementCount, 0, 'the adapter did not report a count');
  });

  it('ignores functions and values that cannot be expanded', () => {
    const base = { evaluateName: 'x', indexedVariables: undefined, namedVariables: undefined };

    assert.equal(
      harness.frameCollections.toFrameCollection(
        variable({ ...base, name: 'atob', type: 'Function', value: 'ƒ atob(input) { … }' })
      ),
      undefined
    );
    assert.equal(
      harness.frameCollections.toFrameCollection(
        variable({ ...base, name: 'this', type: 'global', value: 'global' })
      ),
      undefined
    );
    assert.equal(
      harness.frameCollections.toFrameCollection(
        variable({ ...base, name: 'summary', type: 'number', value: '15', variablesReference: 0 })
      ),
      undefined,
      'a primitive has nothing to expand'
    );
  });

  it('describes the collection with the expression the debugger understands', () => {
    const entry = harness.frameCollections.toFrameCollection(
      variable({ name: 'temperatures', evaluateName: 'this.temperatures', indexedVariables: 14 })
    );

    assert.equal(entry?.expression, 'this.temperatures');
    assert.equal(entry?.elementCount, 14);
    assert.equal(entry?.classification, 'sequence');
  });

  it('caches per frame and refreshes when invalidated', async () => {
    let lookups = 0;
    const registry = {
      activeSession: () => ({ id: 'session-1' }),
      resolve: async () => ({ frameId: 7 }),
      clientFor: () => ({
        scopes: async () => {
          lookups += 1;
          return [{ name: 'Locals', variablesReference: 1, expensive: false }];
        },
        variables: async () => [variable({ name: 'temperatures' })]
      })
    } as never;
    const index = new harness.frameCollections.FrameCollectionIndex(registry, logger);

    const first = await index.forFrame({ id: 'session-1' } as never, 7);
    const second = await index.forFrame({ id: 'session-1' } as never, 7);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(lookups, 1, 'the second call is served from the cache');

    let changes = 0;
    index.onDidChange(() => {
      changes += 1;
    });
    index.invalidate();
    await index.forFrame({ id: 'session-1' } as never, 7);

    assert.equal(lookups, 2, 'invalidate forces a fresh lookup');
    assert.equal(changes, 1);
    index.dispose();
  });

  it('reports a broken adapter as an empty list instead of throwing', async () => {
    const registry = {
      activeSession: () => ({ id: 'session-1' }),
      resolve: async () => ({ frameId: 7 }),
      clientFor: () => ({
        scopes: async () => {
          throw new Error('the debug adapter is not responding');
        }
      })
    } as never;
    const index = new harness.frameCollections.FrameCollectionIndex(registry, logger);

    assert.deepEqual(await index.forFrame({ id: 'session-1' } as never, 7), []);
    index.dispose();
  });

  it('reads the collections of the active frame', async () => {
    const registry = {
      activeSession: () => ({ id: 'session-1' }),
      resolve: async () => ({ frameId: 3 }),
      clientFor: () => ({
        scopes: async () => [{ name: 'Locals', variablesReference: 1, expensive: false }],
        variables: async () => [
          variable({ name: 'temperatures' }),
          variable({ name: 'n', indexedVariables: 0 })
        ]
      })
    } as never;
    const index = new harness.frameCollections.FrameCollectionIndex(registry, logger);

    const entries = await index.forActiveFrame();

    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['temperatures']
    );
    index.dispose();
  });

  it('resolves nothing without a session', async () => {
    const index = new harness.frameCollections.FrameCollectionIndex(
      { activeSession: () => undefined } as never,
      logger
    );

    assert.deepEqual(await index.forActiveFrame(), []);
    index.dispose();
  });
});
