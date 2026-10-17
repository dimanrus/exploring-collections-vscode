import type { CancellationTokenLike } from '../util/types';

/** Minimal logger contract so this module stays free of a `vscode` import. */
export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export const consoleLogger: Logger = {
  trace: (message) => console.debug(`[trace] ${message}`),
  debug: (message) => console.debug(message),
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error ?? '')
};

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** True when the error indicates the debug adapter does not know a request. */
export function isUnsupportedRequestError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return (
    message.includes('unsupported') ||
    message.includes('not supported') ||
    message.includes('unrecognized request') ||
    message.includes('notimplemented') ||
    message.includes('no such request') ||
    message.includes('unknown command') ||
    message.includes('invalid request')
  );
}

/** True when a request was cancelled because the session went away. */
export function isSessionGoneError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return (
    message.includes('debug session is not active') ||
    message.includes('session has terminated') ||
    message.includes('no active debug session') ||
    message.includes('disconnected') ||
    message.includes('session not found')
  );
}

/** A promise that rejects once the cancellation token fires. */
export function cancelledPromise(token?: CancellationTokenLike): Promise<never> {
  if (!token) {
    return new Promise<never>(() => undefined);
  }
  return new Promise<never>((_resolve, reject) => {
    if (token.isCancellationRequested) {
      reject(new Error('cancelled'));
      return;
    }
    const handle = setInterval(() => {
      if (token.isCancellationRequested) {
        clearInterval(handle);
        reject(new Error('cancelled'));
      }
    }, 50);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }
  });
}
