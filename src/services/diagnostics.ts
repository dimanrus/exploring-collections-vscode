import * as vscode from 'vscode';
import type { CollectionController } from './controller';
import type { DebugSessionRegistry } from '../debug/sessionRegistry';
import type { FrameCollectionIndex } from './frameCollections';
import type { SnapshotStore } from '../state/snapshotStore';
import type { ExtensionLogger } from './logger';
import { readSettings } from './config';
import {
  identifierVariants,
  lineOf,
  resolveOwnerLine,
  sameDocument
} from './codeLens';
import { INDEX_COLUMN_KEY } from '../util/types';

export interface DiagnosticsDependencies {
  controller: CollectionController;
  sessions: DebugSessionRegistry;
  store: SnapshotStore;
  logger: ExtensionLogger;
  extensionVersion: string;
  /** Optional so the report can still be built without a live frame lookup. */
  collections?: FrameCollectionIndex;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return `_${vscode.l10n.t('none')}_`;
  }
  const header = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

/**
 * Collections the extension currently sees in the stopped frame.
 *
 * This is the list behind the Explore CodeLens, the hover link and the inline
 * hint, so reporting it is the fastest way to explain a missing affordance.
 */
async function frameCollectionRows(
  deps: DiagnosticsDependencies
): Promise<(readonly string[])[]> {
  try {
    const entries = (await deps.collections?.forActiveFrame()) ?? [];
    return entries.map((entry) => [
      entry.name,
      `\`${entry.expression}\``,
      entry.typeName ?? entry.classification,
      String(entry.elementCount)
    ]);
  } catch {
    return [];
  }
}

/**
 * Where the Explore lenses of the stopped frame are attached.
 *
 * The lenses are the only inline affordance the extension has, so a user whose
 * lenses are missing gets the exact reason here: the identifier is not part of
 * the stopped file, the document could not be read, or the editor has CodeLens
 * switched off.
 */
async function codeLensRows(deps: DiagnosticsDependencies): Promise<(readonly string[])[]> {
  const session = deps.sessions.activeSession();
  if (!session) {
    return [];
  }
  try {
    const context = await deps.sessions.resolve(session);
    if (!context?.sourcePath) {
      return [];
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(context.sourcePath));
    const lines = document.getText().split('\n');
    const stopped = lineOf(document, context.frameLine);
    const entries = (await deps.collections?.forFrame(session, context.frameId ?? 0)) ?? [];
    return entries.map((entry) => {
      const placement = resolveOwnerLine(lines, identifierVariants(entry), stopped);
      const anchor =
        placement.anchor === 'declaration'
          ? vscode.l10n.t('declaration')
          : placement.anchor === 'mention'
            ? vscode.l10n.t('first usage above the stop line')
            : placement.anchor === 'after'
              ? vscode.l10n.t('below the stop line')
              : placement.anchor === 'scope'
                ? vscode.l10n.t('the identifier is not part of this file, so the enclosing scope is used')
                : vscode.l10n.t('the stop line (the document was not recognised)');
      return [
        entry.name,
        `\`${entry.expression}\``,
        String(placement.line + 1),
        anchor,
        sameDocument(document, context.sourcePath) ? '✅' : '❌'
      ];
    });
  } catch {
    return [];
  }
}

/** Builds the Markdown diagnostics report. */
export async function buildDiagnosticsReport(deps: DiagnosticsDependencies): Promise<string> {
  const settings = readSettings();
  const sessions = deps.sessions.describeSessions(settings);
  const snapshots = [...deps.store.pinned, ...deps.store.recent].map((record) => record.snapshot);

  const lines: string[] = [];
  lines.push('# Exploring Collections — Diagnostics');
  lines.push('');
  lines.push(`- ${vscode.l10n.t('Extension version')}: \`${deps.extensionVersion}\``);
  lines.push(`- VS Code: \`${vscode.version}\``);
  lines.push(`- Platform: \`${process.platform} ${process.arch}\``);
  lines.push(`- Node: \`${process.version}\``);
  lines.push(`- ${vscode.l10n.t('Collection panels open')}: \`${deps.store.currentSnapshot ? 'yes' : 'no'}\``);
  lines.push('');

  lines.push('## Settings');
  lines.push('');
  lines.push(
    table(
      [vscode.l10n.t('Setting'), vscode.l10n.t('Value')],
      [
        ['maxRows', String(settings.maxRows)],
        ['captureBudgetMs', String(settings.captureBudgetMs)],
        ['pageSize', String(settings.pageSize)],
        ['maxDepth', String(settings.maxDepth)],
        ['fetchConcurrency', String(settings.fetchConcurrency)],
        ['timeoutMs', String(settings.timeoutMs)],
        ['enableLanguageHelpers', String(settings.enableLanguageHelpers)],
        ['enableFilterPushdown', String(settings.enableFilterPushdown)],
        ['enableCharts', String(settings.enableCharts)],
        ['dateFormat', settings.dateFormat],
        ['columnOrder', settings.columnOrder],
        ['dictionariesAsRows', String(settings.dictionariesAsRows)],
        ['excludedMembers', settings.excludedMembers.join(', ') || '—'],
        [
          'customDebugTypes',
          Object.entries(settings.customDebugTypes)
            .map(([key, value]) => `${key}→${value}`)
            .join(', ') || '—'
        ]
      ]
    )
  );
  lines.push('');

  lines.push('## Language providers');
  lines.push('');
  lines.push(
    table(
      [vscode.l10n.t('Provider'), vscode.l10n.t('Language'), vscode.l10n.t('Debug types'), vscode.l10n.t('Notes')],
      deps.controller.providerList.map((provider) => [
        `${provider.displayName} (\`${provider.id}\`)`,
        provider.id,
        provider.debugTypes.join(', '),
        provider.notes.join(' ')
      ])
    )
  );
  lines.push('');

  lines.push('## Debug sessions');
  lines.push('');
  lines.push(
    table(
      [vscode.l10n.t('Name'), vscode.l10n.t('Debug type'), vscode.l10n.t('Provider'), vscode.l10n.t('Supported')],
      sessions.map((session) => [
        session.name,
        session.type,
        session.providerId,
        session.supported ? '✅' : '❌'
      ])
    )
  );
  lines.push('');

  lines.push('## Captured collections');
  lines.push('');
  lines.push(
    table(
      [vscode.l10n.t('Title'), vscode.l10n.t('Provider'), vscode.l10n.t('Strategy'), 'Rows', 'Total', 'ms', 'Requests'],
      snapshots.map((snapshot) => [
        snapshot.title,
        snapshot.providerId,
        snapshot.diagnostics.strategy,
        String(snapshot.rows.length),
        String(snapshot.totalItems ?? '—'),
        String(snapshot.diagnostics.durationMs),
        String(snapshot.diagnostics.requests)
      ])
    )
  );
  lines.push('');

  for (const snapshot of snapshots) {
    const notes = [...snapshot.warnings, ...snapshot.diagnostics.notes, ...snapshot.diagnostics.fallbackReasons];
    if (notes.length === 0) {
      continue;
    }
    lines.push(`### ${snapshot.title}`);
    lines.push('');
    lines.push(`- ${vscode.l10n.t('Expression')}: \`${snapshot.expression}\``);
    lines.push(
      `- ${vscode.l10n.t('Columns')}: ${snapshot.columns.filter((column) => column.key !== INDEX_COLUMN_KEY).length}`
    );
    for (const note of notes) {
      lines.push(`- ⚠ ${note}`);
    }
    lines.push('');
  }

  lines.push('## Collections in the current frame');
  lines.push('');
  lines.push(
    table(
      [vscode.l10n.t('Variable'), vscode.l10n.t('Expression'), vscode.l10n.t('Type'), vscode.l10n.t('Elements')],
      await frameCollectionRows(deps)
    )
  );
  lines.push('');

  lines.push('## Explore code lens');
  lines.push('');
  lines.push(
    `- ${vscode.l10n.t('exploringCollections.showCodeLens')}: \`${String(settings.showCodeLens)}\``
  );
  lines.push(
    `- ${vscode.l10n.t('editor.codeLens')}: \`${String(
      vscode.workspace.getConfiguration('editor').get<boolean>('codeLens', true)
    )}\``
  );
  lines.push(
    `- ${vscode.l10n.t('exploringCollections.showDesignTimePreview')}: \`${String(
      settings.showDesignTimePreview
    )}\``
  );
  lines.push('');
  lines.push(
    table(
      [
        vscode.l10n.t('Variable'),
        vscode.l10n.t('Expression'),
        vscode.l10n.t('Lens line'),
        vscode.l10n.t('Placed at'),
        vscode.l10n.t('Stopped file')
      ],
      await codeLensRows(deps)
    )
  );
  lines.push('');

  lines.push('## Recent log');
  lines.push('');
  lines.push('```text');
  lines.push(...deps.logger.diagnosticsLines.slice(-80));
  lines.push('```');

  return lines.join('\n');
}

/** Opens the diagnostics report in an untitled Markdown document. */
export async function showDiagnosticsReport(deps: DiagnosticsDependencies): Promise<void> {
  const report = await buildDiagnosticsReport(deps);
  const document = await vscode.workspace.openTextDocument({
    content: report,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(document, { preview: false });
}
