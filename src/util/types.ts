/**
 * The subset of `vscode.CancellationToken` used by pure helpers. Declaring it
 * locally keeps the data-processing modules free of a hard `vscode` import so
 * they can run inside plain Node (unit tests, webview side tooling).
 */
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
}

export interface ProgressReporter {
  report(message: string, increment?: number): void;
}

/** Value of the synthetic first column that identifies a row. */
export const INDEX_COLUMN_KEY = '#';

/** Maximum number of items we keep in a single snapshot by default. */
export const DEFAULT_MAX_ROWS = 10000;
