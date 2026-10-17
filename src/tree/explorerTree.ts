import * as vscode from 'vscode';
import type { CollectionSnapshot } from '../model/types';
import type { DebugSessionRegistry } from '../debug/sessionRegistry';
import type { SessionInfo } from '../model/types';
import type { SnapshotRecord, SnapshotStore } from '../state/snapshotStore';
import { readSettings } from '../services/config';
import { localize } from '../services/i18n';
import { exploreArgumentFor, type FrameCollectionIndex } from '../services/frameCollections';
import { INDEX_COLUMN_KEY } from '../util/types';

export type ExplorerNodeKind = 'group' | 'session' | 'collection' | 'snapshot' | 'message';

/** One node of the "Exploring Collections" activity bar view. */
export class ExplorerNode extends vscode.TreeItem {
  constructor(
    readonly kind: ExplorerNodeKind,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly children: ExplorerNode[] = [],
    readonly snapshot?: CollectionSnapshot,
    sessionId?: string
  ) {
    super(label, collapsible);
    this.sessionId = sessionId;
  }

  /** Owning debug session of a session or collection node. */
  sessionId?: string;
}

function summarize(snapshot: CollectionSnapshot): string {
  const total = snapshot.totalItems ?? snapshot.rows.length;
  const columns = snapshot.columns.filter((column) => column.key !== INDEX_COLUMN_KEY).length;
  return `${total.toLocaleString()} ${total === 1 ? 'element' : 'elements'} · ${columns} ${
    columns === 1 ? 'column' : 'columns'
  }`;
}

/** Tree data provider backing the "Collections" activity bar view. */
export class CollectionsTreeProvider
  implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<ExplorerNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly sessions: DebugSessionRegistry,
    private readonly store: SnapshotStore,
    private readonly collections: FrameCollectionIndex
  ) {
    this.disposables.push(
      this.sessions.onDidChange(() => this.refresh()),
      this.store.onDidChange(() => this.refresh()),
      this.collections.onDidChange(() => this.refresh())
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> | ExplorerNode[] {
    if (!element) {
      return this.rootNodes();
    }
    if (element.kind === 'session' && element.sessionId) {
      return this.collectionNodes(element);
    }
    return element.children;
  }

  /**
   * Lists the collections that are in scope in the stopped frame, so the view
   * shows collections rather than debug sessions alone.
   */
  private async collectionNodes(session: ExplorerNode): Promise<ExplorerNode[]> {
    const debugSession = this.sessions.sessionById(session.sessionId);
    if (!debugSession) {
      return [this.messageNode(localize('The debug session has ended.'))];
    }
    try {
      const context = await this.sessions.resolve(debugSession);
      if (!context?.provider) {
        return [this.messageNode(localize('This debug type is not supported yet.'))];
      }
      if (context.frameId === undefined) {
        return [this.messageNode(localize('Run the program to a breakpoint to list its collections.'))];
      }
      const collections = await this.collections.forFrame(debugSession, context.frameId);
      if (collections.length === 0) {
        return [this.messageNode(localize('No collections in the current frame.'))];
      }
      return collections.map((entry) => {
        const node = new ExplorerNode(
          'collection',
          entry.name,
          vscode.TreeItemCollapsibleState.None
        );
        node.id = `exploringCollections.collection.${debugSession.id}.${entry.expression}`;
        const size = entry.elementCount > 0 ? `${entry.elementCount.toLocaleString()} · ` : '';
        node.description = `${size}${entry.typeName ?? entry.classification}`;
        node.tooltip = new vscode.MarkdownString(
          [
            `**${entry.name}**`,
            '',
            '```',
            entry.expression,
            '```',
            entry.preview.length > 0 ? `- ${localize('Value')}: \`${entry.preview}\`` : ''
          ]
            .filter((line) => line.length > 0)
            .join('\n')
        );
        node.contextValue = 'exploringCollections.collection';
        node.iconPath = new vscode.ThemeIcon(entry.classification === 'map' ? 'symbol-key' : 'symbol-array');
        node.command = {
          command: 'exploringCollections.explore',
          title: localize('Explore collection'),
          arguments: [exploreArgumentFor(debugSession.id, entry)]
        };
        return node;
      });
    } catch {
      return [this.messageNode(localize('Could not read the collections of this frame.'))];
    }
  }

  private messageNode(label: string): ExplorerNode {
    const node = new ExplorerNode('message', label, vscode.TreeItemCollapsibleState.None);
    node.contextValue = 'exploringCollections.message';
    return node;
  }

  /** True when the node can be expanded into a list of collections. */
  private hasCollections(session: SessionInfo): boolean {
    return session.supported;
  }

  private rootNodes(): ExplorerNode[] {
    const settings = readSettings();
    const nodes: ExplorerNode[] = [];

    const sessionNodes = this.sessionNodes(settings.customDebugTypes);
    if (sessionNodes.length > 0) {
      nodes.push(
        this.group(localize('Debug Sessions'), sessionNodes, 'sessions')
      );
    }

    const pinned = this.store.pinned;
    if (pinned.length > 0) {
      nodes.push(
        this.group(localize('Pinned'), pinned.map((record) => this.snapshotNode(record, true)), 'pinned')
      );
    }

    const recent = this.store.recent.filter((record) => !record.pinned);
    if (recent.length > 0) {
      nodes.push(
        this.group(
          localize('Recent'),
          recent.map((record) => this.snapshotNode(record, false)),
          'recent'
        )
      );
    }

    return nodes;
  }

  private group(label: string, children: ExplorerNode[], id: string): ExplorerNode {
    const node = new ExplorerNode(
      'group',
      label,
      vscode.TreeItemCollapsibleState.Expanded,
      children
    );
    node.id = `exploringCollections.group.${id}`;
    node.contextValue = 'exploringCollections.group';
    node.description = `${children.length}`;
    return node;
  }

  private sessionNodes(customTypes: Readonly<Record<string, string>>): ExplorerNode[] {
    const describe = this.sessions.describeSessions({
      ...readSettings(),
      customDebugTypes: { ...customTypes }
    });

    return describe.map((session) => {
      const node = new ExplorerNode(
        'session',
        session.name,
        this.hasCollections(session)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      node.id = `exploringCollections.session.${session.id}`;
      node.sessionId = session.id;
      node.description = session.supported
        ? session.language
        : localize('unsupported debug type: {0}', session.type);
      node.tooltip = new vscode.MarkdownString(
        [
          `**${session.name}**`,
          '',
          `- ${localize('Debug type')}: \`${session.type}\``,
          `- ${localize('Language')}: \`${session.language}\``,
          `- ${localize('Provider')}: \`${session.providerId}\``,
          session.workspaceFolder ? `- ${localize('Folder')}: \`${session.workspaceFolder}\`` : ''
        ]
          .filter((line) => line.length > 0)
          .join('\n')
      );
      node.contextValue = session.supported
        ? 'exploringCollections.session.supported'
        : 'exploringCollections.session.unsupported';
      node.iconPath = new vscode.ThemeIcon(session.supported ? 'debug-stackframe-active' : 'debug-stackframe');
      return node;
    });
  }

  private snapshotNode(record: SnapshotRecord, pinned: boolean): ExplorerNode {
    const { snapshot } = record;
    const node = new ExplorerNode(
      'snapshot',
      snapshot.title,
      vscode.TreeItemCollapsibleState.None,
      [],
      snapshot
    );
    node.id = `exploringCollections.snapshot.${pinned ? 'pinned' : 'recent'}.${snapshot.id}`;
    node.description = summarize(snapshot);
    node.tooltip = new vscode.MarkdownString(
      [
        `**${snapshot.title}**`,
        '',
        '```',
        snapshot.expression,
        '```',
        '',
        `- ${localize('Language')}: \`${snapshot.language}\``,
        `- ${localize('Strategy')}: \`${snapshot.diagnostics.strategy}\``,
        `- ${localize('Captured')}: ${new Date(snapshot.capturedAt).toLocaleString()}`,
        snapshot.warnings.length > 0 ? `- ⚠ ${snapshot.warnings[0]}` : ''
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    );
    node.contextValue = pinned
      ? 'exploringCollections.snapshot.pinned'
      : 'exploringCollections.snapshot.recent';
    node.iconPath = new vscode.ThemeIcon(pinned ? 'pinned' : 'table');
    node.command = {
      command: 'exploringCollections.openSnapshot',
      title: localize('Open collection'),
      arguments: [snapshot]
    };
    return node;
  }
}
