import type {
  AdapterVariable,
  EvaluateResponse,
  StackFrameInfo,
  ThreadInfo,
  VariablesResponse
} from '../model/types';
import type { CancellationTokenLike } from '../util/types';
import { cancelledPromise, formatError, isUnsupportedRequestError, type Logger } from '../util/logging';

/** Shape of the object returned by `vscode.DebugSession.customRequest`. */
export type CustomRequestFn = (command: string, args?: unknown) => Thenable<unknown>;

export interface ScopeInfo {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface VariableQuery {
  reference: number;
  /** Zero based index of the first child to return (requires paging support). */
  start?: number;
  /** Number of children to return. */
  count?: number;
}

export interface DapClientOptions {
  timeoutMs: number;
  token?: CancellationTokenLike;
}

/**
 * Thin, defensive wrapper around `DebugSession.customRequest`.
 *
 * Every call is bounded by a timeout because a wedged debug adapter would
 * otherwise block the extension host indefinitely, and every rejection is
 * normalized so callers can distinguish "not supported" from a real failure.
 */
export class DapClient {
  private requestCount = 0;
  private pagingSupport: boolean | undefined;

  constructor(
    private readonly customRequest: CustomRequestFn,
    private readonly logger: Logger,
    private readonly sessionId: string
  ) {}

  get requests(): number {
    return this.requestCount;
  }

  get session(): string {
    return this.sessionId;
  }

  resetCounters(): void {
    this.requestCount = 0;
  }

  private async send<T>(command: string, args: unknown, options: DapClientOptions): Promise<T> {
    const { timeoutMs, token } = options;
    if (token?.isCancellationRequested) {
      throw new Error('cancelled');
    }
    this.requestCount += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `debug adapter did not answer the '${command}' request within ${timeoutMs} ms`
          )
        );
      }, timeoutMs);
    });
    try {
      return (await Promise.race([
        Promise.resolve(this.customRequest(command, args)),
        timeout,
        cancelledPromise(token)
      ])) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async threads(options: DapClientOptions): Promise<ThreadInfo[]> {
    const body = await this.send<{ threads: ThreadInfo[] }>('threads', {}, options);
    return body?.threads ?? [];
  }

  async stackTrace(
    threadId: number,
    options: DapClientOptions & { levels?: number; startFrame?: number }
  ): Promise<StackFrameInfo[]> {
    const body = await this.send<{ stackFrames: StackFrameInfo[] }>(
      'stackTrace',
      { threadId, startFrame: options.startFrame ?? 0, levels: options.levels ?? 1 },
      options
    );
    return body?.stackFrames ?? [];
  }

  async scopes(frameId: number, options: DapClientOptions): Promise<ScopeInfo[]> {
    const body = await this.send<{ scopes: ScopeInfo[] }>('scopes', { frameId }, options);
    return body?.scopes ?? [];
  }

  /**
   * Enumerates the children of a variables reference. Paging is used only when
   * the adapter accepted it before; otherwise all children are requested at once.
   */
  async variables(query: VariableQuery, options: DapClientOptions): Promise<AdapterVariable[]> {
    const wantsPaging = query.start !== undefined || query.count !== undefined;
    const usePaging = wantsPaging && (this.pagingSupport ?? true);

    const args: Record<string, unknown> = { variablesReference: query.reference };
    if (usePaging) {
      if (query.start !== undefined) {
        args.start = query.start;
      }
      if (query.count !== undefined) {
        args.count = query.count;
      }
    }

    try {
      const body = await this.send<VariablesResponse>('variables', args, options);
      if (usePaging && (query.start !== undefined || query.count !== undefined)) {
        this.pagingSupport = true;
      }
      return body?.variables ?? [];
    } catch (error) {
      if (usePaging && isUnsupportedRequestError(error)) {
        this.logger.debug(`adapter rejected variable paging, falling back to full enumeration`);
        this.pagingSupport = false;
        const fallbackArgs: Record<string, unknown> = { variablesReference: query.reference };
        const body = await this.send<VariablesResponse>('variables', fallbackArgs, options);
        return body?.variables ?? [];
      }
      throw error;
    }
  }

  /** Returns `undefined` when the adapter cannot evaluate expressions at all. */
  async tryEvaluate(
    expression: string,
    frameId: number | undefined,
    context: 'watch' | 'repl' | 'hover',
    options: DapClientOptions
  ): Promise<{ ok: true; value: EvaluateResponse } | { ok: false; error: unknown; unsupported: boolean }> {
    try {
      const body = await this.send<EvaluateResponse>(
        'evaluate',
        { expression, frameId, context, includeAll: true },
        options
      );
      // Some adapters (vsdbg among them) answer a failed evaluation with a
      // successful response that carries the exception as the value and only
      // flags it in the presentation hint.
      if (body?.presentationHint?.attributes?.includes('failedEvaluation')) {
        const message = body.result || body.type || 'evaluation failed';
        return { ok: false, error: new Error(message), unsupported: false };
      }
      return { ok: true, value: body };
    } catch (error) {
      return { ok: false, error, unsupported: isUnsupportedRequestError(error) };
    }
  }

  async evaluate(
    expression: string,
    frameId: number | undefined,
    context: 'watch' | 'repl' | 'hover',
    options: DapClientOptions
  ): Promise<EvaluateResponse> {
    const result = await this.tryEvaluate(expression, frameId, context, options);
    if (result.ok) {
      return result.value;
    }
    throw new Error(
      `evaluating '${expression}' failed: ${formatError(result.error)}`
    );
  }

  async setVariable(
    variablesReference: number,
    name: string,
    value: string,
    options: DapClientOptions
  ): Promise<void> {
    await this.send('setVariable', { variablesReference, name, value }, options);
  }

  async completions(
    text: string,
    column: number,
    frameId: number | undefined,
    options: DapClientOptions
  ): Promise<Array<{ label: string; text?: string; type?: string }>> {
    const body = await this.send<{ targets: Array<{ label: string; text?: string; type?: string }> }>(
      'completions',
      { text, column, frameId },
      options
    );
    return body?.targets ?? [];
  }
}
