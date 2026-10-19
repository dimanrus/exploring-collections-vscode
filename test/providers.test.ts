import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createProviderRegistry, helperRelativePath } from '../src/providers';
import type { LanguageProvider, ProviderMatchContext } from '../src/providers/languageProvider';
import { languageFromPath, toLanguageId } from '../src/providers/languageProvider';
import { buildJavaScriptSerializer } from '../src/providers/javascriptProvider';
import { buildXlsx } from '../src/export/xlsx';

const registry = createProviderRegistry();

function match(context: Partial<ProviderMatchContext>): LanguageProvider | undefined {
  return registry.resolve({
    debugType: context.debugType ?? 'unknown',
    customTypes: context.customTypes ?? {},
    stoppedLanguageId: context.stoppedLanguageId,
    sourcePath: context.sourcePath,
    editorLanguageId: context.editorLanguageId
  });
}

describe('provider resolution', () => {
  it('exposes the supported languages', () => {
    // TypeScript is served by the JavaScript provider, which owns both.
    const languages = registry.all().map((provider) => provider.language).sort();
    assert.deepEqual(languages, ['csharp', 'fsharp', 'javascript']);
    assert.deepEqual(
      registry.all().map((provider) => provider.displayName).sort(),
      ['C#', 'F#', 'JavaScript / TypeScript']
    );
  });

  it('resolves .NET and JavaScript debug types', () => {
    assert.equal(match({ debugType: 'coreclr' })?.id, 'csharp');
    assert.equal(match({ debugType: 'netcoredbg' })?.id, 'csharp');
    assert.equal(match({ debugType: 'pwa-node' })?.id, 'javascript');
    assert.equal(match({ debugType: 'debugpy' }), undefined);
  });

  it('uses the stopped source path when no editor is active', () => {
    assert.equal(match({ debugType: 'coreclr', sourcePath: '/tmp/Script.fsx' })?.id, 'fsharp');
    assert.equal(match({ debugType: 'coreclr', sourcePath: '/tmp/Program.cs' })?.id, 'csharp');
  });

  it('ignores .NET providers for adapters that cannot evaluate C#', () => {
    assert.equal(registry.byId('csharp')!.supportsDebugType('pwa-node'), false);
  });

  it('exposes the languages and debug types each provider owns', () => {
    const javascript = registry.byId('javascript')!;
    assert.deepEqual([...javascript.languages].sort(), ['javascript', 'typescript']);
    assert.equal(javascript.supportsDebugType('pwa-chrome'), true);
    assert.equal(javascript.supportsDebugType('coreclr'), false);

    const csharp = registry.byId('csharp')!;
    assert.equal(csharp.supportsDebugType('coreclr'), true);
    assert.equal(csharp.supportsDebugType('unknown-adapter'), false);
  });

  it('does not let an unrelated focused editor hijack the session', () => {
    // The focused editor is only a hint and cannot override the family.
    assert.equal(match({ debugType: 'pwa-node', editorLanguageId: 'fsharp' })?.id, 'javascript');
    assert.equal(match({ debugType: 'coreclr', editorLanguageId: 'typescript' })?.id, 'csharp');
  });

  it('treats the stopped file as authoritative', () => {
    assert.equal(match({ debugType: 'coreclr', stoppedLanguageId: 'fsharp' })?.id, 'fsharp');
    // A stopped file of a language outside the family does not hijack the
    // session: the family default is used instead.
    assert.equal(match({ debugType: 'coreclr', stoppedLanguageId: 'javascript' })?.id, 'csharp');
    assert.equal(match({ debugType: 'pwa-node', stoppedLanguageId: 'csharp' })?.id, 'javascript');
  });

  it('accepts JavaScript and TypeScript through the same provider', () => {
    assert.equal(match({ debugType: 'pwa-node', editorLanguageId: 'typescript' })?.id, 'javascript');
    assert.equal(match({ debugType: 'pwa-node', editorLanguageId: 'javascriptreact' })?.id, 'javascript');
  });

  it('honours an explicit override from the settings', () => {
    const provider = registry.resolve({
      debugType: 'my-debugger',
      customTypes: { 'my-debugger': 'csharp' }
    });
    assert.equal(provider?.id, 'csharp');
  });

  it('returns nothing for an unknown debug type', () => {
    assert.equal(match({ debugType: 'ruby' }), undefined);
  });

  it('lists the debug types used by the menu contributions', () => {
    const types = registry.supportedDebugTypes();
    for (const expected of ['coreclr', 'netcoredbg', 'pwa-node', 'pwa-chrome']) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
  });

  it('maps editor languages and file extensions', () => {
    assert.equal(toLanguageId('csharp'), 'csharp');
    assert.equal(toLanguageId('typescriptreact'), 'typescript');
    assert.equal(toLanguageId('unknown'), undefined);
    assert.equal(languageFromPath('/a/b/Program.fs'), 'fsharp');
    assert.equal(languageFromPath('/a/b/Program.cs'), 'csharp');
    assert.equal(languageFromPath('/a/b/main.mjs'), 'javascript');
    assert.equal(languageFromPath('/a/b/main.py'), undefined);
    assert.equal(languageFromPath('/a/b/main.tsx'), 'typescript');
    assert.equal(languageFromPath('/a/b/noextension'), undefined);
  });
});

describe('provider expressions', () => {
  it('uses the helper file and the helper load expression for .NET', () => {
    const provider = registry.byId('csharp')!;
    assert.match(
      provider.buildNativeFileExpression!('table', 0, 100, '/tmp/page.json') ?? '',
      /ExploringCollections\.CollectionHelper\.WriteJsonFile\(table, 0, 100, "\/tmp\/page\.json"\)/
    );
    assert.match(
      provider.buildHelperLoadExpression!('/x/helper.dll') ?? '',
      /Assembly\.LoadFrom\("\/x\/helper\.dll"\)/
    );
  });

  it('generates a JavaScript serializer that the debuggee can parse and run', () => {
    // The statements are joined with `;`, so an `if`/`else` chain has to be a
    // single statement: a semicolon between them is a syntax error in the
    // debuggee and the whole fast path silently disappears.
    const code = buildJavaScriptSerializer('value', 5, 100000);
    const evaluate = new Function('value', `return ${code}`) as (input: unknown) => string;
    const read = (input: unknown) => JSON.parse(evaluate(input)) as Record<string, unknown>;

    const list = read([{ id: 1 }, { id: 2 }]);
    assert.equal(list.kind, 'sequence');
    assert.equal(list.total, 2);
    assert.deepEqual(list.items, [{ id: 1 }, { id: 2 }]);

    const mapping = read(new Map([['a', 1]]));
    assert.equal(mapping.kind, 'mapping');
    assert.deepEqual(mapping.items, [['a', 1]]);

    const set = read(new Set([1, 2]));
    assert.equal(set.kind, 'sequence');
    assert.deepEqual(set.items, [1, 2]);

    const record = read({ cityCount: 3 });
    assert.equal(record.kind, 'record');
    assert.deepEqual(record.items, [{ cityCount: 3 }]);
  });

  it('builds the helper file expression for C# and F#', () => {
    const expression =
      registry.byId('csharp')!.buildNativeFileExpression!('items', 0, 1000, '/tmp/page.json') ?? '';
    assert.match(expression, /ExploringCollections\.CollectionHelper\.WriteJsonFile/);
    assert.match(expression, /WriteJsonFile\(items, 0, 1000, "\/tmp\/page\.json"\)/);
    assert.equal(
      registry.byId('javascript')!.buildNativeFileExpression,
      undefined,
      'JavaScript reads adapter previews instead of writing files'
    );
  });

  it('builds member expressions per language', () => {
    assert.equal(registry.byId('csharp')!.buildMemberExpression!('x', ['Address', 'City']), 'x.Address.City');
    assert.equal(registry.byId('csharp')!.buildMemberExpression!('x', ['[0]', 'City']), 'x[0].City');
    assert.equal(registry.byId('javascript')!.buildMemberExpression!('x', ['a', 'b']), 'x.a.b');
    assert.equal(registry.byId('fsharp')!.buildMemberExpression!('x', ['Address', 'City']), 'x.Address.City');
  });

  it('serializes JavaScript with a self contained IIFE', () => {
    const expression = buildJavaScriptSerializer('temperatures', 6, 100);
    assert.match(expression, /^\(\(\)=>\{/);
    assert.match(expression, /JSON\.stringify/);
    assert.match(expression, /__ec/);
    assert.match(expression, /const R=temperatures/);
    assert.ok((expression.match(/R instanceof Map/g) ?? []).length > 0);
  });

  it('parses the JavaScript envelope including lookup maps', () => {
    const provider = registry.byId('javascript')!;
    const payload = JSON.stringify({
      __ec: 1,
      kind: 'mapping',
      total: 2,
      items: [
        ['Seoul', { city: 'Seoul' }],
        ['Lima', { city: 'Lima' }]
      ]
    });
    const elements = provider.parseSerializedPayload!(payload)!;
    assert.equal(elements.length, 2);
    assert.equal(elements[0]!.label, 'Seoul');
    assert.deepEqual(elements[0]!.raw, { city: 'Seoul' });
  });

  it('parses enveloped and bare payloads', () => {
    const provider = registry.byId('csharp')!;
    const bare = provider.parseSerializedPayload!('[{"a":1},{"a":2}]')!;
    assert.equal(bare.length, 2);
    const doubleEncoded = provider.parseSerializedPayload!(
      JSON.stringify(JSON.stringify({ __ec: 1, kind: 'sequence', total: 1, items: [{ a: 1 }] }))
    )!;
    assert.equal(doubleEncoded.length, 1);
    assert.equal(provider.parseSerializedPayload!('not json'), undefined);
  });

  it('does not read collections of languages the extension no longer supports', () => {
    for (const id of ['python', 'go', 'rust', 'cpp', 'c']) {
      assert.equal(registry.byId(id), undefined, `${id} must not be registered`);
    }
  });

  it('resolves the bundled helper paths', () => {
    assert.equal(helperRelativePath('csharp'), 'dotnet/dist/ExploringCollections.Helper.dll');
    assert.equal(helperRelativePath('fsharp'), 'dotnet/dist/ExploringCollections.Helper.dll');
    assert.equal(helperRelativePath('javascript'), '');
    assert.equal(helperRelativePath('python'), '');
  });

  it('documents the limitations of every provider', () => {
    for (const provider of registry.all()) {
      assert.ok(provider.notes.length > 0, `${provider.id} must describe its limitations`);
      assert.ok(provider.debugTypes.length > 0 || provider.editorLanguages.length > 0);
    }
  });

  it('keeps the xlsx builder reachable from the provider layer', () => {
    // A smoke test that the export path is bundled for the extension host.
    assert.equal(typeof buildXlsx, 'function');
  });
});
