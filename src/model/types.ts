import type { CancellationTokenLike } from '../util/types';

/** Semantic kind of a column, inferred from raw values or adapter type names. */
export type ColumnKind =
  | 'index'
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'object'
  | 'array'
  | 'null'
  | 'unknown';

/** How the snapshot content was retrieved from the debuggee. */
export type RetrievalStrategy =
  | 'helper-json'
  | 'helper-native'
  | 'variables-walk'
  | 'adapter-previews'
  | 'source-literal';

/** A single flattened column of the collection table. */
export interface ColumnDescriptor {
  /** Stable identifier, equal to the dot path joined with '.'. */
  key: string;
  /** Human readable header (last path segment). */
  title: string;
  /** Property path from the element root, e.g. `['Address','City']`. */
  path: string[];
  kind: ColumnKind;
  /** Adapter reported type, used for tooltips and kind refinement. */
  typeName?: string;
  /** True when the column was produced by flattening a nested object. */
  nested: boolean;
}

/** A single cell of the collection table. */
export interface CellValue {
  /** Text rendered in the grid. */
  text: string;
  kind: ColumnKind;
  isNull: boolean;
  /** Raw JSON value when the snapshot came from a serializing helper. */
  raw?: unknown;
  /** True when the value can be expanded in the value pane. */
  expandable: boolean;
  /** Adapter type name, shown in the tooltip. */
  typeName?: string;
  /** Reference used to expand the cell inside the value pane. */
  variablesReference?: number;
  /** Expression that evaluates to the value, used for lazy retrieval. */
  evaluateName?: string;
}

/** One row (element) of the collection table. */
export interface RowDescriptor {
  /** Zero based position inside the collection. */
  index: number;
  /** Row label: `[0]`, `[1]`, or the dictionary key. */
  label: string;
  /** Flattened cells aligned with {@link CollectionSnapshot.columns}. */
  cells: CellValue[];
  /** Adapter type name of the element. */
  typeName?: string;
  /** Reference used to expand the element inside the value pane. */
  variablesReference?: number;
  /** Expression that evaluates to the element, used for lazy retrieval. */
  evaluateName?: string;
  /** Number of child members reported by the adapter. */
  childCount?: number;
  /** True when the debugger reported the element as an error value. */
  error?: boolean;
}

/** A node of the lazy "value pane" object tree. */
export interface ValueNode {
  name: string;
  value: string;
  kind: ColumnKind;
  typeName?: string;
  variablesReference?: number;
  evaluateName?: string;
  childCount?: number;
  children?: ValueNode[];
  /** True when children can be requested from the debug adapter on demand. */
  lazy: boolean;
}

/** Statistics collected while materializing a snapshot. */
export interface SnapshotDiagnostics {
  strategy: RetrievalStrategy;
  /** Duration of the whole capture in milliseconds. */
  durationMs: number;
  /** Debug adapter round trips performed. */
  requests: number;
  /** Number of elements the adapter reported for the collection. */
  reportedItemCount: number | null;
  /** Fast path attempts that failed and fell back to the variables walk. */
  fallbackReasons: string[];
  /** Statement of the filter that was pushed down to the debugger, if any. */
  pushedDownFilter?: string;
  /** Provider supplied notes about fast path limitations. */
  notes: string[];
}

/** Where a snapshot read from the source text came from. */
export interface SnapshotSource {
  kind: 'source-literal';
  /** Document uri as text. */
  uri: string;
  /** Zero based line of the declaration the literal was read from. */
  line: number;
}

/** Everything the UI needs to render one collection. */
export interface CollectionSnapshot {
  id: string;
  /** Display title, usually the variable name. */
  title: string;
  /** Expression that was evaluated to produce the snapshot. */
  expression: string;
  sessionId: string;
  sessionName: string;
  debugType: string;
  /** Canonical language id of the provider that produced the snapshot. */
  language: string;
  providerId: string;
  /** Epoch milliseconds. */
  capturedAt: number;
  columns: ColumnDescriptor[];
  rows: RowDescriptor[];
  /** Element count reported by the adapter, `null` when unknown. */
  totalItems: number | null;
  truncated: boolean;
  /** User visible warnings, e.g. "showing the first 10000 of 250000 elements". */
  warnings: string[];
  /** Set when the data was read from the source text instead of a debugger. */
  source?: SnapshotSource;
  diagnostics: SnapshotDiagnostics;
}

/** Result of a filter evaluation, either pushed down or evaluated locally. */
export interface FilterResult {
  rows: RowDescriptor[];
  /** Text of the expression actually executed, for diagnostics. */
  executed: string;
  /** Where the expression ran. */
  location: 'debugger' | 'client';
  /** Non fatal problems, e.g. unsupported functions. */
  warnings: string[];
}

/** A live debug session as seen by the extension. */
export interface SessionInfo {
  id: string;
  name: string;
  type: string;
  workspaceFolder?: string;
  language: string;
  providerId: string;
  supported: boolean;
}

/** Options accepted by a language provider when capturing a collection. */
export interface CaptureOptions {
  maxRows: number;
  /** Upper bound of the time one capture may spend reading a collection. */
  captureBudgetMs: number;
  maxDepth: number;
  concurrency: number;
  timeoutMs: number;
  dictionariesAsRows: boolean;
  excludedMembers: readonly string[];
  token?: CancellationTokenLike;
  onProgress?: (message: string) => void;
}

/** Raw variable node as returned by the `variables` request. */
export interface AdapterVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  indexedVariables?: number;
  namedVariables?: number;
  memoryReference?: string;
  presentationHint?: {
    kind?: string;
    attributes?: string[];
    visibility?: string;
    lazy?: boolean;
  };
}

/** Minimal shape of the DAP `variables` response body. */
export interface VariablesResponse {
  variables: AdapterVariable[];
}

/** Minimal shape of the DAP `evaluate` response body. */
export interface EvaluateResponse {
  result: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  presentationHint?: { kind?: string; attributes?: string[] };
  memoryReference?: string;
}

/** Debug adapter capabilities we care about (subset of the DAP spec). */
export interface AdapterCapabilities {
  supportsEvaluateForHovers?: boolean;
  supportsSetExpression?: boolean;
  supportsVariablePaging?: boolean;
  supportsVariableType?: boolean;
  supportsClipboardContext?: boolean;
  supportsDataBreakpoints?: boolean;
  supportsCompletionsRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  [key: string]: unknown;
}

/** Subset of DAP `threads` / `stackTrace` used to resolve a frame. */
export interface ThreadInfo {
  id: number;
  name: string;
}

export interface StackFrameInfo {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { name?: string; path?: string };
}
