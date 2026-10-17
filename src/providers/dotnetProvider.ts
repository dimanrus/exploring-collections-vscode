import type { ElementNode } from '../model/snapshotBuilder';
import { emitBody } from '../filter/emit';
import { CSHARP_DIALECT, FSHARP_DIALECT } from '../filter/dialects';
import { AbstractLanguageProvider, quoteForSource } from './baseProvider';
import { elementsFromPayload } from './jsonPayload';
import type {
  FilterEmitInput,
  FilterTranslation,
  HelperOptions,
  LanguageId
} from './languageProvider';

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

/** Adapter type names that are handled by the bundled helper assembly. */
const DATA_TABLE_TYPES = /datatable|dataset|dataview|datarelation|datacolumn|datarow/i;

/** Options shared by the generated `System.Text.Json` serializer calls. */
const JSON_OPTIONS =
  'new System.Text.Json.JsonSerializerOptions { IncludeFields = true, MaxDepth = 8, ' +
  'ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles }';

const HELPER_TYPE = 'ExploringCollections.CollectionHelper';

/** Concrete provider for the .NET family; C# and F# differ in expression syntax. */
abstract class DotnetProviderBase extends AbstractLanguageProvider {
  override readonly adapterHints = ['vsdbg', 'netcoredbg', 'mono'];

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

  override buildNativeHelperExpression(source: string): string {
    return `${HELPER_TYPE}.ToJson(${source})`;
  }

  override parseSerializedPayload(payload: string): ElementNode[] | undefined {
    return elementsFromPayload(payload, Number.MAX_SAFE_INTEGER);
  }

  protected serializeCandidates(source: string, options: HelperOptions): string[] {
    const candidates: string[] = [];
    const isDataTable = options.rootType !== undefined && DATA_TABLE_TYPES.test(options.rootType);
    if (!isDataTable) {
      candidates.push(`System.Text.Json.JsonSerializer.Serialize(${source}, ${JSON_OPTIONS})`);
      candidates.push(`System.Text.Json.JsonSerializer.Serialize(${source})`);
      candidates.push(`Newtonsoft.Json.JsonConvert.SerializeObject(${source})`);
    }
    return candidates;
  }
}

/** C# provider: LINQ pushdown, `System.Text.Json` fast path, ADO.NET helper. */
export class CSharpProvider extends DotnetProviderBase {
  override readonly id = 'csharp';
  override readonly language: LanguageId = 'csharp';
  override readonly displayName = 'C#';
  override readonly debugTypes = DOTNET_DEBUG_TYPES;
  override readonly editorLanguages = ['csharp'];
  override readonly notes = [
    'C# filter expressions are pushed down to the debugger as LINQ when the collection is larger than the fetched window.',
    'The bundled ExploringCollections helper is loaded into the process on demand and enables full ADO.NET support.'
  ];
  protected override readonly expressionDebugTypes = EXPRESSION_DEBUG_TYPES;

  override buildSerializeExpression(source: string, options: HelperOptions): string[] {
    return this.serializeCandidates(source, options);
  }

  override buildFilterExpression(source: string, filter: FilterEmitInput): FilterTranslation {
    const emitted = emitBody(filter.body, { sourceParameter: filter.parameter, targetParameter: 'x', dialect: CSHARP_DIALECT });
    const list = `System.Linq.Enumerable.ToList(System.Linq.Enumerable.Where(${source}, x => ${emitted.text}))`;
    return {
      // The filtered set has to travel as JSON, because that is what the payload
      // reader expects; a `List<T>` alone arrives as a debugger preview string.
      expression: `System.Text.Json.JsonSerializer.Serialize(${list})`,
      exact: emitted.exact,
      notes: emitted.notes
    };
  }

  override buildRangeExpression(source: string, start: number, count: number): string {
    const page = `System.Linq.Enumerable.ToList(System.Linq.Enumerable.Take(System.Linq.Enumerable.Skip(${source}, ${start}), ${count}))`;
    return `System.Text.Json.JsonSerializer.Serialize(${page})`;
  }

  override buildMemberExpression(source: string, path: readonly string[]): string {
    return path.reduce((accumulated, segment) => `${accumulated}${accessorFor(segment)}`, source);
  }
}

/** F# provider: `Seq.filter` pushdown with F# syntax translation. */
export class FSharpProvider extends DotnetProviderBase {
  override readonly id = 'fsharp';
  override readonly language: LanguageId = 'fsharp';
  override readonly displayName = 'F#';
  override readonly debugTypes = DOTNET_DEBUG_TYPES;
  override readonly editorLanguages = ['fsharp'];
  override readonly notes = [
    'F# filters are translated to `Seq.filter (fun x -> ...)` before being pushed down.',
    'F# records, options, lists and maps are reported as JSON by the bundled helper.'
  ];
  /** Lower than C#, so a plain `coreclr` session resolves to C# unless the stopped file is F#. */
  override readonly debugTypePriority = 90;
  protected override readonly expressionDebugTypes = EXPRESSION_DEBUG_TYPES;

  override buildSerializeExpression(source: string, options: HelperOptions): string[] {
    return this.serializeCandidates(source, options);
  }

  override buildFilterExpression(source: string, filter: FilterEmitInput): FilterTranslation {
    const emitted = emitBody(filter.body, { sourceParameter: filter.parameter, targetParameter: 'x', dialect: FSHARP_DIALECT });
    return {
      expression: `System.Text.Json.JsonSerializer.Serialize(List.ofSeq (Seq.filter (fun x -> ${emitted.text}) ${source}))`,
      exact: emitted.exact,
      notes: emitted.notes
    };
  }

  override buildRangeExpression(source: string, start: number, count: number): string {
    return `System.Text.Json.JsonSerializer.Serialize(List.ofSeq (Seq.take ${count} (Seq.skip ${start} ${source})))`;
  }

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
