import * as vscode from 'vscode';

import type { DebugSessionRegistry } from '../debug/sessionRegistry';
import { readSettings } from './config';
import { localize } from './i18n';
import {
  exploreArgumentFor,
  type FrameCollection,
  type FrameCollectionIndex
} from './frameCollections';
import { INLINE_HINT_LANGUAGES } from './inlineValues';
import { findLiteralCollections, type LiteralCollection } from './literalPreview';
import { formatError, type Logger } from '../util/logging';

const MAX_LENSES = 20;

/** Lines that start with these prefixes never declare a live collection. */
const COMMENT_PREFIXES = ['//', '#', '*', '/*', '///', "--", "%"];

/** Where a CodeLens was attached. */
export type LensAnchor = 'declaration' | 'mention' | 'after' | 'scope' | 'stop';

export interface LensPlacement {
  /** Zero based line the lens is attached to. */
  line: number;
  anchor: LensAnchor;
  /** Identifier variant that was found in the document, when any. */
  matchedName?: string;
}

interface DebugLenses {
  lenses: vscode.CodeLens[];
  /** True when the document is the file the debugger stopped in. */
  stoppedHere: boolean;
}

/**
 * Renders an "Explore collection" action above every collection variable that
 * is in scope at the current breakpoint, and a "Preview data" action above the
 * collection literals of a document that is not being debugged.
 *
 * Visual Studio Code has no debug hover extension point, so CodeLens is the one
 * place where an inline, clickable affordance can be attached to the source line
 * the user is looking at. It is the closest equivalent of the `Explore`
 * hyperlink a debugger tooltip can show.
 */
export class CollectionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly literalCache = new Map<
    string,
    { version: number; literals: LiteralCollection[] }
  >();
  private lastNote: string | undefined;
  private provideCount = 0;
  private refreshCount = 0;

  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly sessions: DebugSessionRegistry,
    private readonly collections: FrameCollectionIndex,
    private readonly logger: Logger & { record?: (line: string) => void }
  ) {
    this.disposables.push(
      this.collections.onDidChange(() => this.refresh()),
      this.sessions.onDidChange(() => this.refresh()),
      vscode.debug.onDidChangeActiveStackItem(() => this.refresh())
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }

  /** Forces the editor to ask for the lenses again. */
  refresh(): void {
    this.refreshCount += 1;
    this.logger.debug(`code lens: refresh #${this.refreshCount}`);
    this.emitter.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    this.provideCount += 1;
    const settings = readSettings();
    if (!settings.showCodeLens) {
      this.record('code lens: disabled by settings');
      return [];
    }
    if (!isSupportedDocument(document)) {
      return [];
    }

    const session = this.sessions.activeSession();
    if (session) {
      const debug = await this.debugLenses(document, session, token);
      if (debug.stoppedHere || debug.lenses.length > 0) {
        return debug.lenses;
      }
    }

    if (!settings.showDesignTimePreview || token.isCancellationRequested) {
      return [];
    }
    return this.literalLenses(document);
  }

  /** Lenses for the collections of the stopped frame. */
  private async debugLenses(
    document: vscode.TextDocument,
    session: vscode.DebugSession,
    token: vscode.CancellationToken
  ): Promise<DebugLenses> {
    const empty: DebugLenses = { lenses: [], stoppedHere: false };
    if (token.isCancellationRequested) {
      this.record('code lens: the editor cancelled the request');
      return empty;
    }

    try {
      const context = await this.sessions.resolve(session);
      if (!context || context.frameId === undefined) {
        this.record(`code lens: no stopped frame in session ${session.id}`);
        return empty;
      }
      if (!sameDocument(document, context.sourcePath)) {
        this.record(
          `code lens: ${document.uri.fsPath} is not the stopped file (${context.sourcePath ?? 'unknown'})`
        );
        return empty;
      }
      const stopped: DebugLenses = { lenses: [], stoppedHere: true };
      if (token.isCancellationRequested) {
        this.record('code lens: the editor cancelled the request while resolving the frame');
        return stopped;
      }

      const stoppedLine = lineOf(document, context.frameLine);
      const collections = await this.collections.forFrame(session, context.frameId, token);
      if (collections.length === 0) {
        this.record(`code lens: provide #${this.provideCount} -> no collections in the frame`);
        return stopped;
      }
      this.record(
        `code lens: provide #${this.provideCount} on ${document.uri.fsPath} ` +
          `(${document.lineCount} lines, stop line ${stoppedLine + 1}) -> ` +
          collections.map((entry) => entry.name).join(', ')
      );

      const lines = document.getText().split('\n');
      const placements: string[] = [];
      for (const entry of collections.slice(0, MAX_LENSES)) {
        const placement = resolveOwnerLine(lines, identifierVariants(entry), stoppedLine);
        placements.push(
          `${entry.name}@${placement.line + 1}(${placement.anchor}${
            placement.matchedName && placement.matchedName !== entry.name
              ? `:${placement.matchedName}`
              : ''
          })`
        );
        stopped.lenses.push(
          new vscode.CodeLens(new vscode.Range(placement.line, 0, placement.line, 0), {
            command: 'exploringCollections.explore',
            title: lensTitle(entry),
            tooltip: localize(
              'Opens {0} in the collection viewer ({1}).',
              entry.name,
              entry.typeName ?? entry.classification
            ),
            arguments: [exploreArgumentFor(session.id, entry)]
          })
        );
      }
      this.record(`code lens: placed at ${placements.join(', ')}`);
      return stopped;
    } catch (error) {
      this.record(`code lens failed: ${formatError(error)}`);
      this.logger.debug(`code lens lookup failed: ${formatError(error)}`);
      return empty;
    }
  }

  /** Lenses for the source literals of a document that is not being debugged. */
  private literalLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const literals = this.literalsOf(document);
    if (literals.length === 0) {
      return [];
    }
    this.record(
      `code lens: ${literals.length} source literal(s) on ${document.uri.fsPath}: ` +
        literals.map((literal) => `${literal.name ?? '?'}@${literal.line + 1}`).join(', ')
    );
    return literals.slice(0, MAX_LENSES).map((literal) => {
      const rows = literal.rows.length.toLocaleString();
      return new vscode.CodeLens(new vscode.Range(literal.line, 0, literal.line, 0), {
        command: 'exploringCollections.previewLiteral',
        title:
          `$(table) ${localize('Preview data')} · ` +
          `${literal.name ?? localize('collection')} · ${rows}`,
        tooltip: localize(
          'Shows the data the source declares on line {0}, without starting a debug session.',
          literal.line + 1
        ),
        arguments: [{ uri: document.uri.toString(), line: literal.line }]
      });
    });
  }

  /** Literals of a document, parsed once per document version. */
  literalsOf(document: vscode.TextDocument): LiteralCollection[] {
    const key = document.uri.toString();
    const cached = this.literalCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.literals;
    }
    const literals = findLiteralCollections(document.getText(), document.languageId);
    if (this.literalCache.size > 16) {
      this.literalCache.clear();
    }
    this.literalCache.set(key, { version: document.version, literals });
    return literals;
  }

  /** Notes a decision in the diagnostics report, but only when it changes. */
  private record(line: string): void {
    if (this.lastNote === line) {
      return;
    }
    this.lastNote = line;
    this.logger.record?.(line);
  }
}

function lensTitle(entry: FrameCollection): string {
  const size = entry.elementCount > 0 ? ` · ${entry.elementCount.toLocaleString()}` : '';
  return `$(search) ${localize('Explore collection')} · ${entry.name}${size}`;
}

/** Documents that can host the lenses. */
function isSupportedDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' || document.uri.scheme === 'debug';
}

/** True when the open document is the file the debugger stopped in. */
export function sameDocument(document: vscode.TextDocument, sourcePath: string | undefined): boolean {
  if (!sourcePath) {
    return false;
  }
  const left = document.uri.fsPath || document.uri.path;
  const right = sourcePath.replace(/\\/g, '/');
  return left.replace(/\\/g, '/').endsWith(right) || right.endsWith(left.replace(/\\/g, '/'));
}

/**
 * Zero based line for the one based line the adapter reported, clamped to the
 * document so a stale frame can never produce an out of range lens.
 */
export function lineOf(document: vscode.TextDocument, frameLine: number | undefined): number {
  if (frameLine === undefined || frameLine <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, frameLine - 1), Math.max(0, document.lineCount - 1));
}

/**
 * Finds the line a collection identifier belongs to.
 *
 * The lens belongs above the line that introduced the collection, not above the
 * breakpoint, so a declaration or assignment wins over a plain mention. A name
 * that is only ever read (a field, a parameter of another function) falls back to
 * its first mention before the breakpoint, and a name that does not occur in the
 * document at all falls back to the stopped line.
 */
export function findOwnerLine(
  lines: readonly string[],
  name: string,
  stoppedLine: number
): number {
  return locateIdentifier(lines, name, stoppedLine)?.line ?? stoppedLine;
}

/** Result of looking for one identifier in a document. */
interface Located {
  line: number;
  anchor: 'declaration' | 'mention' | 'after';
}

/** Line of the identifier, together with the reason it was chosen. */
export function locateIdentifier(
  lines: readonly string[],
  name: string,
  stoppedLine: number
): Located | undefined {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(name)}([^A-Za-z0-9_$]|$)`);
  let declaredBefore: number | undefined;
  let declaredAfter: number | undefined;
  let mentionedBefore: number | undefined;
  let mentionedAfter: number | undefined;

  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line] ?? '';
    if (!pattern.test(text) || isComment(text)) {
      continue;
    }
    if (line <= stoppedLine) {
      mentionedBefore ??= line;
      if (declaredBefore === undefined && isDeclaration(text, name)) {
        declaredBefore = line;
        // The first declaration above the breakpoint is the one that introduced
        // the value, so nothing later can be better.
        break;
      }
    } else {
      mentionedAfter ??= line;
      declaredAfter ??= isDeclaration(text, name) ? line : undefined;
    }
  }

  if (declaredBefore !== undefined) {
    return { line: declaredBefore, anchor: 'declaration' };
  }
  if (mentionedBefore !== undefined) {
    return { line: mentionedBefore, anchor: 'mention' };
  }
  if (declaredAfter !== undefined) {
    return { line: declaredAfter, anchor: 'after' };
  }
  if (mentionedAfter !== undefined) {
    return { line: mentionedAfter, anchor: 'after' };
  }
  return undefined;
}

/**
 * Identifier spellings worth looking for in the source.
 *
 * Debug adapters report the name they use internally (`this._items`,
 * `response.Body.Items`, `items[0]`), which is often not what the source says.
 * The full expression is tried first, then the shortest tail of it.
 */
export function identifierVariants(entry: FrameCollection): string[] {
  const variants: string[] = [];
  const push = (raw: string | undefined): void => {
    const value = raw?.trim().replace(/^[&*]+/, '');
    if (
      value &&
      /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value) &&
      !variants.includes(value)
    ) {
      variants.push(value);
    }
  };

  push(entry.expression);
  push(entry.name);
  for (const source of [entry.expression, entry.name]) {
    if (!source) {
      continue;
    }
    const cleaned = source.replace(/->/g, '.').replace(/\[[^\]]*\]/g, '');
    const segments = cleaned.split(/[.>:]+/).filter((segment) => segment.length > 0);
    if (segments.length > 1) {
      push(segments.slice(1).join('.'));
    }
    push(segments[segments.length - 1]);
  }
  return variants;
}

/**
 * Line a lens for a frame collection belongs to.
 *
 * When none of the identifier variants occurs in the document, the identifier
 * comes from somewhere else (a field, a parameter, a generated member). Stacking
 * every lens on the breakpoint would be useless, so they are attached to the
 * line that opens the enclosing scope instead.
 */
export function resolveOwnerLine(
  lines: readonly string[],
  names: readonly string[],
  stoppedLine: number
): LensPlacement {
  let best: { placement: Located; rank: number; name: string } | undefined;
  names.forEach((name, index) => {
    const placement = locateIdentifier(lines, name, stoppedLine);
    if (!placement) {
      return;
    }
    const rank =
      (placement.anchor === 'declaration' ? 0 : placement.anchor === 'mention' ? 1 : 2) * 10 + index;
    if (!best || rank < best.rank) {
      best = { placement, rank, name };
    }
  });

  if (best) {
    return { line: best.placement.line, anchor: best.placement.anchor, matchedName: best.name };
  }
  const scope = enclosingScopeLine(lines, stoppedLine);
  return { line: scope, anchor: scope === stoppedLine ? 'stop' : 'scope' };
}

/** Lines that open a scope but are not the scope the user is working in. */
const CONTROL_FLOW =
  /^(?:if|else|for|foreach|while|do|switch|case|catch|try|finally|match|with|using|lock|elif|when)\b/;

/**
 * Line of the declaration that encloses the stopped line.
 *
 * Walking up from the stop line finds the innermost function, method or type
 * signature, which is a far better place for a lens than the breakpoint itself.
 */
export function enclosingScopeLine(lines: readonly string[], stoppedLine: number): number {
  const lowerBound = Math.max(0, stoppedLine - 400);
  let fallback: number | undefined;
  for (let line = stoppedLine; line >= lowerBound; line -= 1) {
    const text = lines[line] ?? '';
    const trimmed = text.trim();
    if (trimmed.length === 0 || isComment(text)) {
      continue;
    }
    if (/^[)}\];]+/.test(trimmed) || trimmed === '{') {
      // A line that only closes or opens a block is not a signature.
      continue;
    }
    const opensScope =
      /[{:]\s*(?:\/\/.*)?$/.test(trimmed) ||
      /\)\s*(?:\/\/.*)?$/.test(trimmed) ||
      /=>\s*$/.test(trimmed) ||
      /\b(?:function|def|fn|func|class|struct|impl|method|procedure|sub|namespace)\b/.test(trimmed);
    if (!opensScope) {
      continue;
    }
    if (CONTROL_FLOW.test(trimmed)) {
      fallback ??= line;
      continue;
    }
    return line;
  }
  return fallback ?? stoppedLine;
}

/** True when the line declares, assigns or receives the identifier. */
export function isDeclaration(text: string, name: string): boolean {
  const match = new RegExp(`(^|[^A-Za-z0-9_$])(${escapeRegExp(name)})(?![A-Za-z0-9_$])`).exec(text);
  if (!match) {
    return false;
  }
  const start = (match.index ?? 0) + (match[1]?.length ?? 0);
  const before = text.slice(0, start);
  const after = text.slice(start + name.length);

  // `name = …`, `name: Type = …`, `name := …`, `name <- …`
  if (/^\s*(?:\[[^\]]*\])?\s*(?::[^=]*)?(?:=|:=|<-)/.test(after)) {
    return true;
  }
  // A declaration keyword in front of the name, e.g. `var name`, `let name`.
  if (
    /\b(?:var|let|const|val|final|readonly|mutable|auto|static|public|private|protected|internal|def|function|fn|func|local|dim)\b[^;=()]*$/.test(
      before
    )
  ) {
    return true;
  }
  // A parameter in a signature, e.g. `void Foo(List<int> name)` or `def foo(name):`.
  if (/\([^)]*$/.test(before) && /^\s*(?:,[^)]*)?\)\s*(?:\{|:|=>|$)/.test(after)) {
    return true;
  }
  return false;
}

function isComment(text: string): boolean {
  const trimmed = text.trimStart();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Languages whose documents the provider is registered for. */
export const CODE_LENS_LANGUAGES = INLINE_HINT_LANGUAGES;
