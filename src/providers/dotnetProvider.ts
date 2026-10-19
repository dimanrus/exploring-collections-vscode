import type { ElementNode } from '../model/snapshotBuilder';
import { AbstractLanguageProvider, quoteForSource } from './baseProvider';
import { elementsFromPayload } from './jsonPayload';
import type { LanguageId } from './languageProvider';

/** Debug types used by the .NET debug adapters. */
export const DOTNET_DEBUG_TYPES = [
  'coreclr',
  'clr',
  'dotnet',
  'mono',
  'vsdbg',
  'netcoredbg',
  'unity'
] as const;

/** Debug types whose `evaluate` supports full C#/F# expressions. */
const EXPRESSION_DEBUG_TYPES = new Set(['coreclr', 'clr', 'dotnet', 'mono', 'vsdbg', 'netcoredbg', 'unity']);

const HELPER_TYPE = 'ExploringCollections.CollectionHelper';

/** Concrete provider for the .NET family; C# and F# differ in expression syntax. */
abstract class DotnetProviderBase extends AbstractLanguageProvider {
  override readonly adapterHints = ['vsdbg', 'netcoredbg', 'mono'];
  /** Element by element reads are too slow; the helper file is the only path. */
  override readonly requiresHelper = true;

  protected abstract readonly expressionDebugTypes: ReadonlySet<string>;

  /** True when the debug type can evaluate arbitrary language expressions. */
  protected supportsExpressions(debugType: string): boolean {
    return this.expressionDebugTypes.has(debugType.trim().toLowerCase());
  }

  /**
   * Only the .NET adapters expose C#/F# expressions, so a .NET provider never
   * attaches to another debug type even when the focused editor looks like C#.
   */
  override supportsDebugType(debugType: string): boolean {
    return this.supportsExpressions(debugType);
  }

  override buildHelperLoadExpression(helperPath: string): string {
    return `System.Reflection.Assembly.LoadFrom(${quoteForSource(helperPath)})`;
  }

  override buildNativeFileExpression(
    source: string,
    start: number,
    count: number,
    path: string
  ): string {
    return `${HELPER_TYPE}.WriteJsonFile(${source}, ${start}, ${count}, ${JSON.stringify(path)})`;
  }

  override parseSerializedPayload(payload: string): ElementNode[] | undefined {
    return elementsFromPayload(payload, Number.MAX_SAFE_INTEGER);
  }

}

/** C# provider: helper file capture, ADO.NET support. */
export class CSharpProvider extends DotnetProviderBase {
  override readonly id = 'csharp';
  override readonly language: LanguageId = 'csharp';
  override readonly displayName = 'C#';
  override readonly debugTypes = DOTNET_DEBUG_TYPES;
  override readonly editorLanguages = ['csharp'];
  override readonly notes = [
    'Collections are read by the bundled helper in one request, whatever their size.',
    'The bundled ExploringCollections helper is loaded into the process on demand and enables full ADO.NET support.'
  ];
  protected override readonly expressionDebugTypes = EXPRESSION_DEBUG_TYPES;

  override buildMemberExpression(source: string, path: readonly string[]): string {
    return path.reduce((accumulated, segment) => `${accumulated}${accessorFor(segment)}`, source);
  }
}

/** F# provider: the same helper, with F# aware type names. */
export class FSharpProvider extends DotnetProviderBase {
  override readonly id = 'fsharp';
  override readonly language: LanguageId = 'fsharp';
  override readonly displayName = 'F#';
  override readonly debugTypes = DOTNET_DEBUG_TYPES;
  override readonly editorLanguages = ['fsharp'];
  override readonly notes = [
    'Collections are read by the bundled helper in one request, whatever their size.',
    'F# records, options, lists and maps are reported as JSON by the bundled helper.'
  ];
  /** Lower than C#, so a plain `coreclr` session resolves to C# unless the stopped file is F#. */
  override readonly debugTypePriority = 90;
  protected override readonly expressionDebugTypes = EXPRESSION_DEBUG_TYPES;

  override buildMemberExpression(source: string, path: readonly string[]): string {
    return path.reduce((accumulated, segment) => `${accumulated}${accessorFor(segment)}`, source);
  }
}

function accessorFor(segment: string): string {
  if (/^\d+$/.test(segment) || /^\[\d+\]$/.test(segment)) {
    const index = segment.replace(/[[\]]/g, '');
    return `[${index}]`;
  }
  return `.${segment}`;
}
