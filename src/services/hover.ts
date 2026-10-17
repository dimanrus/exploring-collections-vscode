import * as vscode from 'vscode';

import type { DebugSessionRegistry } from '../debug/sessionRegistry';
import { readSettings } from './config';
import { localize } from './i18n';
import { exploreCommandUri, type FrameCollectionIndex } from './frameCollections';
import { sameDocument } from './codeLens';
import { INLINE_HINT_LANGUAGES } from './inlineValues';
import { formatError, type Logger } from '../util/logging';

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Adds an "Explore collection" link to the tooltip of a collection variable.
 *
 * Visual Studio Code shows the debug adapter's own hover on top of extension
 * hovers, so this provider is the polite one in the room: it contributes its
 * section without ever replacing what the debugger reports.
 */
export class CollectionHoverProvider implements vscode.HoverProvider {
  private lastNote: string | undefined;

  constructor(
    private readonly sessions: DebugSessionRegistry,
    private readonly collections: FrameCollectionIndex,
    private readonly logger: Logger & { record?: (line: string) => void }
  ) {}

  /** Notes a decision in the diagnostics report, but only when it changes. */
  private record(line: string): void {
    if (this.lastNote === line) {
      return;
    }
    this.lastNote = line;
    this.logger.record?.(line);
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const settings = readSettings();
    if (!settings.showHoverLinks) {
      return undefined;
    }
    if (token.isCancellationRequested) {
      this.record('hover: the editor cancelled the request');
      return undefined;
    }

    const range = document.getWordRangeAtPosition(position, WORD);
    if (!range) {
      return undefined;
    }
    const name = document.getText(range);

    const session = this.sessions.activeSession();
    if (!session) {
      this.record(`hover: no debug session for ${document.uri.toString()}`);
      return undefined;
    }

    try {
      const context = await this.sessions.resolve(session);
      if (!context || context.frameId === undefined) {
        this.record('hover: no stopped frame');
        return undefined;
      }
      if (!sameDocument(document, context.sourcePath)) {
        return undefined;
      }

      const collections = await this.collections.forFrame(session, context.frameId, token);
      const entry = collections.find(
        (candidate) => candidate.name === name || candidate.expression === name
      );
      if (!entry) {
        this.record(`hover: '${name}' is not a collection (${collections.map((c) => c.name).join(', ') || 'none'})`);
        return undefined;
      }
      this.record(`hover: offering the viewer for '${name}'`);

      const markdown = new vscode.MarkdownString(undefined, true);
      markdown.supportThemeIcons = true;
      // Only our own command may be invoked from this markdown.
      markdown.isTrusted = { enabledCommands: ['exploringCollections.explore'] };
      markdown.appendMarkdown(`**${entry.name}** — \`${entry.typeName ?? entry.classification}\``);
      markdown.appendMarkdown(` · ${entry.elementCount.toLocaleString()}\n\n`);
      markdown.appendMarkdown(
        `$(search) [${localize('Explore collection')}](${exploreCommandUri(session.id, entry)})\n\n`
      );
      if (entry.preview.length > 0 && entry.preview.length <= 120) {
        markdown.appendCodeblock(entry.preview, 'text');
      }

      return new vscode.Hover(markdown, range);
    } catch (error) {
      this.logger.debug(`hover lookup failed: ${formatError(error)}`);
      return undefined;
    }
  }
}

/** Languages whose documents the provider is registered for. */
export const HOVER_LANGUAGES = INLINE_HINT_LANGUAGES;
