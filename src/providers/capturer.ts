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
import { RequestBudget, declaredCountOf, walkVariables, type WalkRoot } from './variablesWalk';
import type { HelperOptions, LanguageProvider } from './languageProvider';
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
    case 'python':
      return 'python/exploring_collections_helper.py';
    case 'go':
      return 'go/exploring_collections.go';
    case 'rust':
      return 'rust/exploring_collections.rs';
    case 'cpp':
    case 'c':
      return 'cc/exploring_collections.h';
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
export async function captureCollection(request: CaptureRequest): Promise<CollectionSnapshot> {
  const started = Date.now();
  const { client, provider, options, helperOptions, logger } = request;
  const dapOptions = { timeoutMs: options.timeoutMs, token: options.token };
  const warnings: string[] = [];
  const fallbackReasons: string[] = [];
  const notes = [...provider.notes];
  client.resetCounters();

  const expression = request.root.evaluateName ?? request.source;
  const budget = new RequestBudget(request.requestBudget ?? 20000);
  // The counters of the adapter, or the count its preview text carries: vsdbg
  // reports `Count = 50000` for a big `List<T>` without any counters.
  const declaredCount = request.root.childCount ?? null;

  if (options.useHelpers) {
    const helperPath = helperOptions.helperPath?.(helperRelativePath(provider.id));
    const loadExpression = helperPath ? provider.buildHelperLoadExpression?.(helperPath) : undefined;

    if (loadExpression !== undefined && !request.helperState.attempted) {
      request.helperState.attempted = true;
      const outcome = await client.tryEvaluate(loadExpression, request.frameId, 'watch', dapOptions);
      request.helperState.loaded = outcome.ok;
      if (!outcome.ok) {
        request.helperState.failureReason = formatError(outcome.error);
        fallbackReasons.push(`helper load failed: ${request.helperState.failureReason}`);
        logger.debug(`helper load failed for ${provider.id}: ${request.helperState.failureReason}`);
      } else {
        logger.info(`helper loaded for ${provider.id}`);
      }
    }

    // A collection the adapter declares as huge is paged through the evaluator
    // before anything that would serialize all of it at once: one JSON page per
    // request, instead of a payload of fifty thousand elements that the adapter
    // is likely to cut (and one request per element if it does).
    if (declaredCount !== null && declaredCount > RANGE_FIRST_ELEMENTS) {
      const paged = await captureByRanges(request, budget, dapOptions);
      if (paged && paged.elements.length > 0) {
        if (paged.budgetSpent) {
          warnings.push(budgetWarning(paged.elements.length, paged.total));
        }
        return finish('expression-subrange', paged.elements, paged.total, 'the debugger');
      }
      fallbackReasons.push('the debugger could not read the collection in pages');
    }

    if (request.helperState.loaded && provider.buildNativeHelperExpression) {
      const nativeExpression = provider.buildNativeHelperExpression(expression, helperOptions);
      if (nativeExpression) {
        const outcome = await client.tryEvaluate(nativeExpression, request.frameId, 'watch', dapOptions);
        if (outcome.ok && isCutPayload(outcome.value.result)) {
          fallbackReasons.push(
            `the debug adapter cut the payload of the helper (${outcome.value.result.length.toLocaleString()} characters)`
          );
        } else if (outcome.ok) {
          const elements = provider.parseSerializedPayload?.(outcome.value.result);
          if (elements) {
            return finish('helper-native', elements, totalFromPayload(outcome.value.result), 'the helper');
          }
          fallbackReasons.push('the native helper returned a payload that is not a supported collection envelope');
        } else {
          fallbackReasons.push(`native helper call failed: ${formatError(outcome.error)}`);
        }
      }
    }

    if (provider.buildSerializeExpression) {
      const candidates = provider.buildSerializeExpression(expression, helperOptions);
      for (const candidate of candidates) {
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
          return finish('helper-json', elements, totalFromPayload(outcome.value.result), 'the helper');
        }
        fallbackReasons.push(`payload of ${summarize(candidate)} was not parseable as JSON`);
      }
    }
  }


  const walk = await walkVariables(request.root, {
    client,
    options,
    formatOptions: request.formatOptions,
    budget,
    logger,
    onProgress: request.onProgress
  });

  let elements = walk.elements;
  let totalItems = walk.totalItems;
  let truncated = walk.truncated;
  let strategy: RetrievalStrategy = 'variables-walk';

  // The adapter handed over less than it declared: the evaluator can still reach
  // the rest of the collection, so try it before accepting the cut window.
  const shortWindow =
    walk.declaredChildren !== null && walk.readChildren < walk.declaredChildren && walk.readChildren > 0;
  if (shortWindow) {
    const paged = await captureByRanges(request, budget, dapOptions);
    if (paged && paged.elements.length > walk.elements.length) {
      if (paged.budgetSpent) {
        warnings.push(budgetWarning(paged.elements.length, paged.total));
      }
      return finish('expression-subrange', paged.elements, paged.total, 'the debugger');
    }
  }

  warnings.push(...walk.warnings.filter((warning) => !warnings.includes(warning)));
  if (walk.budgetExhausted) {
    warnings.push(
      `The capture stopped after ${budget.consumed.toLocaleString()} debugger requests; increase exploringCollections.maxRows or narrow the collection.`
    );
  }
  if (fallbackReasons.length > 0) {
    warnings.push('The fast serializer was unavailable, so the collection was enumerated through the debugger variables tree.');
  }
  return finish(strategy, elements, totalItems, 'the variables tree', truncated);

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
        `The collection holds ${total.toLocaleString()} elements; ${source} returned the first ${captured.length.toLocaleString()}.`
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

/** Explains a window that the capture budget cut short. */
function budgetWarning(rows: number, total: number | null): string {
  const of = total === null ? '' : ` of ${total.toLocaleString()}`;
  return (
    `The capture stopped after ${rows.toLocaleString()}${of} rows: raising ` +
    'exploringCollections.captureBudgetMs reads further.'
  );
}

/** Elements asked for in one evaluator page of the range based capture. */
const RANGE_PAGE_SIZE = 1024;
/** Smallest page the range based capture falls back to when a payload is cut. */
const RANGE_MIN_PAGE = 4;
/** Above this declared size the evaluator is asked before the variables walk. */
const RANGE_FIRST_ELEMENTS = 2000;

/**
 * Reads the collection in JSON pages with the provider's range expression
 * (`Skip`/`Take`, `slice`, `islice`, …).
 *
 * Adapters that cap a single `variables` response still evaluate `items.Skip(n)
 * .Take(m)` over the whole collection, so this reaches elements the variables
 * walk cannot see — and it costs one request per page instead of one per element.
 * A page whose payload does not parse (an adapter that truncates long results) is
 * retried with a smaller page; when even that fails the walk result is kept.
 */
async function captureByRanges(
  request: CaptureRequest,
  budget: RequestBudget,
  dapOptions: { timeoutMs: number; token?: { isCancellationRequested: boolean } }
): Promise<{ elements: ElementNode[]; total: number | null; budgetSpent: boolean } | undefined> {
  const { provider, options } = request;
  const expression = request.root.evaluateName ?? request.source;
  if (!provider.buildRangeExpression || !provider.parseSerializedPayload || expression.trim().length === 0) {
    return undefined;
  }
  const limit = Math.max(1, options.maxRows);
  const declared = request.root.childCount ?? null;
  // The same budget as the walk: paging is cheap per request, but a collection
  // of a million elements must not keep the viewer busy forever either.
  const deadline = Date.now() + Math.max(1, options.captureBudgetMs ?? 30000);
  const elements: ElementNode[] = [];
  let pageSize = Math.min(limit, RANGE_PAGE_SIZE);
  // Largest page the adapter is known to deliver in one piece; a page the
  // adapter cut lowers it, so the reader converges instead of oscillating.
  let ceiling = pageSize;
  let start = 0;

  while (elements.length < limit && !budget.exhausted && Date.now() < deadline) {
    const count = Math.min(pageSize, limit - elements.length);
    const range = provider.buildRangeExpression(expression, start, count);
    if (!range) {
      return elements.length > 0 ? { elements, total: declared, budgetSpent: false } : undefined;
    }
    budget.consume();
    const outcome = await request.client.tryEvaluate(range, request.frameId, 'watch', dapOptions);
    if (!outcome.ok) {
      request.logger.debug(`range page failed for '${expression}': ${formatError(outcome.error)}`);
      return elements.length > 0 ? { elements, total: declared, budgetSpent: false } : undefined;
    }
    const cut = isCutPayload(outcome.value.result);
    const page = cut ? undefined : provider.parseSerializedPayload(outcome.value.result);
    if (!page || page.length === 0) {
      if (pageSize > RANGE_MIN_PAGE) {
        // The adapter cut the payload or refused it: ask for less next time.
        ceiling = Math.min(ceiling, pageSize - 1);
        pageSize = Math.max(RANGE_MIN_PAGE, Math.floor(pageSize / 2));
        continue;
      }
      break;
    }
    for (const [index, element] of page.entries()) {
      if (/^\[\d+\]$/.test(element.label)) {
        element.label = `[${start + index}]`;
      }
    }
    elements.push(...page.slice(0, limit - elements.length));
    start += page.length;
    if (page.length < count) {
      // The range ran past the end of the collection.
      break;
    }
    if (count === pageSize && pageSize < ceiling) {
      // The page survived; ask for more next time, but never past a size the
      // adapter already cut.
      pageSize = Math.min(ceiling, pageSize * 2);
    }
    if (declared !== null && elements.length >= declared) {
      break;
    }
  }

  if (elements.length === 0) {
    return undefined;
  }
  return { elements, total: declared, budgetSpent: Date.now() >= deadline };
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
