import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import type { AdapterVariable, CaptureOptions, SessionInfo } from '../model/types';
import type { HelperOptions, LanguageProvider, LanguageProviderRegistry, ProviderMatchContext } from '../providers/languageProvider';
import { helperRelativePath, toWalkRoot } from '../providers/capturer';
import type { SessionHelperState } from '../providers/capturer';
import type { WalkRoot } from '../providers/variablesWalk';
import { DapClient } from './dapClient';
import { readSettings, type ExtensionSettings } from '../services/config';
import type { Logger } from '../util/logging';
import { formatError } from '../util/logging';

/** Everything the capture pipeline needs for one debug session. */
export interface SessionContext {
  session: vscode.DebugSession;
  client: DapClient;
  provider: LanguageProvider;
  frameId?: number;
  sourcePath?: string;
  /** One based line the adapter reported for the frame. */
  frameLine?: number;
  editorLanguageId?: string;
  helperState: SessionHelperState;
  settings: ExtensionSettings;
}

/** Raw shape of the argument VS Code passes to debug context menu commands. */
interface DebugContextMenuArgument {
  sessionId?: string;
  container?: unknown;
  variable?: Partial<AdapterVariable> & { name?: string };
}

/** Normalizes the many shapes a debug command can be invoked with. */
export function normalizeVariableArgument(
  argument: unknown
): { sessionId?: string; variable: Partial<AdapterVariable> } | undefined {
  if (!argument || typeof argument !== 'object') {
    return undefined;
  }
  const candidate = argument as DebugContextMenuArgument & Partial<AdapterVariable>;
  if (candidate.variable && typeof candidate.variable === 'object') {
    return { sessionId: candidate.sessionId, variable: candidate.variable };
  }
  if (typeof candidate.name === 'string' || typeof candidate.evaluateName === 'string') {
    return { sessionId: undefined, variable: candidate };
  }
  return undefined;
}

/** Tracks debug sessions and resolves the language provider for each of them. */
export class DebugSessionRegistry implements vscode.Disposable {
  private readonly clients = new Map<string, DapClient>();
  private readonly helperStates = new Map<string, SessionHelperState>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly knownSessions = new Map<string, vscode.DebugSession>();
  /**
   * Source of the frames we already asked the adapter about. CodeLens and hover
   * both need it, and a `stackTrace` round trip per keystroke would be rude.
   */
  private readonly frameInfos = new Map<string, { sourcePath?: string; line?: number; expires: number }>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly providers: LanguageProviderRegistry,
    private readonly logger: Logger,
    private readonly extensionUri: vscode.Uri
  ) {}

  /** Wires the VS Code debug events. */
  initialize(): void {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this.knownSessions.set(session.id, session);
        this.logger.info(`debug session started: ${session.name} (${session.type}, id=${session.id})`);
        this.changeEmitter.fire();
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.knownSessions.delete(session.id);
        this.clients.delete(session.id);
        for (const key of [...this.helperStates.keys()]) {
          if (key.startsWith(`${session.id}:`)) {
            this.helperStates.delete(key);
          }
        }
        this.logger.info(`debug session terminated: ${session.name}`);
        this.changeEmitter.fire();
      }),
      vscode.debug.onDidChangeActiveDebugSession(() => this.changeEmitter.fire()),
      vscode.debug.onDidChangeActiveStackItem(() => this.changeEmitter.fire())
    );

    const active = vscode.debug.activeDebugSession;
    if (active) {
      this.knownSessions.set(active.id, active);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.changeEmitter.dispose();
  }

  /** Live sessions ordered with the active one first. */
  get sessions(): readonly vscode.DebugSession[] {
    const active = vscode.debug.activeDebugSession;
    const all = [...this.knownSessions.values()];
    if (active) {
      return [active, ...all.filter((session) => session.id !== active.id)];
    }
    return all;
  }

  activeSession(): vscode.DebugSession | undefined {
    return vscode.debug.activeDebugSession ?? this.sessions[0];
  }

  sessionById(id: string | undefined): vscode.DebugSession | undefined {
    if (!id) {
      return undefined;
    }
    return this.knownSessions.get(id) ?? this.sessions.find((session) => session.id === id);
  }

  /** Returns the DAP client of a session, creating it on first use. */
  clientFor(session: vscode.DebugSession): DapClient {
    const existing = this.clients.get(session.id);
    if (existing) {
      return existing;
    }
    const client = new DapClient(
      (command, args) => session.customRequest(command, args),
      this.logger,
      session.id
    );
    this.clients.set(session.id, client);
    return client;
  }

  /** Helper loading state for one session and provider pair. */
  helperStateFor(session: vscode.DebugSession, provider: LanguageProvider): SessionHelperState {
    const key = `${session.id}:${provider.id}`;
    const existing = this.helperStates.get(key);
    if (existing) {
      return existing;
    }
    const created: SessionHelperState = { attempted: false, loaded: false };
    this.helperStates.set(key, created);
    return created;
  }

  /** Describes the sessions handled by the bundled providers. */
  describeSessions(settings: ExtensionSettings): SessionInfo[] {
    return this.sessions.map((session) => {
      const { provider } = this.describeContextSync(session, settings);
      return {
        id: session.id,
        name: session.name,
        type: session.type,
        workspaceFolder: session.workspaceFolder?.name,
        language: provider?.language ?? 'unknown',
        providerId: provider?.id ?? 'unknown',
        supported: provider !== undefined
      };
    });
  }

  /**
   * Fully resolves a session: provider, frame id, helper state and settings.
   * Frame information comes from the active stack item without a round trip and
   * only falls back to a `stackTrace` request when nothing is active.
   */
  async resolve(session: vscode.DebugSession): Promise<SessionContext | undefined> {
    const settings = readSettings();
    const hints = this.activeFrameHints(session);

    // The active stack item carries the frame id but no source, and the source is
    // what tells the providers (and the Explore affordances) which file is on
    // screen, so it is fetched from the adapter unless a debug document named it.
    let frameId = hints.frameId;
    let sourcePath = hints.sourcePath;
    let frameLine: number | undefined;
    if (frameId === undefined || sourcePath === undefined) {
      const located = await this.frameInfo(session, hints.threadId, hints.frameId, settings);
      if (located) {
        frameId ??= located.frameId;
        sourcePath ??= located.sourcePath;
        frameLine = located.line;
      }
    }

    const provider = this.providers.resolve({
      debugType: session.type,
      stoppedLanguageId: hints.stoppedLanguageId,
      sourcePath,
      editorLanguageId: hints.editorLanguageId,
      customTypes: settings.customDebugTypes
    });

    if (!provider) {
      this.logger.warn(
        `no provider matched session '${session.name}' (type=${session.type}, stopped=${hints.stoppedLanguageId ?? sourcePath ?? 'unknown'})`
      );
      return undefined;
    }

    return {
      session,
      client: this.clientFor(session),
      provider,
      frameId,
      sourcePath,
      frameLine,
      editorLanguageId: hints.editorLanguageId,
      helperState: this.helperStateFor(session, provider),
      settings
    };
  }

  /** Resolves only the provider, without any asynchronous work. */
  describeContextSync(
    session: vscode.DebugSession,
    settings: ExtensionSettings
  ): { provider: LanguageProvider | undefined; match: ProviderMatchContext } {
    const hints = this.activeFrameHints(session);
    const match: ProviderMatchContext = {
      debugType: session.type,
      stoppedLanguageId: hints.stoppedLanguageId,
      sourcePath: hints.sourcePath,
      editorLanguageId: hints.editorLanguageId,
      customTypes: settings.customDebugTypes
    };
    return { provider: this.providers.resolve(match), match };
  }

  /**
   * Frame hints read from the active stack item and the active editor.
   *
   * A `debug:` document is the file the debugger stopped in, so its language is
   * authoritative. A regular `file:` document is only the focused editor, which
   * may be unrelated to the session, so it is reported as a hint.
   */
  private activeFrameHints(session: vscode.DebugSession): {
    frameId?: number;
    threadId?: number;
    sourcePath?: string;
    stoppedLanguageId?: string;
    editorLanguageId?: string;
  } {
    const result: {
      frameId?: number;
      threadId?: number;
      sourcePath?: string;
      stoppedLanguageId?: string;
      editorLanguageId?: string;
    } = {};

    const stackItem = vscode.debug.activeStackItem;
    if (stackItem && stackItem.session.id === session.id) {
      result.threadId = stackItem.threadId;
      if ('frameId' in stackItem) {
        result.frameId = (stackItem as { frameId: number }).frameId;
      }
    }

    const document = vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme === 'debug') {
      result.sourcePath = document.uri.fsPath || document.uri.path;
      result.stoppedLanguageId = document.languageId;
    } else if (document?.uri.scheme === 'file') {
      result.editorLanguageId = document.languageId;
    }

    return result;
  }

  /**
   * Asks the adapter for the source of a frame.
   *
   * `vscode.DebugStackFrame` exposes the frame id but not the file or the line,
   * so the frame has to be resolved over DAP. Results are cached per frame, which
   * keeps the CodeLens and hover providers cheap.
   */
  private async frameInfo(
    session: vscode.DebugSession,
    threadId: number | undefined,
    frameId: number | undefined,
    settings: ExtensionSettings
  ): Promise<{ frameId: number; sourcePath?: string; line?: number } | undefined> {
    const cacheKey = frameId === undefined ? undefined : `${session.id}:${threadId ?? '-'}:${frameId}`;
    const cached = cacheKey === undefined ? undefined : this.frameInfos.get(cacheKey);
    if (cached && cached.expires > Date.now() && frameId !== undefined) {
      return { frameId, sourcePath: cached.sourcePath, line: cached.line };
    }

    const client = this.clientFor(session);
    const dapOptions = { timeoutMs: Math.min(settings.timeoutMs, 10000) };
    try {
      const threads =
        threadId === undefined
          ? await client.threads(dapOptions)
          : [{ id: threadId, name: '' }];
      for (const thread of threads) {
        const frames = await client.stackTrace(thread.id, { ...dapOptions, levels: 64 });
        const match =
          frameId === undefined ? frames[0] : frames.find((candidate) => candidate.id === frameId);
        if (!match) {
          continue;
        }
        const sourcePath = match.source?.path ?? match.source?.name;
        if (cacheKey !== undefined) {
          this.frameInfos.set(cacheKey, {
            sourcePath,
            line: match.line,
            expires: Date.now() + 2000
          });
        }
        return { frameId: match.id, sourcePath, line: match.line };
      }
    } catch (error) {
      this.logger.debug(`could not locate a stack frame in session ${session.id}: ${formatError(error)}`);
      this.record(`stack frame lookup failed in ${session.name}: ${formatError(error)}`);
    }
    return undefined;
  }

  /** Records a line in the diagnostics report of the logger, when it supports it. */
  private record(line: string): void {
    (this.logger as Logger & { record?: (line: string) => void }).record?.(line);
  }

  /** Capture options derived from the settings. */
  captureOptions(settings: ExtensionSettings, token?: { isCancellationRequested: boolean }): CaptureOptions {
    return {
      maxRows: settings.maxRows,
      captureBudgetMs: settings.captureBudgetMs,
      maxDepth: settings.maxDepth,
      concurrency: settings.fetchConcurrency,
      timeoutMs: settings.timeoutMs,
      dictionariesAsRows: settings.dictionariesAsRows,
      excludedMembers: settings.excludedMembers,
      token
    };
  }

  /** Helper resolution options for provider expression building. */
  helperOptions(provider: LanguageProvider): HelperOptions {
    const settings = readSettings();
    return {
      depth: Math.max(2, Math.min(8, settings.maxDepth + 2)),
      helperPath: (relative) => this.helperUri(relative)?.fsPath,
      readHelper: (relative) => this.readHelperSource(relative, provider)
    };
  }

  private helperUri(relative: string): vscode.Uri | undefined {
    if (relative.length === 0) {
      return undefined;
    }
    return vscode.Uri.joinPath(this.extensionUri, 'helpers', ...relative.split('/'));
  }

  private readHelperSource(relative: string, provider: LanguageProvider): string | undefined {
    if (helperRelativePath(provider.id) !== relative) {
      return undefined;
    }
    const uri = this.helperUri(relative);
    if (!uri) {
      return undefined;
    }
    try {
      return readFileSync(uri.fsPath, 'utf8');
    } catch (error) {
      this.logger.debug(`helper source '${relative}' is not readable: ${formatError(error)}`);
      return undefined;
    }
  }

  /** Builds a walk root from a variable object coming from a menu command. */
  walkRootFor(variable: Partial<AdapterVariable>): WalkRoot {
    return toWalkRoot({
      name: variable.name ?? 'value',
      value: variable.value ?? '',
      type: variable.type,
      variablesReference: variable.variablesReference ?? 0,
      evaluateName: variable.evaluateName,
      indexedVariables: variable.indexedVariables,
      namedVariables: variable.namedVariables
    });
  }
}
