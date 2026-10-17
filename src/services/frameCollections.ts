import * as vscode from 'vscode';

import type { AdapterVariable } from '../model/types';
import { classifyAdapterVariable, normalizeTypeName } from '../model/valueKind';
import { declaredCountOf } from '../providers/variablesWalk';
import type { DebugSessionRegistry } from '../debug/sessionRegistry';
import { readSettings } from './config';
import { formatError, type Logger } from '../util/logging';

/** A collection variable that is currently in scope in the stopped frame. */
export interface FrameCollection {
  name: string;
  /** Expression that evaluates to the collection in the frame. */
  expression: string;
  typeName?: string;
  /** Adapter preview, e.g. `Array(14)` or `List<Temperature>`. */
  preview: string;
  variablesReference: number;
  elementCount: number;
  classification: 'sequence' | 'map';
}

const CACHE_TTL_MS = 2000;
const MAX_COLLECTIONS = 32;

/**
 * Discovers the collections of the stopped frame.
 *
 * Every debug aware feature (inline hint, CodeLens, hover, the snapshot tree)
 * needs the same list, so it is computed once per frame and cached briefly: the
 * lookup costs two debug adapter round trips (`scopes` plus `variables`).
 */
export class FrameCollectionIndex implements vscode.Disposable {
  private readonly cache = new Map<string, { entries: FrameCollection[]; expires: number }>();
  private lastNote: string | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Fires whenever the cached list is no longer valid. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly sessions: DebugSessionRegistry,
    private readonly logger: Logger & { record?: (line: string) => void }
  ) {}

  /**
   * Notes a decision in the diagnostics report, but only when it changes: the
   * lookup runs on every edit of a file that has a breakpoint, and a report full
   * of identical lines would hide the interesting ones.
   */
  private note(line: string): void {
    if (this.lastNote === line) {
      return;
    }
    this.lastNote = line;
    this.logger.record?.(`collection lookup: ${line}`);
  }

  /** Collections of `frameId`, or an empty list when the frame has none. */
  async forFrame(
    session: vscode.DebugSession,
    frameId: number | undefined,
    token?: vscode.CancellationToken
  ): Promise<FrameCollection[]> {
    if (frameId === undefined || token?.isCancellationRequested) {
      this.note(`no stopped frame in session ${session.id}`);
      return [];
    }

    const cacheKey = `${session.id}:${frameId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.entries;
    }

    const entries = await this.discover(session, frameId, token);
    this.note(
      entries.length === 0
        ? `frame ${frameId} of ${session.name} has no collections`
        : `frame ${frameId} of ${session.name}: ${entries.map((entry) => entry.name).join(', ')}`
    );
    this.cache.set(cacheKey, { entries, expires: Date.now() + CACHE_TTL_MS });
    if (this.cache.size > 32) {
      const oldest = [...this.cache.entries()].sort((left, right) => left[1].expires - right[1].expires)[0];
      if (oldest) {
        this.cache.delete(oldest[0]);
      }
    }
    return entries;
  }

  /** Collections of the frame the debugger is currently stopped in. */
  async forActiveFrame(token?: vscode.CancellationToken): Promise<FrameCollection[]> {
    const session = this.sessions.activeSession();
    if (!session) {
      this.note('no active debug session');
      return [];
    }
    const context = await this.sessions.resolve(session);
    return this.forFrame(session, context?.frameId, token);
  }

  /** Drops the cached lists; call it when the debugger stops or resumes. */
  invalidate(): void {
    this.cache.clear();
    this.emitter.fire();
  }

  dispose(): void {
    this.cache.clear();
    this.emitter.dispose();
  }

  private async discover(
    session: vscode.DebugSession,
    frameId: number,
    token?: vscode.CancellationToken
  ): Promise<FrameCollection[]> {
    const settings = readSettings();
    const dapOptions = { timeoutMs: Math.min(settings.timeoutMs, 5000), token };
    try {
      const client = this.sessions.clientFor(session);
      const scopes = await client.scopes(frameId, dapOptions);
      // Locals first: that is what the user is looking at.
      const ordered = [...scopes].sort((left, right) => Number(left.expensive) - Number(right.expensive));
      const entries: FrameCollection[] = [];
      const seen = new Set<string>();

      for (const scope of ordered) {
        if (entries.length >= MAX_COLLECTIONS || token?.isCancellationRequested) {
          break;
        }
        const variables = await client.variables({ reference: scope.variablesReference }, dapOptions);
        for (const variable of variables) {
          const entry = toFrameCollection(variable);
          if (!entry || seen.has(entry.expression)) {
            continue;
          }
          seen.add(entry.expression);
          entries.push(entry);
          if (entries.length >= MAX_COLLECTIONS) {
            break;
          }
        }
      }
      return entries;
    } catch (error) {
      this.note(`lookup failed for ${session.id}: ${formatError(error)}`);
      this.logger.debug(`collection lookup for ${session.id} failed: ${formatError(error)}`);
      return [];
    }
  }
}

/**
 * Converts an adapter variable into a collection candidate, when it is one.
 *
 * Adapters differ a lot here: some report `indexedVariables`/`namedVariables`,
 * some (js-debug for example) only describe the value, e.g. `(12) [{…}, …]` or
 * `{cityCount: 3}`. Both shapes must be recognised, otherwise a whole language
 * silently loses its Explore affordances.
 */
export function toFrameCollection(variable: AdapterVariable): FrameCollection | undefined {
  if (variable.variablesReference <= 0) {
    return undefined;
  }

  let classification = classifyAdapterVariable(variable);
  if (classification === 'leaf' && looksLikeRecord(variable)) {
    classification = 'map';
  }
  if (classification !== 'sequence' && classification !== 'map') {
    return undefined;
  }

  const elementCount = countOf(variable);
  if (elementCount !== undefined && elementCount < 2) {
    return undefined;
  }

  const expression = variable.evaluateName ?? variable.name;
  if (!expression) {
    return undefined;
  }
  return {
    name: variable.name,
    expression,
    typeName: variable.type,
    preview: variable.value,
    variablesReference: variable.variablesReference,
    elementCount: elementCount ?? 0,
    classification
  };
}

/** Object shaped values that the classifier cannot name, e.g. `{a: 1, b: 2}`. */
function looksLikeRecord(variable: AdapterVariable): boolean {
  const normalized = normalizeTypeName(variable.type);
  const objectLike =
    normalized === 'object' ||
    normalized === 'map' ||
    normalized === 'dictionary' ||
    normalized === 'record' ||
    normalized === 'unknown';
  if (!objectLike) {
    return false;
  }
  const value = variable.value.trim();
  return (value.startsWith('{') && value.endsWith('}')) || value === '{…}';
}

/**
 * Element count of a collection: the adapter's own counters first, then the
 * count that many adapters embed in the preview text (`(12) […]`, `12 items`).
 * `undefined` means the adapter did not tell us, which is not an error.
 */
function countOf(variable: AdapterVariable): number | undefined {
  return declaredCountOf(variable);
}

/** Argument handed to the explore command from CodeLens, hover and the tree. */
export function exploreArgumentFor(
  sessionId: string,
  entry: FrameCollection
): { sessionId: string; variable: Partial<AdapterVariable> } {
  return {
    sessionId,
    variable: {
      name: entry.name,
      value: entry.preview,
      type: entry.typeName,
      variablesReference: entry.variablesReference,
      evaluateName: entry.expression
    }
  };
}

/** Command URI that runs the explore command from markdown (hover, tooltips). */
export function exploreCommandUri(sessionId: string, entry: FrameCollection): string {
  const args = encodeURIComponent(JSON.stringify([exploreArgumentFor(sessionId, entry)]));
  return `command:exploringCollections.explore?${args}`;
}
