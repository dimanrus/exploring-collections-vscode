import type { ElementNode } from '../model/snapshotBuilder';
import type { FilterExpression } from '../filter/expression';

export type LanguageId = 'csharp' | 'fsharp' | 'javascript' | 'typescript';

export interface ProviderMatchContext {
  debugType: string;
  /**
   * Language of the file the debugger actually stopped in. It is only set when
   * that file is known for certain (a `debug:` document or the frame reported by
   * the adapter), because it decides the provider on its own.
   */
  stoppedLanguageId?: string;
  /** Path of the file the debugger stopped in, when known. */
  sourcePath?: string;
  /**
   * Language of the focused editor. It is only a tie breaker, never authority:
   * the focused editor may be unrelated to the stopped file.
   */
  editorLanguageId?: string;
  /** User supplied mapping of debug type to provider id. */
  customTypes: Readonly<Record<string, string>>;
}

/** Extra data a provider needs to build helper expressions. */
export interface HelperOptions {
  /** Absolute path of a helper file bundled with the extension. */
  helperPath?: (relativePath: string) => string | undefined;
  /** Text content of a helper file bundled with the extension. */
  readHelper?: (relativePath: string) => string | undefined;
  /** Adapter reported type name of the variable being explored. */
  rootType?: string;
  /** Whether the variable looks like a sequence, a map or a single record. */
  rootShape?: 'sequence' | 'map' | 'record' | 'unknown';
  /** JSON depth used by generated serializers. */
  depth: number;
}

/** Result of translating a canonical filter into a target language. */
export interface FilterTranslation {
  /** Expression to evaluate inside the debuggee. */
  expression: string;
  /**
   * False when the translation might change semantics (for instance when a
   * helper function is approximated). Pushdown is only attempted when the
   * translation is exact; otherwise filtering happens on the fetched rows.
   */
  exact: boolean;
  notes: string[];
}

/** Structured filter handed to a provider for pushdown. */
export interface FilterEmitInput {
  /** AST of the lambda body. */
  body: FilterExpression;
  /** Lambda parameter name, `x` by convention. */
  parameter: string;
  /** Canonical text of the body, useful for diagnostics. */
  canonical: string;
}

/**
 * A language provider adapts the canonical collection model to one debug
 * ecosystem. Providers only describe *how to talk* to the debugger; the shared
 * capture engine in {@link ../providers/capturer} drives the conversation.
 *
 * Every hook is optional: a provider that implements none of them still works
 * through the universal `variables` walk.
 */
export interface LanguageProvider {
  readonly id: string;
  readonly language: LanguageId;
  readonly displayName: string;
  /** DAP debug types this provider can attach to. */
  readonly debugTypes: readonly string[];
  /** Debug adapters names used in diagnostics. */
  readonly adapterHints: readonly string[];
  /** Editor language ids that belong to the provider. */
  readonly editorLanguages: readonly string[];
  /** Limitations surfaced in the diagnostics report. */
  readonly notes: readonly string[];

  /** Canonical languages this provider can handle. */
  readonly languages: readonly LanguageId[];

  /**
   * True when the adapter describes an element's members in the variable
   * preview (`{id: 1, name: 'x'}`), so rows can be built without expanding
   * every element with its own request.
   */
  readonly readElementsFromPreviews?: boolean;

  /**
   * True when the language has no usable slow fallback: reading element by
   * element is too slow to be a strategy, so a failed fast path is an error
   * instead of a partial window.
   */
  readonly requiresHelper?: boolean;

  /**
   * True when the provider can attach to the debug type. Providers that need a
   * specific expression evaluator narrow this down (the .NET providers only work
   * with the .NET adapters).
   */
  supportsDebugType(debugType: string): boolean;

  /**
   * Score used when the debug type decides, and the fallback priority of the
   * provider inside its family.
   */
  readonly debugTypePriority: number;

  /** Returns 0 when unsupported, otherwise a confidence score (higher wins). */
  score(context: ProviderMatchContext): number;

  /**
   * Candidate expressions that serialize the collection to JSON. They are
   * tried in order until one succeeds.
   */
  buildSerializeExpression?(source: string, options: HelperOptions): string[];

  /**
   * Expression that loads a helper library into the debuggee once per session.
   */
  buildHelperLoadExpression?(helperPath: string): string | undefined;

  /**
   * Optional sanity check on the payload returned by a serializing expression.
   * Returning `undefined` means "not parseable, try the next candidate".
   */
  parseSerializedPayload?(payload: string): ElementNode[] | undefined;

  /** Builds a filter expression that runs inside the debuggee. */
  buildFilterExpression?(
    source: string,
    filter: FilterEmitInput,
    options: HelperOptions
  ): FilterTranslation | undefined;

  /**
   * Builds an expression that serializes a page into a local file and returns
   * the number of characters written. Adapters truncate method results, so a
   * file is the only transport that carries a whole collection in one request.
   */
  buildNativeFileExpression?(
    source: string,
    start: number,
    count: number,
    path: string
  ): string | undefined;

  /** Builds an expression for a member path of the collection. */
  buildMemberExpression?(source: string, path: readonly string[]): string | undefined;
}

/** Normalizes an editor language id to a canonical language id. */
export function toLanguageId(editorLanguageId: string | undefined): LanguageId | undefined {
  switch (editorLanguageId) {
    case 'csharp':
      return 'csharp';
    case 'fsharp':
      return 'fsharp';
    case 'javascript':
    case 'javascriptreact':
      return 'javascript';
    case 'typescript':
    case 'typescriptreact':
      return 'typescript';
    default:
      return undefined;
  }
}

/** Maps a source file extension to a canonical language id. */
export function languageFromPath(path: string | undefined): LanguageId | undefined {
  if (!path) {
    return undefined;
  }
  const lowered = path.toLowerCase();
  const dot = lowered.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  const extension = lowered.slice(dot);
  switch (extension) {
    case '.cs':
    case '.csx':
      return 'csharp';
    case '.fs':
    case '.fsx':
    case '.fsi':
      return 'fsharp';
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return 'javascript';
    case '.ts':
    case '.mts':
    case '.cts':
    case '.tsx':
      return 'typescript';
    default:
      return undefined;
  }
}

/**
 * Resolves the provider for a debug session. Explicit user configuration wins,
 * then the language of the file the debugger stopped in, then the debug type.
 */
export class LanguageProviderRegistry {
  private readonly providers: LanguageProvider[] = [];

  register(provider: LanguageProvider): void {
    this.providers.push(provider);
  }

  all(): readonly LanguageProvider[] {
    return this.providers;
  }

  byId(id: string): LanguageProvider | undefined {
    return this.providers.find((provider) => provider.id === id);
  }

  byLanguage(language: LanguageId): LanguageProvider | undefined {
    return this.providers.find((provider) => provider.language === language);
  }

  /**
   * Resolves the provider for a session.
   *
   * The debug type identifies the runtime and therefore selects the provider
   * family; within a family the language of the stopped file (then the focused
   * editor) breaks ties. Providers extend their family with `compatibleDebugTypes`
   * when an adapter serves several languages.
   *
   * Only when no provider claims the debug type at all does the file language
   * decide on its own, which keeps brand new adapters usable.
   */
  resolve(context: ProviderMatchContext): LanguageProvider | undefined {
    const override = context.customTypes[context.debugType];
    if (override) {
      const explicit = this.byId(override) ?? this.byLanguage(override as LanguageId);
      if (explicit) {
        return explicit;
      }
    }

    const bestOf = (entries: readonly { provider: LanguageProvider; score: number }[]) =>
      entries.reduce<{ provider: LanguageProvider; score: number } | undefined>(
        (best, entry) => (best === undefined || entry.score > best.score ? entry : best),
        undefined
      );

    const family = this.providers.filter((provider) => provider.supportsDebugType(context.debugType));
    const pool = family.length > 0 ? family : this.providers;
    const best = bestOf(
      pool.map((provider) => ({ provider, score: provider.score(context) })).filter((entry) => entry.score > 0)
    );
    if (best) {
      return best.provider;
    }

    // Nothing matched the file language: fall back to the default provider of the
    // family, so a session is still explorable (the variables walk works with any
    // adapter). An unknown adapter without a family stays unresolved.
    return family.length > 0
      ? bestOf(family.map((provider) => ({ provider, score: provider.debugTypePriority })))?.provider
      : undefined;
  }

  /** Debug types handled by at least one provider, used by the `when` clauses. */
  supportedDebugTypes(): string[] {
    const types = new Set<string>();
    for (const provider of this.providers) {
      for (const type of provider.debugTypes) {
        types.add(type);
      }
    }
    return [...types].sort();
  }
}
