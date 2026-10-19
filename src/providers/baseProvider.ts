import type { ElementNode } from '../model/snapshotBuilder';
import {
  languageFromPath,
  toLanguageId,
  type HelperOptions,
  type LanguageId,
  type LanguageProvider,
  type ProviderMatchContext
} from './languageProvider';

/**
 * Shared scoring logic. Providers only need to declare which debug types and
 * editor languages they own.
 *
 * Resolution order (highest wins):
 *  1. the language of the file the debugger stopped in (200) — authoritative
 *  2. the debug type reported by VS Code (100)
 *  3. the language of the focused editor (150): a tie breaker for shared debug
 *     types shared by C# and F#
 */
export abstract class AbstractLanguageProvider implements LanguageProvider {
  abstract readonly id: string;
  abstract readonly language: LanguageId;
  abstract readonly displayName: string;
  abstract readonly debugTypes: readonly string[];
  abstract readonly editorLanguages: readonly string[];

  readonly adapterHints: readonly string[] = [];
  readonly notes: readonly string[] = [];
  readonly readElementsFromPreviews: boolean = false;
  readonly requiresHelper: boolean = false;

  // Optional hooks redeclared here so that subclasses can mark them `override`.
  buildSerializeExpression?(source: string, options: HelperOptions): string[];
  buildHelperLoadExpression?(helperPath: string): string | undefined;
  parseSerializedPayload?(payload: string): ElementNode[] | undefined;
  buildNativeFileExpression?(
    source: string,
    start: number,
    count: number,
    path: string
  ): string | undefined;
  buildMemberExpression?(source: string, path: readonly string[]): string | undefined;

  /**
   * Score used when the debug type decides. Providers that share a debug type
   * lower or raise this value so ties resolve predictably (C# over F#).
   */
  readonly debugTypePriority: number = 100;

  /**
   * Debug types this provider can also be used with, even though they are not
   * its primary adapters.
   */
  protected readonly compatibleDebugTypes: readonly string[] = [];

  /** Canonical languages this provider accepts, `[language]` by default. */
  protected get handledLanguages(): readonly LanguageId[] {
    return [this.language];
  }

  get languages(): readonly LanguageId[] {
    return this.handledLanguages;
  }

  supportsDebugType(debugType: string): boolean {
    if (this.matchesDebugType(debugType)) {
      return true;
    }
    const normalized = debugType.trim().toLowerCase();
    return this.compatibleDebugTypes.some((candidate) => candidate.toLowerCase() === normalized);
  }

  score(context: ProviderMatchContext): number {
    const handled = this.handledLanguages;

    // 1. When the stopped file is known, only its language can win.
    const stoppedLanguage =
      toLanguageId(context.stoppedLanguageId) ?? languageFromPath(context.sourcePath);
    if (stoppedLanguage) {
      return handled.includes(stoppedLanguage) ? 200 : 0;
    }

    // 2. Otherwise the debug type must be handled by this provider.
    if (!this.matchesDebugType(context.debugType)) {
      return 0;
    }

    // 3. The focused editor breaks ties between providers sharing a debug type.
    const hintLanguage = toLanguageId(context.editorLanguageId);
    if (hintLanguage && handled.includes(hintLanguage)) {
      return 150;
    }

    return this.debugTypePriority;
  }

  /** Case insensitive debug type match, accepting prefixes like `pwa-node`. */
  protected matchesDebugType(debugType: string): boolean {
    const normalized = debugType.trim().toLowerCase();
    if (normalized.length === 0) {
      return false;
    }
    return this.debugTypes.some((candidate) => {
      const expected = candidate.toLowerCase();
      return normalized === expected || normalized.startsWith(`${expected}-`) || normalized.endsWith(`.${expected}`);
    });
  }
}

/** Escapes a string so it can be embedded in a generated expression. */
export function quoteForSource(value: string, quote: '"' | "'" = '"'): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quote, 'g'), `\\${quote}`)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `${quote}${escaped}${quote}`;
}

/** Joins a member path onto a source expression using the given accessor. */
export function joinMemberPath(
  source: string,
  path: readonly string[],
  accessor: (segment: string) => string
): string {
  let result = source;
  for (const segment of path) {
    result += accessor(segment);
  }
  return result;
}
