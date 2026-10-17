import type { AdapterVariable, CaptureOptions } from '../model/types';
import { analyzeAdapterText, unquote, type FormatOptions } from '../model/formatter';
import { classifyAdapterVariable, kindFromAdapterValue, normalizeTypeName } from '../model/valueKind';
import type { ElementNode, FieldNode } from '../model/snapshotBuilder';
import { collapseWhitespace, truncate } from '../util/text';
import { parsePreviewObject, type ParsedPreview, type PreviewPrimitive } from '../model/previewParser';
import { mapPool } from '../util/asyncPool';
import type { DapClient } from '../debug/dapClient';
import type { Logger } from '../util/logging';

/**
 * Members injected by the IDE / debug adapter that are never part of the data.
 * They are filtered out before columns are derived.
 */
const PSEUDO_MEMBERS: ReadonlySet<string> = new Set([
  'raw view',
  '[raw view]',
  'static members',
  'non-public members',
  'results view',
  'results',
  'valuation',
  'autoexpanded',
  'isreadonly',
  'isfixedsize',
  'issynchronized',
  'syncroot',
  'sync root',
  'rank',
  'long length',
  'is read only',
  '__proto__',
  '[[prototype]]',
  '[[entries]]'
]);

/** Type names that are rendered as one row per entry. */
const DICTIONARY_TYPES: ReadonlySet<string> = new Set([
  'map',
  'dictionary',
  'dict',
  'hashmap',
  'treemap',
  'sorteddictionary',
  'concurrentdictionary',
  'ordereddictionary',
  'fsharpmap',
  'immutabledictionary'
]);

/** Maximum number of nested sequence items flattened into columns. */
const NESTED_SEQUENCE_LIMIT = 32;

/** Above this element count nested flattening is skipped to bound requests. */
const DEEP_FLATTEN_ELEMENT_LIMIT = 250;

/**
 * How many elements may still be expanded through the adapter while the walk
 * tries to build rows from previews. A preview that does not parse costs one
 * request per element, so a collection whose previews are mostly unusable must
 * not turn the cheap path into a slow one.
 */
export const PREVIEW_EXPANSION_LIMIT = 128;

/** Elements asked for in one `variables` page while enumerating a collection. */
const ROOT_PAGE_SIZE = 1024;

export class RequestBudget {
  private used = 0;

  constructor(private readonly limit: number) {}

  get consumed(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  consume(count = 1): boolean {
    if (this.used + count > this.limit) {
      return false;
    }
    this.used += count;
    return true;
  }
}

export interface WalkRoot {
  name: string;
  variablesReference: number;
  evaluateName?: string;
  typeName?: string;
  /** Element count reported by the adapter, when known. */
  childCount?: number | null;
}

export interface WalkResult {
  elements: ElementNode[];
  totalItems: number | null;
  truncated: boolean;
  warnings: string[];
  /** True when the walk had to stop early because the request budget ran out. */
  budgetExhausted: boolean;
  /** Children the adapter declared for the root, when it declared any. */
  declaredChildren: number | null;
  /** Children the adapter actually handed over. */
  readChildren: number;
  /** Rows built from the adapter preview without expanding them. */
  previewRows: number;
}

export interface WalkContext {
  client: DapClient;
  options: CaptureOptions;
  formatOptions: FormatOptions;
  budget: RequestBudget;
  logger: Logger;
  /** Rows materialized so far, reported while a capture runs. */
  onProgress?: (rows: number, total: number) => void;
  /** Wall clock deadline of the capture, in milliseconds since the epoch. */
  deadline?: number;
  /** Build rows from complete adapter previews instead of expanding each element. */
  expandPreviews?: boolean;
  /** Counters filled in by {@link materializeElements}. */
  previewStats?: { parsed: number; expanded: number };
  /** Root children already fetched, e.g. by {@link previewsDescribeElements}. */
  prefetchedChildren?: readonly AdapterVariable[];
}

/**
 * Cancellation token that also expires at `deadline`, so a walk over a huge
 * collection stops on its own instead of holding the viewer hostage.
 */
function deadlineToken(
  token: CaptureOptions['token'],
  deadline: number
): { isCancellationRequested: boolean } {
  return {
    get isCancellationRequested(): boolean {
      return (token?.isCancellationRequested ?? false) || Date.now() >= deadline;
    }
  };
}

/**
 * True when the child name looks like a positional index.
 *
 * Some adapters append the type to the name (`[0] [string]` in vsdbg), so a
 * trailing suffix is accepted.
 */
export function isIndexedName(name: string): boolean {
  return /^\[\d+\](?:\s|$)/.test(name) || /^\d+$/.test(name);
}

/**
 * Element count that a preview string carries: `(12) [{…}, {…}]` on one adapter,
 * `Count = 50000` or `12 items` on another. `undefined` means the text says
 * nothing about the size, which is not an error.
 */
export function countFromPreview(preview: string | undefined): number | undefined {
  if (!preview) {
    return undefined;
  }
  const trimmed = preview.trim();
  // Anchored patterns on purpose: a record preview such as `{Count: 3, Name: …}`
  // mentions `Count` as a member and must not be read as a collection size.
  const patterns = [
    /^\((\d+)\)/,
    /^Array\((\d+)\)/,
    /^(?:Map|Set|WeakMap|WeakSet)\((\d+)\)/,
    /^(\d+)\s+items?\b/i,
    /^(?:count|len|length|size)\s*=\s*([\d,]+)$/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const parsed = Number((match[1] as string).replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Element count of a variable, as far as the adapter tells us: the counters
 * first, then the count embedded in the preview text. Without the preview
 * fallback an adapter that reports no counters (vsdbg does that for `List<T>`)
 * looks like an empty collection and its window is cut silently.
 *
 * The counters are not added together: an indexed collection reports its
 * elements in `indexedVariables` and its members (`length`, custom properties)
 * in `namedVariables`, so an array of 50,000 elements arrives as 50,000 + 1.
 * Summing them reported one element too many and marked every complete capture
 * as truncated.
 */
export function declaredCountOf(
  variable: Pick<AdapterVariable, 'indexedVariables' | 'namedVariables' | 'value'>
): number | undefined {
  const indexed = variable.indexedVariables ?? 0;
  if (indexed > 0) {
    return indexed;
  }
  const named = variable.namedVariables ?? 0;
  const preview = countFromPreview(variable.value);
  // `namedVariables` may count members (`Count`, `Capacity`, raw view) instead
  // of elements: vsdbg reports `namedVariables = 1` for a `List<T>` whose real
  // size is only in `Count = 1000`. The larger of the two wins.
  if (preview !== undefined && preview > named) {
    return preview;
  }
  return named > 0 ? named : preview;
}

function isExcluded(name: string, excluded: readonly string[]): boolean {
  const normalized = name.trim().toLowerCase();
  if (PSEUDO_MEMBERS.has(normalized)) {
    return true;
  }
  return excluded.some((entry) => entry.trim().toLowerCase() === normalized);
}

function childCountOf(variable: AdapterVariable): number {
  return (variable.indexedVariables ?? 0) + (variable.namedVariables ?? 0);
}

/**
 * Fetches the children of a variables reference, bounded by `limit`.
 * Paging is attempted first so that huge collections stay cheap, and the
 * adapter's paging capability is remembered by {@link DapClient}.
 */
async function fetchChildren(
  variable: AdapterVariable,
  limit: number,
  context: WalkContext
): Promise<AdapterVariable[]> {
  const reference = variable.variablesReference;
  if (reference <= 0) {
    return [];
  }
  const { client, options } = context;
  const dapOptions = { timeoutMs: options.timeoutMs, token: options.token };
  const known = childCountOf(variable);

  if (known > limit) {
    context.budget.consume();
    const page = await client.variables({ reference, start: 0, count: limit }, dapOptions);
    if (page.length > 0) {
      return page;
    }
  }

  context.budget.consume();
  const children = await client.variables({ reference }, dapOptions);
  return children.length > limit ? children.slice(0, limit) : children;
}

function previewText(variable: AdapterVariable, formatOptions: FormatOptions): {
  text: string;
  kind: ReturnType<typeof kindFromAdapterValue>;
  isNull: boolean;
} {
  const analyzed = analyzeAdapterText(variable.value, variable.type, formatOptions);
  return { text: analyzed.text, kind: analyzed.kind, isNull: analyzed.isNull };
}

function sequencePreview(variable: AdapterVariable): string {
  const count = variable.indexedVariables ?? 0;
  const normalized = classifyAdapterVariable(variable);
  const prefix = normalized === 'sequence' ? '[' : normalized === 'map' ? '{' : '(';
  const suffix = prefix === '[' ? ']' : prefix === '{' ? '}' : ')';
  return `${prefix}${count} item${count === 1 ? '' : 's'}${suffix}`;
}

/**
 * Materializes the fields of a single element. `depth` limits how far nested
 * containers are expanded into additional columns; unresolved containers stay
 * expandable so the value pane can load them on demand.
 */
/** A container that is exposed as a lazily expandable leaf. */
function containerLeaf(
  variable: AdapterVariable,
  name: string,
  path: string[],
  formatOptions: FormatOptions
): FieldNode {
  const preview = previewText(variable, formatOptions);
  return {
    name,
    path,
    text: preview.text.length > 0 ? preview.text : sequencePreview(variable),
    kind: variable.variablesReference > 0 ? 'object' : preview.kind,
    expandable: true,
    variablesReference: variable.variablesReference || undefined,
    evaluateName: variable.evaluateName,
    childCount: childCountOf(variable) || undefined,
    typeName: variable.type
  };
}

/** Converts one preview member into a column value. */
function fieldFromPreview(name: string, value: PreviewPrimitive): FieldNode {
  const path = [name];
  if (value === null) {
    return { name, path, text: '', kind: 'null', isNull: true };
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return { name, path, text: String(value), kind: 'number' };
    }
    // NaN and the infinities have no numeric cell representation.
    return { name, path, text: String(value), kind: 'string' };
  }
  if (typeof value === 'boolean') {
    return { name, path, text: value ? 'true' : 'false', kind: 'boolean' };
  }
  return { name, path, text: value, kind: kindFromAdapterValue(undefined, value) };
}

/** Builds the fields of an element from its complete adapter preview. */
function fieldsFromPreview(preview: ParsedPreview, context: WalkContext): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const [name, value] of Object.entries(preview)) {
    if (isExcluded(name, context.options.excludedMembers)) {
      continue;
    }
    fields.push(fieldFromPreview(name, value));
  }
  return fields;
}

/**
 * Materializes the fields of a single element. `depth` is the number of nested
 * containers we are still allowed to descend into; once it reaches zero the
 * container stays expandable so the value pane can load it on demand.
 */
async function materializeFields(
  variable: AdapterVariable,
  depth: number,
  path: string[],
  context: WalkContext
): Promise<FieldNode[]> {
  const { formatOptions } = context;
  const name = path[path.length - 1] ?? variable.name;

  if (variable.variablesReference <= 0) {
    const preview = previewText(variable, formatOptions);
    return [
      {
        name,
        path,
        text: preview.text,
        kind: preview.kind,
        isNull: preview.isNull,
        typeName: variable.type
      }
    ];
  }

  if (depth <= 0 || context.budget.exhausted) {
    return [containerLeaf(variable, name, path, formatOptions)];
  }

  const children = await fetchChildren(variable, context.options.maxRows, context);
  if (children.length === 0) {
    return [containerLeaf(variable, name, path, formatOptions)];
  }

  const indexed = children.every((child) => isIndexedName(child.name));
  const usable = indexed
    ? children
    : children.filter((child) => !isExcluded(child.name, context.options.excludedMembers));

  if (usable.length === 0) {
    return [];
  }

  if (indexed && usable.length > NESTED_SEQUENCE_LIMIT) {
    return [containerLeaf(variable, name, path, formatOptions)];
  }

  const nested = await mapPool<AdapterVariable, FieldNode[]>(
    usable,
    context.options.concurrency,
    async (child) => {
      const childPath = [...path, child.name];
      const nodes = await materializeFields(child, depth - 1, childPath, context);
      return nodes.length > 0 ? nodes : [containerLeaf(child, child.name, childPath, formatOptions)];
    },
    { token: context.options.token, fallback: () => [] }
  );
  return nested.flat();
}

/** Converts a sequence of adapter variables into element nodes. */
async function materializeElements(
  children: readonly AdapterVariable[],
  context: WalkContext,
  depth: number
): Promise<ElementNode[]> {
  const { formatOptions, options } = context;

  const results = await mapPool<AdapterVariable, ElementNode>(
    children,
    options.concurrency,
    async (child, index) => {
      const isLeaf = child.variablesReference <= 0;
      const preview = previewText(child, formatOptions);
      const label = child.name.length > 0 ? child.name : `[${index}]`;

      if (isLeaf) {
        return {
          label,
          typeName: child.type,
          valueText: preview.text,
          evaluateName: child.evaluateName,
          fields: [
            {
              name: 'value',
              path: ['value'],
              text: preview.text,
              kind: preview.kind,
              isNull: preview.isNull,
              typeName: child.type
            }
          ]
        } satisfies ElementNode;
      }

      if (context.expandPreviews) {
        const parsed = parsePreviewObject(child.value);
        if (parsed) {
          const previewFields = fieldsFromPreview(parsed, context);
          if (previewFields.length > 0) {
            if (context.previewStats) {
              context.previewStats.parsed += 1;
            }
            return {
              label,
              typeName: child.type,
              valueText: preview.text,
              variablesReference: child.variablesReference,
              evaluateName: child.evaluateName,
              childCount: childCountOf(child) || undefined,
              fields: previewFields
            } satisfies ElementNode;
          }
        }
        if (context.previewStats) {
          context.previewStats.expanded += 1;
          if (context.previewStats.expanded > PREVIEW_EXPANSION_LIMIT) {
            // Stop paying one request per element; the caller sees that not
            // every row came from a preview and uses another strategy.
            return {
              label,
              typeName: child.type,
              valueText: preview.text,
              variablesReference: child.variablesReference,
              evaluateName: child.evaluateName,
              childCount: childCountOf(child) || undefined,
              fields: [containerLeaf(child, label, ['value'], formatOptions)]
            } satisfies ElementNode;
          }
        }
      }

      const fields = await materializeFields(child, depth, [], context);
      return {
        label,
        typeName: child.type,
        valueText: preview.text,
        variablesReference: child.variablesReference,
        evaluateName: child.evaluateName,
        childCount: childCountOf(child) || undefined,
        fields:
          fields.length > 0
            ? fields
            : [
                {
                  name: 'value',
                  path: ['value'],
                  text: sequencePreview(child),
                  kind: 'object' as const,
                  expandable: true,
                  variablesReference: child.variablesReference,
                  evaluateName: child.evaluateName,
                  typeName: child.type
                }
              ]
      } satisfies ElementNode;
    },
    {
      token: options.token,
      onProgress: context.onProgress,
      fallback: (_item, index): ElementNode => ({
        label: `[${index}]`,
        error: true,
        fields: []
      })
    }
  );

  // A cancelled or expired walk leaves holes where it stopped; the rows it did
  // read are kept, and the caller reports the shorter window.
  return results.filter((entry): entry is ElementNode => entry !== undefined);
}

/** Number of levels we descend into each element, bounded for large collections. */
function fieldDepthFor(elementCount: number, maxDepth: number): number {
  return elementCount <= DEEP_FLATTEN_ELEMENT_LIMIT ? Math.max(1, maxDepth - 1) : 1;
}

/**
 * Enumerates the direct children of a collection in pages.
 *
 * Adapters treat `count` differently: some honour it, some cap it to a page size
 * of their own, and some ignore paging altogether. Because every request carries
 * an explicit `start` offset the first two cases still yield the whole window —
 * up to `limit` elements; when an adapter repeats the same window (it ignored
 * `start` too) the loop stops instead of asking for it forever.
 */
async function fetchRootChildren(
  reference: number,
  limit: number,
  declaredCount: number | null,
  context: WalkContext
): Promise<{ children: AdapterVariable[]; ignoredStart: boolean }> {
  const { client, options } = context;
  const dapOptions = { timeoutMs: options.timeoutMs, token: options.token };
  const children: AdapterVariable[] = [];
  let pageSize = ROOT_PAGE_SIZE;
  let previousFirst: string | undefined;
  let ignoredStart = false;

  while (children.length < limit && !context.budget.exhausted && !pastDeadline(context)) {
    const count = Math.min(pageSize, limit - children.length);
    context.budget.consume();
    const page = await client.variables({ reference, start: children.length, count }, dapOptions);
    if (page.length === 0) {
      break;
    }
    const first = page[0];
    const firstKey = first === undefined ? undefined : childKey(first);
    if (firstKey !== undefined && firstKey === previousFirst) {
      ignoredStart = true;
      break;
    }
    previousFirst = firstKey;
    children.push(...page.slice(0, limit - children.length));
    if (page.length < count) {
      // The adapter has a page size of its own; ask for exactly that from now on.
      pageSize = page.length;
      if (declaredCount === null) {
        // Without a declared count a short page can only mean the end.
        break;
      }
    }
    if (declaredCount !== null && children.length >= declaredCount) {
      break;
    }
  }

  if (children.length === 0) {
    // Adapters that reject the paged request get one unpaged attempt.
    context.budget.consume();
    const full = await client.variables({ reference }, dapOptions);
    return { children: full.slice(0, limit), ignoredStart: false };
  }

  return { children, ignoredStart };
}

/** True when the capture ran out of its time budget. */
function pastDeadline(context: WalkContext): boolean {
  return context.deadline !== undefined && Date.now() >= context.deadline;
}

/** Identity of a child, used to detect an adapter that ignores the `start` offset. */
function childKey(variable: AdapterVariable): string {
  return `${variable.name}\u0000${variable.value}`;
}

/**
 * Checks, with one `variables` request, whether the adapter describes the
 * elements themselves in their preview text.
 *
 * When it does, a whole collection can be materialized from that one response
 * instead of asking for every element separately — which is what makes a
 * 50,000 element array readable in seconds rather than minutes.
 */
export async function previewsDescribeElements(
  root: WalkRoot,
  context: WalkContext,
  sampleSize = 8
): Promise<{ usable: boolean; children: readonly AdapterVariable[] }> {
  const unusable = { usable: false, children: [] as readonly AdapterVariable[] };
  if (root.variablesReference <= 0) {
    return unusable;
  }
  const dapOptions = {
    timeoutMs: context.options.timeoutMs,
    token: context.options.token
  };
  if (!context.budget.consume()) {
    return unusable;
  }
  try {
    const page = await context.client.variables(
      { reference: root.variablesReference, start: 0, count: sampleSize },
      dapOptions
    );
    const expandable = page.filter((child) => child.variablesReference > 0).slice(0, sampleSize);
    if (expandable.length === 0) {
      // Every child is a leaf: the walk already reads those from their previews.
      return { usable: page.length > 0, children: page };
    }
    const usable = expandable.every((child) => parsePreviewObject(child.value) !== undefined);
    return { usable, children: page };
  } catch (error) {
    context.logger.debug(`could not probe adapter previews: ${String(error)}`);
    return unusable;
  }
}

/**
 * The universal capture path: enumerate the object graph through the DAP
 * `variables` request only. Works with every debug adapter, at the cost of
 * one round trip per expanded container.
 */
export async function walkVariables(root: WalkRoot, provided: WalkContext): Promise<WalkResult> {
  const warnings: string[] = [];
  // The walk costs about one request per element, so a collection of fifty
  // thousand elements cannot be read in one go; the budget keeps a capture
  // bounded and the partial window is reported instead of hanging the viewer.
  const deadline = Date.now() + Math.max(1, provided.options.captureBudgetMs ?? 30000);
  const previewStats = provided.previewStats ?? { parsed: 0, expanded: 0 };
  const context: WalkContext = {
    ...provided,
    options: { ...provided.options, token: deadlineToken(provided.options.token, deadline) },
    deadline,
    previewStats
  };
  const { options } = context;

  if (root.variablesReference <= 0) {
    return {
      elements: [],
      totalItems: 0,
      truncated: false,
      warnings: ['The selected variable has no expandable children.'],
      budgetExhausted: false,
      declaredChildren: null,
      readChildren: 0,
      previewRows: 0
    };
  }

  const declaredCount = root.childCount !== undefined && root.childCount !== null && root.childCount > 0
    ? root.childCount
    : null;
  const limit = Math.max(1, options.maxRows);

  // First pass: enumerate the direct children of the expression to decide
  // whether we are dealing with a sequence or with a single record.
  const prefetched = provided.prefetchedChildren;
  const enumeration =
    prefetched && prefetched.length > 0
      ? { children: prefetched.slice(0, limit), ignoredStart: false }
      : await fetchRootChildren(root.variablesReference, limit, declaredCount, context);

  if (enumeration.children.length === 0) {
    return {
      elements: [],
      totalItems: declaredCount ?? 0,
      truncated: false,
      warnings: ['The debug adapter returned no children for this variable.'],
      budgetExhausted: false,
      declaredChildren: declaredCount,
      readChildren: 0,
      previewRows: 0
    };
  }

  return finish(enumeration.children, enumeration.ignoredStart);

  async function finish(children: AdapterVariable[], pagingIgnored = false): Promise<WalkResult> {
    const indexedCount = children.filter((child) => isIndexedName(child.name)).length;
    const named = children.filter((child) => !isIndexedName(child.name));
    const usableNamed = named.filter((child) => !isExcluded(child.name, options.excludedMembers));
    const looksLikeSequence = indexedCount > 0 && indexedCount >= children.length / 2;
    // Anything the adapter declared but did not hand over is a truncated window,
    // whether the cap came from `maxRows` or from the adapter itself.
    const truncated = declaredCount !== null && declaredCount > children.length;

    if (looksLikeSequence) {
      const sequence = children.filter((child) => isIndexedName(child.name));
      if (truncated && declaredCount !== null) {
        warnings.push(
          declaredCount > limit
            ? `The collection reports ${declaredCount.toLocaleString()} elements; only the first ${sequence.length.toLocaleString()} were requested.`
            : `The debug adapter returned only the first ${children.length.toLocaleString()} of ${declaredCount.toLocaleString()} children${
                pagingIgnored ? ' and ignored the requested page range' : ''
              }.`
        );
      }
      const elements = await materializeElements(sequence, context, fieldDepthFor(sequence.length, options.maxDepth));
      const cutByBudget = elements.length < sequence.length;
      if (cutByBudget) {
        warnings.push(
          `The capture stopped after ${elements.length.toLocaleString()} of ${sequence.length.toLocaleString()} rows: reading a collection through the debugger costs one request per row. Raise exploringCollections.captureBudgetMs to read further.`
        );
      }
      return {
        elements,
        totalItems: declaredCount ?? sequence.length,
        truncated: truncated || cutByBudget,
        warnings,
        budgetExhausted: context.budget.exhausted,
        declaredChildren: declaredCount,
        readChildren: sequence.length,
        previewRows: previewStats.parsed
      };
    }

    if (usableNamed.length === 0) {
      return {
        elements: [],
        totalItems: 0,
        truncated: false,
        warnings: ['The variable exposes no data members.'],
        budgetExhausted: context.budget.exhausted,
        declaredChildren: declaredCount,
        readChildren: children.length,
        previewRows: previewStats.parsed
      };
    }

    const expandableNamed = usableNamed.filter((child) => child.variablesReference > 0);
    // A dictionary whose values are primitives exposes no expandable children, so
    // the declared type decides in that case.
    const treatAsDictionary =
      options.dictionariesAsRows &&
      (DICTIONARY_TYPES.has(normalizeTypeName(root.typeName)) ||
        expandableNamed.length >= Math.max(1, usableNamed.length * 0.6));

    if (treatAsDictionary) {
      const elements = await materializeElements(
        usableNamed,
        context,
        fieldDepthFor(usableNamed.length, options.maxDepth)
      );
      const mapped = elements.map((element, index) => ({
        ...element,
        label: usableNamed[index]?.name ?? element.label
      }));
      const cutByBudget = mapped.length < usableNamed.length;
      return {
        elements: mapped,
        totalItems: declaredCount ?? mapped.length,
        truncated: truncated || cutByBudget,
        warnings,
        budgetExhausted: context.budget.exhausted,
        declaredChildren: declaredCount,
        readChildren: children.length,
        previewRows: previewStats.parsed
      };
    }

    // Record mode: the variable is a single object, so it becomes one row whose
    // columns are its members.
    const fields = await materializeFields(
      {
        name: root.name,
        value: '',
        variablesReference: root.variablesReference,
        evaluateName: root.evaluateName,
        type: root.typeName,
        indexedVariables: 0,
        namedVariables: usableNamed.length
      },
      Math.max(1, options.maxDepth) - 1,
      [],
      context
    );

    return {
      elements: [
        {
          label: root.name,
          typeName: root.typeName,
          variablesReference: root.variablesReference,
          evaluateName: root.evaluateName,
          childCount: declaredCount ?? undefined,
          fields
        }
      ],
      totalItems: 1,
      truncated: false,
      warnings,
      budgetExhausted: context.budget.exhausted,
      declaredChildren: declaredCount,
      readChildren: children.length,
      previewRows: previewStats.parsed
    };
  }
}

/** Builds an element node from a plain JavaScript value (helper fast path). */
export function elementFromRawValue(value: unknown, index: number, label?: string): ElementNode {
  if (value === null || value === undefined || typeof value !== 'object') {
    const text = value === null || value === undefined ? '' : collapseWhitespace(String(value));
    return {
      label: label ?? `[${index}]`,
      fields: [
        {
          name: 'value',
          path: ['value'],
          text: truncate(text, 512),
          kind: value === null || value === undefined ? 'null' : kindFromAdapterValue(undefined, text),
          isNull: value === null || value === undefined,
          raw: value ?? null
        }
      ]
    };
  }
  return {
    label: label ?? `[${index}]`,
    raw: value,
    fields: []
  };
}

/** Removes the surrounding quotes from a serialized JSON payload. */
export function unwrapSerializedPayload(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (/^["']/.test(trimmed)) {
    return unquote(trimmed);
  }
  return trimmed;
}
