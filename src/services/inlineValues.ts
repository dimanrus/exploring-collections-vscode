import * as vscode from 'vscode';
import type { DebugSessionRegistry } from '../debug/sessionRegistry';
import type { FrameCollectionIndex } from './frameCollections';
import { readSettings } from './config';
import { localize } from './i18n';
import type { Logger } from '../util/logging';

/** Documents this provider is registered for. */
export const INLINE_HINT_LANGUAGES = [
  'csharp',
  'fsharp',
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact'
];

/**
 * Renders a one line hint next to the statement the debugger stopped at,
 * listing the collection variables of the current frame. It is the closest
 * equivalent of the "Explore" affordance a debugger visualizer offers.
 */
export class CollectionInlineValuesProvider implements vscode.InlineValuesProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeInlineValues = this.emitter.event;

  constructor(
    private readonly sessions: DebugSessionRegistry,
    private readonly collections: FrameCollectionIndex,
    private readonly logger: Logger
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  async provideInlineValues(
    document: vscode.TextDocument,
    _viewPort: vscode.Range,
    context: vscode.InlineValueContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineValue[] | undefined> {
    const settings = readSettings();
    if (!settings.showInlineHints || token.isCancellationRequested) {
      return undefined;
    }

    const session = this.sessions.activeSession();
    if (!session || context.frameId === undefined) {
      return undefined;
    }

    const hint = await this.hintFor(session, context.frameId, document, token);
    if (!hint) {
      return undefined;
    }

    const line = context.stoppedLocation.start.line;
    const range = new vscode.Range(line, 0, line, 0);
    return [new vscode.InlineValueText(range, hint)];
  }

  private async hintFor(
    session: vscode.DebugSession,
    frameId: number,
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const provider = this.sessions.describeContextSync(session, readSettings()).provider;
    if (!provider || !provider.editorLanguages.includes(document.languageId)) {
      return undefined;
    }

    try {
      const collections = await this.collections.forFrame(session, frameId, token);
      if (collections.length === 0) {
        return undefined;
      }
      const summary = collections
        .slice(0, 4)
        .map((entry) => `${entry.name} (${entry.elementCount.toLocaleString()})`)
        .join(', ');
      return `🔍 ${summary} · ${localize('explore with Ctrl+Alt+E')}`;
    } catch (error) {
      this.logger.debug(`inline hint lookup failed: ${String(error)}`);
      return undefined;
    }
  }

  /** Asks the editor to recompute the hints. */
  invalidate(): void {
    this.emitter.fire();
  }
}
