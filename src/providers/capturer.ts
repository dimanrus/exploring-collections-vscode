import type {
  AdapterVariable,
  CaptureOptions,
  CollectionSnapshot,
  ColumnDescriptor,
  FilterResult,
  RetrievalStrategy,
  RowDescriptor
} from '../model/types';
import type { FormatOptions } from '../model/formatter';
import { analyzeAdapterText, parseAdapterPrimitive } from '../model/formatter';
import { buildSnapshot, rowsFromElements, withRows, type ElementNode } from '../model/snapshotBuilder';
import { applyFilter, unresolvedIdentifiers } from '../filter/evaluator';
import { collectFreeIdentifiers, formatExpression, parseFilter, type ParsedFilter } from '../filter/expression';
import { isCutPayload, totalFromPayload } from './jsonPayload';
import {
  RequestBudget,
  declaredCountOf,
  previewsDescribeElements,
  walkVariables,
  type WalkRoot
} from './variablesWalk';
import type { HelperOptions, LanguageProvider } from './languageProvider';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DapClient } from '../debug/dapClient';
import { formatError, type Logger } from '../util/logging';
import { INDEX_COLUMN_KEY } from '../util/types';

/** State of the native helper inside one debug session. */
export interface SessionHelperState {
  attempted: boolean;
  loaded: boolean;
  failureReason?: string;
}

export interface CaptureLayout {
  columnOrder: 'alphabetical' | 'discovery';
  flattenDepth: number;
}

export interface CaptureRequest {
  client: DapClient;
  provider: LanguageProvider;
  session: { id: string; name: string; debugType: string };
  title: string;
  /** Expression that designates the collection in the frame. */
  source: string;
  root: WalkRoot;
  frameId?: number;
  options: CaptureOptions;
  formatOptions: FormatOptions;
  layout: CaptureLayout;
  helperOptions: HelperOptions;
  helperState: SessionHelperState;
  logger: Logger;
  /** Upper bound of DAP round trips allowed for the variables walk. */
  requestBudget?: number;
  /** Rows materialized so far, so a long capture can report progress. */
  onProgress?: (rows: number, total: number) => void;
}

/** Relative path of the bundled native helper for a provider. */
export function helperRelativePath(providerId: string): string {
  switch (providerId) {
    case 'csharp':
    case 'fsharp':
      return 'dotnet/dist/ExploringCollections.Helper.dll';
    default:
      return '';
  }
}

/**
 * Captures a collection into an immutable snapshot.
 *
 * Strategy order:
 *  1. native helper compiled into the debuggee (fastest, richest types)
 *  2. serialization expression evaluated by the adapter (JSON round trip)
 *  3. universal `variables` walk (works with every adapter)
 */
interface FastCapture {
  strategy: RetrievalStrategy;
  elements: ElementNode[];
  total: number | null;
  source: string;
  truncated?: boolean;
}

/** Mutable facts the fast path discovers and the fallback walk can reuse. */
interface FastState {
  previewsUsable: boolean;
}

export async function captureCollection(request: CaptureRequest): Promise<CollectionSnapshot> {
  const started = Date.now();
  const { client, provider, options, logger } = request;
  const dapOptions = { timeoutMs: options.timeoutMs, token: options.token };
  const warnings: string[] = [];
  const fallbackReasons: string[] = [];
  const notes = [...provider.notes];
  client.resetCounters();

  const expression = request.root.evaluateName ?? request.source;
  const budget = new RequestBudget(request.requestBudget ?? 20000);
  const state: FastState = { previewsUsable: false };

  // Two steps only: one fast path selected by the language provider, then the
  // universal variables walk. Languages without a usable slow fallback throw
  // instead of walking element by element.
  const fast = await captureFast(request, budget, dapOptions, state, fallbackReasons);
  if (fast) {
    return finish(fast.strategy, fast.elements, fast.total, fast.source, fast.truncated);
  }
  if (provider.requiresHelper) {
    const reason = fallbackReasons.length > 0 ? fallbackReasons.join('; ') : 'the helper is unavailable';
    throw new Error(
      `The ${provider.displayName} fast path could not read '${expression}': ${reason}. ` +
        'Check that the bundled helper is present and that the debuggee can write to the system temp folder.'
    );
  }

  const walk = await walkVariables(request.root, {
    client,
    options,
    formatOptions: request.formatOptions,
    budget,
    logger,
    onProgress: request.onProgress,
    // A mixed collection keeps the elements that do parse cheap on this pass.
    expandPreviews: state.previewsUsable
  });

  warnings.push(...walk.warnings.filter((warning) => !warnings.includes(warning)));
  if (walk.budgetExhausted) {
    warnings.push(
      `The capture stopped after ${budget.consumed.toLocaleString()} debugger requests; increase exploringCollections.maxRows or narrow the collection.`
    );
  }
  if (fallbackReasons.length > 0) {
    warnings.push('The fast path was unavailable, so the collection was enumerated through the debugger variables tree.');
  }
  return finish('variables-walk', walk.elements, walk.totalItems, 'the variables tree', walk.truncated);

  function finish(
    strategyName: RetrievalStrategy,
    captured: ElementNode[],
    total: number | null,
    source: string,
    knownTruncated?: boolean
  ): CollectionSnapshot {
    const isTruncated =
      knownTruncated ?? (total !== null && total > captured.length);
    if (isTruncated && total !== null && knownTruncated === undefined) {
      warnings.push(
        `The collection holds ${total.toLocaleString()} elements; ${source} returned the first ${captured.length.toLocaleString()}. ` +
          'Increase exploringCollections.maxRows to read more.'
      );
    }
    return buildSnapshot({
      id: createSnapshotId(request.session.id, expression),
      title: request.title,
      expression,
      sessionId: request.session.id,
      sessionName: request.session.name,
      debugType: request.session.debugType,
      language: provider.language,
      providerId: provider.id,
      elements: captured,
      totalItems: total,
      truncated: isTruncated,
      warnings,
      diagnostics: {
        strategy: strategyName,
        durationMs: Date.now() - started,
        requests: client.requests,
        reportedItemCount: total,
        fallbackReasons,
        notes
      },
      formatOptions: request.formatOptions,
      columnOrder: request.layout.columnOrder,
      flattenDepth: request.layout.flattenDepth
    });
  }
}

/** Above this declared size the JS adapter previews are read in bulk. */
const PREVIEW_FIRST_ELEMENTS = 50;
/** Time floor for the preview based walk, which makes no per element request. */
const PREVIEW_WALK_BUDGET_MS = 60000;

/**
 * The single fast path. It returns rows when the language provider can read the
 * collection in bulk, and `undefined` when only the variables walk is left.
 *
 * JavaScript/TypeScript: the adapter previews carry complete object members, so
 * one `variables` response materializes the whole collection.
 * C#/F#: the bundled helper or the provider's range expression serializes a
 * page (or the whole collection when it is small).
 */
async function captureFast(
  request: CaptureRequest,
  budget: RequestBudget,
  dapOptions: { timeoutMs: number; token?: { isCancellationRequested: boolean } },
  state: FastState,
  fallbackReasons: string[]
): Promise<FastCapture | undefined> {
  if (request.provider.readElementsFromPreviews) {
    return captureFromPreviews(request, budget, dapOptions, state, fallbackReasons);
  }

  // C#/F# have exactly one fast read: the helper writes the page to a file.
  const helperLoaded = await loadHelper(request, dapOptions, fallbackReasons);
  if (!helperLoaded || !request.provider.buildNativeFileExpression) {
    return undefined;
  }
  return captureFile(request, budget, dapOptions, fallbackReasons);
}

/** Reads a JS/TS collection from the adapter previews. */
async function captureFromPreviews(
  request: CaptureRequest,
  budget: RequestBudget,
  dapOptions: { timeoutMs: number; token?: { isCancellationRequested: boolean } },
  state: FastState,
  fallbackReasons: string[]
): Promise<FastCapture | undefined> {
  const { client, options, logger } = request;
  const declared = request.root.childCount ?? null;

  if (declared !== null && declared > PREVIEW_FIRST_ELEMENTS) {
    const probe = await previewsDescribeElements(request.root, {
      client,
      options,
      formatOptions: request.formatOptions,
      budget,
      logger
    });
    state.previewsUsable = probe.usable;
    if (probe.usable) {
      // Some adapters answer the probe with the whole child list; the walk can
      // reuse it instead of transferring the same payload twice.
      const covered = Math.min(options.maxRows, declared);
      const prefetchedChildren = probe.children.length >= covered ? probe.children : undefined;
      const previewWalk = await walkVariables(request.root, {
        client,
        // Building rows from previews costs no debugger requests, so the walk
        // budget (meant for one request per element) must not cut it.
        options: { ...options, captureBudgetMs: Math.max(options.captureBudgetMs, PREVIEW_WALK_BUDGET_MS) },
        formatOptions: request.formatOptions,
        budget,
        logger,
        onProgress: request.onProgress,
        expandPreviews: true,
        prefetchedChildren
      });
      if (previewWalk.elements.length > 0 && previewWalk.previewRows === previewWalk.elements.length) {
        return {
          strategy: 'adapter-previews',
          elements: previewWalk.elements,
          total: previewWalk.totalItems,
          source: 'the adapter previews',
          truncated: previewWalk.truncated
        };
      }
      fallbackReasons.push('the adapter previews did not describe every element');
    }
  }

  if (declared === null || declared <= PREVIEW_FIRST_ELEMENTS) {
    return captureWhole(request, dapOptions, fallbackReasons);
  }
  return undefined;
}

/** Loads the helper assembly once per session. */
async function loadHelper(
  request: CaptureRequest,
  dapOptions: { timeoutMs: number; token?: { isCancellationRequested: boolean } },
  fallbackReasons: string[]
): Promise<boolean> {
  if (request.helperState.attempted) {
    return request.helperState.loaded;
  }
  const helperPath = request.helperOptions.helperPath?.(helperRelativePath(request.provider.id));
  const loadExpression = helperPath
    ? request.provider.buildHelperLoadExpression?.(helperPath)
    : undefined;
  if (loadExpression === undefined) {
    return false;
  }
  request.helperState.attempted = true;
  const outcome = await request.client.tryEvaluate(loadExpression, request.frameId, 'watch', dapOptions);
  request.helperState.loaded = outcome.ok;
  if (!outcome.ok) {
    request.helperState.failureReason = formatError(outcome.error);
    fallbackReasons.push(`helper load failed: ${request.helperState.failureReason}`);
    request.logger.debug(`helper load failed for ${request.provider.id}: ${request.helperState.failureReason}`);
    return false;
  }
  request.logger.info(`helper loaded for ${request.provider.id}`);
  return true;
}

/**
 * Reads the collection through the bundled helper, which serializes a page into
 * a temporary file. A method result is capped by the adapter (vsdbg cuts it at
 * about 1,000 characters) and even the chunks of a string array inherit that
 * limit, so the file is the only transport that carries the whole page in one
 * request. The file is removed right after it is read.
 */
async function captureFile(
  request: CaptureRequest,
  budget: RequestBudget,
  dapOptions: { timeoutMs: number; token?: { isCancellationRequested: boolean } },
  fallbackReasons: string[]
): Promise<FastCapture | undefined> {
  const { client, provider, options } = request;
  if (!provider.buildNativeFileExpression || !provider.parseSerializedPayload) {
    return undefined;
  }
  const expression = request.root.evaluateName ?? request.source;
  const declared = request.root.childCount ?? null;
  const count = Math.max(1, Math.min(options.maxRows, declared ?? options.maxRows));
  const path = join(tmpdir(), `exploring-collections-${randomUUID()}.json`);
  const writeExpression = provider.buildNativeFileExpression(expression, 0, count, path);
  if (!writeExpression) {
    return undefined;
  }

  try {
    if (!budget.consume()) {
      return undefined;
    }
    const outcome = await client.tryEvaluate(writeExpression, request.frameId, 'watch', dapOptions);
    if (!outcome.ok) {
      fallbackReasons.push(`helper file write failed: ${formatError(outcome.error)}`);
      return undefined;
    }
    const payload = await readFile(path, 'utf8');
    const elements = provider.parseSerializedPayload(payload);
    if (!elements) {
      fallbackReasons.push('the helper file did not contain a supported collection envelope');
      return undefined;
    }
    const total = totalFromPayload(payload);
    request.onProgress?.(elements.length, total ?? elements.length);
    return { strategy: 'helper-native', elements, total, source: 'the helper' };
  } catch (error) {
    fallbackReasons.push(`helper file could not be read: ${formatError(error)}`);
    return undefined;
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * Serializes a small JavaScript/TypeScript collection in one expression. Only
 * used below the preview threshold, where the payload fits the adapter limit.
 */
async function captureWhole(
  request: CaptureRequest,
  dapOptions: { timeoutMs: number; token?: { isCancellationRequested: boolean } },
  fallbackReasons: string[]
): Promise<FastCapture | undefined> {
  const { client, provider, helperOptions } = request;
  const expression = request.root.evaluateName ?? request.source;
  if (!provider.buildSerializeExpression) {
    return undefined;
  }

  for (const candidate of provider.buildSerializeExpression(expression, helperOptions)) {
    const outcome = await client.tryEvaluate(candidate, request.frameId, 'watch', dapOptions);
    if (!outcome.ok) {
      fallbackReasons.push(`serializer failed (${summarize(candidate)}): ${formatError(outcome.error)}`);
      continue;
    }
    if (isCutPayload(outcome.value.result)) {
      fallbackReasons.push(
        `the debug adapter cut the payload of ${summarize(candidate)} (${outcome.value.result.length.toLocaleString()} characters)`
      );
      continue;
    }
    const elements = provider.parseSerializedPayload?.(outcome.value.result);
    if (elements) {
      return {
        strategy: 'helper-json',
        elements,
        total: totalFromPayload(outcome.value.result),
        source: 'the Inline serializer'
      };
    }
    fallbackReasons.push(`payload of ${summarize(candidate)} was not parseable as JSON`);
  }

  return undefined;
}

function summarize(expression: string): string {
  const collapsed = expression.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}...` : collapsed;
}

function createSnapshotId(sessionId: string, expression: string): string {
  let hash = 0;
  const seed = `${sessionId}:${expression}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return `snap-${Math.abs(hash).toString(36)}`;
}

export interface FilterRequest {
  client: DapClient;
  provider: LanguageProvider;
  snapshot: CollectionSnapshot;
  filterText: string;
  frameId?: number;
  options: CaptureOptions;
  formatOptions: FormatOptions;
  helperOptions: HelperOptions;
  helperState: SessionHelperState;
  enablePushdown: boolean;
  layout: CaptureLayout;
  logger: Logger;
}

export interface FilterOutcome {
  snapshot: CollectionSnapshot;
  result: FilterResult;
}

/**
 * Applies a filter to a snapshot.
 *
 * The filter always runs on the client so the behaviour is identical in every
 * language. When the collection is larger than the fetched window and the
 * provider can translate the filter exactly, the filter is additionally pushed
 * down to the debugger so that matching elements outside the window are found.
 */
export async function filterCollection(request: FilterRequest): Promise<FilterOutcome> {
  const { snapshot, provider, options, helperOptions } = request;
  if (request.filterText.trim().length === 0) {
    return {
      snapshot,
      result: { rows: snapshot.rows, executed: '', location: 'client', warnings: [] }
    };
  }
  const parsed = parseFilter(request.filterText);
  const dapOptions = { timeoutMs: options.timeoutMs, token: options.token };

  const locals = await resolveLocals(request, parsed);
  const localRows = applyFilter(parsed, snapshot.rows, snapshot.columns, locals);

  const fetchedAll = snapshot.totalItems === null || snapshot.totalItems <= snapshot.rows.length;
  const warnings: string[] = [];
  let executed = formatExpression(parsed.expression, parsed.parameter ?? 'x');
  let location: FilterResult['location'] = 'client';
  let rows: RowDescriptor[] = localRows;

  const canPushDown =
    request.enablePushdown &&
    !fetchedAll &&
    provider.buildFilterExpression !== undefined &&
    provider.parseSerializedPayload !== undefined;

  if (canPushDown) {
    const translation = provider.buildFilterExpression?.(
      snapshot.expression,
      {
        body: parsed.expression.kind === 'lambda' ? parsed.expression.body : parsed.expression,
        parameter: parsed.parameter ?? 'x',
        canonical: executed
      },
      helperOptions
    );

    if (!translation) {
      warnings.push('This provider cannot push filters down; only the fetched rows were filtered.');
    } else if (!translation.exact) {
      warnings.push(
        `The filter could not be translated exactly for ${provider.displayName} (${translation.notes.join('; ') || 'unsupported construct'}); only the fetched rows were filtered.`
      );
    } else {
      const outcome = await request.client.tryEvaluate(
        translation.expression,
        request.frameId,
        'watch',
        dapOptions
      );
      if (!outcome.ok) {
        warnings.push(`Pushdown failed: ${formatError(outcome.error)}. Only the fetched rows were filtered.`);
      } else {
        const elements = provider.parseSerializedPayload?.(outcome.value.result);
        if (!elements) {
          warnings.push('Pushdown returned a payload that could not be parsed; only the fetched rows were filtered.');
        } else {
          const pushedRows = rowsFromElements(
            elements,
            snapshot.columns,
            request.formatOptions,
            request.layout.flattenDepth
          );
          // Re-apply the filter locally as a safety net against over-inclusion.
          rows = applyFilter(parsed, pushedRows, snapshot.columns, locals);
          executed = translation.expression;
          location = 'debugger';
          warnings.push(...translation.notes);
        }
      }
    }
  } else if (!fetchedAll) {
    warnings.push(
      'The collection is larger than the fetched window, so only the fetched rows could be filtered.'
    );
  }

  return {
    snapshot: withRows(snapshot, rows),
    result: {
      rows,
      executed,
      location,
      warnings
    }
  };
}

/** Evaluates free identifiers of the filter in the debugger, when possible. */
async function resolveLocals(
  request: FilterRequest,
  parsed: ParsedFilter
): Promise<Map<string, unknown>> {
  const locals = new Map<string, unknown>();
  if (request.frameId === undefined) {
    return locals;
  }
  const candidates = unresolvedIdentifiers(
    collectFreeIdentifiers(parsed),
    request.snapshot.columns
  );
  if (candidates.length === 0) {
    return locals;
  }

  const dapOptions = { timeoutMs: Math.min(request.options.timeoutMs, 5000), token: request.options.token };
  for (const name of candidates.slice(0, 32)) {
    const outcome = await request.client.tryEvaluate(name, request.frameId, 'watch', dapOptions);
    if (!outcome.ok) {
      request.logger.debug(`local '${name}' could not be resolved: ${formatError(outcome.error)}`);
      continue;
    }
    const analyzed = analyzeAdapterText(outcome.value.result, outcome.value.type, request.formatOptions);
    const primitive = parseAdapterPrimitive(analyzed.text, analyzed.kind);
    locals.set(name, primitive === undefined ? analyzed.text : primitive);
  }
  return locals;
}

/** Resolves a member path of a row inside the debugger (value pane drill-down). */
export async function evaluateMember(
  client: DapClient,
  provider: LanguageProvider,
  expression: string,
  path: readonly string[],
  frameId: number | undefined,
  options: CaptureOptions,
  formatOptions: FormatOptions
): Promise<{ text: string; typeName?: string; variablesReference: number; kind: string } | undefined> {
  const target = provider.buildMemberExpression?.(expression, path) ?? expression;
  const outcome = await client.tryEvaluate(target, frameId, 'watch', {
    timeoutMs: options.timeoutMs,
    token: options.token
  });
  if (!outcome.ok) {
    return undefined;
  }
  const analyzed = analyzeAdapterText(outcome.value.result, outcome.value.type, formatOptions);
  return {
    text: analyzed.text,
    typeName: outcome.value.type,
    variablesReference: outcome.value.variablesReference,
    kind: analyzed.kind
  };
}

/** Builds a readable summary used by the explorer tree and diagnostics. */
export function describeSnapshot(snapshot: CollectionSnapshot): string {
  const count = snapshot.totalItems ?? snapshot.rows.length;
  const shape = `${count.toLocaleString()} ${count === 1 ? 'element' : 'elements'}`;
  const columns = snapshot.columns.filter((column: ColumnDescriptor) => column.key !== INDEX_COLUMN_KEY).length;
  return `${shape}, ${columns} ${columns === 1 ? 'column' : 'columns'}`;
}

/** Converts adapter variables into a walk root. */
export function toWalkRoot(variable: AdapterVariable): WalkRoot {
  return {
    name: variable.name,
    variablesReference: variable.variablesReference,
    evaluateName: variable.evaluateName,
    typeName: variable.type,
    // The counters are the first choice, the preview text the second: vsdbg
    // reports `Count = 50000` for a `List<T>` without any counters, and without
    // that hint a cut window cannot be noticed.
    childCount: declaredCountOf(variable) ?? null
  };
}
