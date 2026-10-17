import type { CancellationTokenLike } from './types';

/**
 * Runs `worker` over `items` with a bounded number of concurrent calls and
 * preserves the input order in the result. Failures are reported through
 * `onError` and replaced by `fallback` so that one bad item cannot abort the
 * whole batch.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options: {
    token?: CancellationTokenLike;
    onError?: (error: unknown, item: T, index: number) => void;
    fallback?: (item: T, index: number) => R;
    onProgress?: (completed: number, total: number) => void;
  } = {}
): Promise<R[]> {
  const { token, onError, fallback, onProgress } = options;
  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  let completed = 0;

  const run = async (): Promise<void> => {
    while (true) {
      if (token?.isCancellationRequested) {
        return;
      }
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      const item = items[index] as T;
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        onError?.(error, item, index);
        if (fallback) {
          results[index] = fallback(item, index);
        }
      }
      completed += 1;
      onProgress?.(completed, items.length);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

/** Sequential asynchronous loop that stops as soon as the token is cancelled. */
export async function forEachAsync<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  token?: CancellationTokenLike
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    if (token?.isCancellationRequested) {
      return;
    }
    await worker(items[index] as T, index);
  }
}

/** Resolves after `ms` milliseconds, or immediately once the token is cancelled. */
export function delay(ms: number, token?: CancellationTokenLike): Promise<void> {
  if (token?.isCancellationRequested) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (token) {
      const check = setInterval(() => {
        if (token.isCancellationRequested) {
          clearTimeout(handle);
          clearInterval(check);
          resolve();
        }
      }, Math.min(100, ms));
      if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
        (handle as { unref(): void }).unref();
      }
      if (typeof check === 'object' && check !== null && 'unref' in check) {
        (check as { unref(): void }).unref();
      }
    }
  });
}
