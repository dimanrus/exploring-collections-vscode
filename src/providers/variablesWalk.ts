import type { AdapterVariable, CaptureOptions } from '../model/types';
import { analyzeAdapterText, unquote, type FormatOptions } from '../model/formatter';
import { classifyAdapterVariable, kindFromAdapterValue, normalizeTypeName } from '../model/valueKind';
import type { ElementNode, FieldNode } from '../model/snapshotBuilder';
import { collapseWhitespace, truncate } from '../util/text';
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

/** True when the child name looks like a positional index. */
export function isIndexedName(name: string): boolean {
  return /^\[\d+\]$/.test(name) || /^\d+$/.test(name);
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
  const patterns = [/^\((\d+)\)/, /\b(\d+)\s+items?\b/i, /\b(?:len|length|count)\s*[:=]\s*(\d+)/i];
  for (const pattern of patterns) {
    const match = pattern.exec(preview);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Number of children a variable has, as far as the adapter tells us: the real
 * counters first, then the count embedded in the preview text. Without the
 * preview fallback an adapter that reports no counters (vsdbg does that for
 * `List<T>`) looks like an empty collection and its window is cut silently.
 */
export function declaredCountOf(
  variable: Pick<AdapterVariable, 'indexedVariables' | 'namedVariables' | 'value'>
): number | undefined {
  const declared = (variable.indexedVariables ?? 0) + (variable.namedVariables ?? 0);
  if (declared > 0) {
    return declared;
  }
  return countFromPreview(variable.value);
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
  const context: WalkContext = {
    ...provided,
    options: { ...provided.options, token: deadlineToken(provided.options.token, deadline) },
    deadline
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
      readChildren: 0
    };
  }

  const declaredCount = root.childCount !== undefined && root.childCount !== null && root.childCount > 0
    ? root.childCount
    : null;
  const limit = Math.max(1, options.maxRows);

  // First pass: enumerate the direct children of the expression to decide
  // whether we are dealing with a sequence or with a single record.
  const enumeration = await fetchRootChildren(root.variablesReference, limit, declaredCount, context);

  if (enumeration.children.length === 0) {
    return {
      elements: [],
      totalItems: declaredCount ?? 0,
      truncated: false,
      warnings: ['The debug adapter returned no children for this variable.'],
      budgetExhausted: false,
      declaredChildren: declaredCount,
      readChildren: 0
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
        readChildren: sequence.length
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
        readChildren: children.length
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
        readChildren: children.length
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
      readChildren: children.length
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
