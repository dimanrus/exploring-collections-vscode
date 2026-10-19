import * as vscode from 'vscode';
import type { AdapterVariable, CollectionSnapshot, ValueNode } from '../model/types';
import { analyzeAdapterText } from '../model/formatter';
import { classifyAdapterVariable } from '../model/valueKind';
import { captureCollection, filterCollection, type FilterOutcome } from '../providers/capturer';
import type { WalkRoot } from '../providers/variablesWalk';
import type { DebugSessionRegistry, SessionContext } from '../debug/sessionRegistry';
import type { LanguageProviderRegistry } from '../providers/languageProvider';
import type { SnapshotStore } from '../state/snapshotStore';
import { layoutFromSettings, readSettings } from './config';
import { filterLiteralSnapshot, findLiteralCollections, snapshotFromLiteral } from './literalPreview';
import type { Logger } from '../util/logging';
import { formatError } from '../util/logging';
import { mapPool } from '../util/asyncPool';

/** Description of a variable that can be explored. */
export interface VariableCandidate {
  label: string;
  description: string;
  detail: string;
  expression: string;
  root: WalkRoot;
  frameId?: number;
}

export interface ExploreTarget {
  sessionId?: string;
  variable?: Partial<AdapterVariable>;
  expression?: string;
  title?: string;
}

/** Orchestrates capture, filtering and lazy value retrieval. */
export class CollectionController {
  constructor(
    private readonly sessions: DebugSessionRegistry,
    private readonly providers: LanguageProviderRegistry,
    private readonly store: SnapshotStore,
    private readonly logger: Logger
  ) {}

  /** Human readable provider name used by the UI. */
  providerDisplayName(snapshot: CollectionSnapshot): string {
    return this.providers.byId(snapshot.providerId)?.displayName ?? snapshot.providerId;
  }

  /** All providers, used by the diagnostics report. */
  get providerList(): readonly { id: string; displayName: string; debugTypes: readonly string[]; notes: readonly string[] }[] {
    return this.providers.all().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      debugTypes: provider.debugTypes,
      notes: provider.notes
    }));
  }

  /** Resolves the session to use, honouring an explicit session id. */
  async resolveSession(sessionId?: string): Promise<SessionContext | undefined> {
    const session = sessionId ? this.sessions.sessionById(sessionId) : this.sessions.activeSession();
    if (!session) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Start a debug session and stop at a breakpoint to explore collections.')
      );
      return undefined;
    }
    const context = await this.sessions.resolve(session);
    if (!context) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'The debug type "{0}" is not supported by Exploring Collections.',
          session.type
        )
      );
      return undefined;
    }
    return context;
  }

  /** Captures a collection and registers it as the current snapshot. */
  async capture(
    target: ExploreTarget,
    token?: vscode.CancellationToken,
    onProgress?: (rows: number, total: number) => void
  ): Promise<CollectionSnapshot | undefined> {
    const context = await this.resolveSession(target.sessionId);
    if (!context) {
      return undefined;
    }

    const expression = target.variable?.evaluateName ?? target.expression ?? target.variable?.name;
    if (!expression) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('This variable cannot be evaluated in the current frame.')
      );
      return undefined;
    }

    const root: WalkRoot = target.variable
      ? this.sessions.walkRootFor(target.variable)
      : { name: target.title ?? expression, variablesReference: 0, evaluateName: expression };

    const settings = context.settings;
    const started = Date.now();
    this.logger.info(
      `capturing '${expression}' with provider '${context.provider.id}' in session '${context.session.name}'`
    );

    try {
      const snapshot = await captureCollection({
        client: context.client,
        provider: context.provider,
        session: {
          id: context.session.id,
          name: context.session.name,
          debugType: context.session.type
        },
        title: target.title ?? target.variable?.name ?? expression,
        source: expression,
        root,
        frameId: context.frameId,
        options: this.sessions.captureOptions(settings, token),
        formatOptions: {
          dateFormat: settings.dateFormat,
          maxCellLength: 512,
          emptyStringAsNull: false
        },
        layout: layoutFromSettings(settings),
        helperOptions: this.sessions.helperOptions(context.provider),
        helperState: context.helperState,
        logger: this.logger,
        requestBudget: Math.max(5000, settings.maxRows * 2),
        onProgress
      });

      this.logger.info(
        `captured ${snapshot.rows.length} rows via ${snapshot.diagnostics.strategy} in ${Date.now() - started} ms (${snapshot.diagnostics.requests} requests)`
      );
      this.store.setCurrent(snapshot);
      return snapshot;
    } catch (error) {
      this.logger.error(`capture failed for '${expression}'`, error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not read the collection: {0}', formatError(error))
      );
      return undefined;
    }
  }

  /** Recaptures a snapshot using the same expression. */
  async refresh(
    snapshot: CollectionSnapshot,
    token?: vscode.CancellationToken
  ): Promise<CollectionSnapshot | undefined> {
    if (snapshot.source?.kind === 'source-literal') {
      return this.refreshLiteral(snapshot);
    }
    return this.capture(
      { sessionId: snapshot.sessionId, expression: snapshot.expression, title: snapshot.title },
      token
    );
  }

  /**
   * Re-reads a snapshot that came from the source text.
   *
   * This is what makes the design time viewer usable while editing: change the
   * literal, press refresh, and the table shows the new data.
   */
  private async refreshLiteral(
    snapshot: CollectionSnapshot
  ): Promise<CollectionSnapshot | undefined> {
    const source = snapshot.source;
    if (!source) {
      return undefined;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.uri));
      const literals = findLiteralCollections(document.getText(), document.languageId);
      const literal =
        literals.find((entry) => entry.line === source.line) ??
        literals.find((entry) => entry.name === snapshot.expression);
      if (!literal) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'The data that was read from {0} is no longer there.',
            document.uri.fsPath || document.fileName
          )
        );
        return undefined;
      }
      const settings = readSettings();
      const refreshed = snapshotFromLiteral(literal, snapshot.title, {
        formatOptions: {
          dateFormat: settings.dateFormat,
          maxCellLength: 512,
          emptyStringAsNull: false
        },
        columnOrder: layoutFromSettings(settings).columnOrder,
        flattenDepth: layoutFromSettings(settings).flattenDepth,
        uri: document.uri.toString(),
        sessionId: snapshot.sessionId,
        language: document.languageId,
        notes: snapshot.diagnostics.notes
      });
      this.store.setCurrent(refreshed);
      this.logger.info(`re-read '${snapshot.title}' from ${document.uri.fsPath}: ${refreshed.rows.length} row(s)`);
      return refreshed;
    } catch (error) {
      this.logger.error(`could not re-read '${snapshot.title}' from source`, error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not read the collection: {0}', formatError(error))
      );
      return undefined;
    }
  }

  /** Applies a filter to a snapshot. */
  async filter(snapshot: CollectionSnapshot, filterText: string): Promise<FilterOutcome | undefined> {
    if (filterText.trim().length === 0) {
      return undefined;
    }
    if (snapshot.source?.kind === 'source-literal') {
      return filterLiteralSnapshot(snapshot, filterText);
    }
    const session = this.sessions.sessionById(snapshot.sessionId);
    const context = session ? await this.sessions.resolve(session) : undefined;
    if (!context) {
      throw new Error(vscode.l10n.t('The debug session for this collection is no longer active.'));
    }
    return filterCollection({
      client: context.client,
      provider: context.provider,
      snapshot,
      filterText,
      frameId: context.frameId,
      options: this.sessions.captureOptions(context.settings),
      formatOptions: {
        dateFormat: context.settings.dateFormat,
        maxCellLength: 512,
        emptyStringAsNull: false
      },
      helperOptions: this.sessions.helperOptions(context.provider),
      helperState: context.helperState,
      layout: layoutFromSettings(context.settings),
      logger: this.logger
    });
  }

  /** Loads the children of a variables reference for the value pane. */
  async valueChildren(variablesReference: number): Promise<ValueNode[]> {
    const context = this.sessions.sessions.length > 0 ? await this.resolveSession(undefined) : undefined;
    if (!context) {
      throw new Error(vscode.l10n.t('No active debug session.'));
    }
    const children = await context.client.variables(
      { reference: variablesReference },
      { timeoutMs: context.settings.timeoutMs }
    );
    return children.map((child) => this.toValueNode(child));
  }

  private toValueNode(variable: AdapterVariable): ValueNode {
    const analyzed = analyzeAdapterText(variable.value, variable.type);
    return {
      name: variable.name,
      value: analyzed.text.length > 0 ? analyzed.text : variable.value,
      kind: analyzed.kind,
      typeName: variable.type,
      variablesReference: variable.variablesReference || undefined,
      evaluateName: variable.evaluateName,
      childCount: (variable.indexedVariables ?? 0) + (variable.namedVariables ?? 0) || undefined,
      lazy: variable.variablesReference > 0
    };
  }

  /**
   * Enumerates the variables of the current frame that look like collections,
   * used by the command palette entry point.
   */
  async listCandidates(sessionId?: string): Promise<VariableCandidate[]> {
    const context = await this.resolveSession(sessionId);
    if (!context) {
      return [];
    }
    if (context.frameId === undefined) {
      return [];
    }
    const frameId = context.frameId;

    const client = context.client;
    const dapOptions = { timeoutMs: Math.min(context.settings.timeoutMs, 8000) };
    const scopes = await client.scopes(context.frameId, dapOptions);
    const candidates: VariableCandidate[] = [];

    for (const scope of scopes) {
      if (scope.expensive) {
        continue;
      }
      const variables = await client.variables({ reference: scope.variablesReference }, dapOptions);
      const nested = await mapPool(
        variables,
        context.settings.fetchConcurrency,
        async (variable) => {
          if (variable.variablesReference <= 0) {
            return [];
          }
          const classification = classifyAdapterVariable(variable);
          if (classification === 'leaf') {
            return [];
          }
          const children = await client.variables(
            { reference: variable.variablesReference, start: 0, count: 400 },
            dapOptions
          );
          return children
            .filter((child) => {
              const childClassification = classifyAdapterVariable(child);
              return childClassification !== 'leaf' || child.variablesReference > 0;
            })
            .map((child) => this.toCandidate(scope.name, child, frameId));
        },
        { token: undefined, fallback: () => [] as VariableCandidate[] }
      );
      candidates.push(...nested.flat());
    }

    const deduped = new Map<string, VariableCandidate>();
    for (const candidate of candidates) {
      if (!deduped.has(candidate.expression)) {
        deduped.set(candidate.expression, candidate);
      }
    }
    return [...deduped.values()];
  }

  private toCandidate(scopeName: string, variable: AdapterVariable, frameId: number): VariableCandidate {
    const analyzed = analyzeAdapterText(variable.value, variable.type);
    const count = (variable.indexedVariables ?? 0) + (variable.namedVariables ?? 0);
    return {
      label: variable.name,
      description: variable.type ?? analyzed.kind,
      detail: `${scopeName} · ${count.toLocaleString()} child elements`,
      expression: variable.evaluateName ?? variable.name,
      frameId,
      root: this.sessions.walkRootFor(variable)
    };
  }

  /** Clears the stored snapshots; used by the tree view. */
  forget(snapshotId: string): void {
    this.store.remove(snapshotId);
  }
}
