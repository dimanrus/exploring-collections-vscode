import type { CellValue, ColumnDescriptor, ColumnKind, RowDescriptor } from '../src/model/types';
import { clear, el, icon } from './dom';

export interface ValuePaneStrings {
  valuePane: string;
  expandAll: string;
  collapseAll: string;
  loadFromDebugger: string;
  copy: string;
  empty: string;
  closePane: string;
}

/** One node of the object tree shown for a row. */
interface TreeNode {
  name: string;
  value: string;
  kind: ColumnKind;
  typeName?: string;
  variablesReference?: number;
  children?: TreeNode[];
  expanded?: boolean;
  loaded?: boolean;
  pending?: boolean;
  error?: string;
}

export interface ValuePaneCallbacks {
  requestChildren(requestId: number, variablesReference: number): void;
  onCopy(text: string, label: string): void;
}

/**
 * Inspector for the whole item behind a row: nested objects are grouped by their
 * property path, and containers coming from the variables walk are loaded from
 * the debugger on demand.
 */
export class ValuePane {
  private readonly header: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly root: HTMLDivElement;
  private tree: TreeNode[] = [];
  private row: RowDescriptor | undefined;
  private requestSeq = 1;
  private readonly pending = new Map<number, TreeNode>();
  private expandAll = false;

  /** Hides the pane; wired to the close button in its header. */
  onClose: (() => void) | undefined;

  strings: ValuePaneStrings = {
    valuePane: 'Value',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    loadFromDebugger: 'Load from debugger',
    copy: 'Copy',
    empty: 'Select a row to inspect its value.',
    closePane: 'Hide the details'
  };

  constructor(host: HTMLElement, private readonly callbacks: ValuePaneCallbacks) {
    this.header = el('div', { class: 'value-pane-header' });
    this.body = el('div', { class: 'value-pane-body' });
    this.root = el('div', { class: 'value-pane' }, [this.header, this.body]);
    clear(host);
    host.appendChild(this.root);
    this.renderHeader();
    this.renderBody();
  }

  /** Shows the object tree of a row. */
  show(columns: readonly ColumnDescriptor[], row: RowDescriptor | undefined): void {
    this.row = row;
    this.pending.clear();
    this.tree = row ? buildRowTree(columns, row) : [];
    this.renderHeader();
    this.renderBody();
  }

  /** Highlights the property of the last clicked cell. */
  private focusPath: string[] = [];

  focus(columns: readonly ColumnDescriptor[], columnKey: string | null): void {
    const column = columns.find((candidate) => candidate.key === columnKey);
    this.focusPath = column && column.path.length > 0 ? column.path : [];
    this.renderBody();
  }

  /** Resolves a pending debugger request. */
  resolveChildren(requestId: number, children: TreeNode[] | undefined, error?: string): void {
    const node = this.pending.get(requestId);
    if (!node) {
      return;
    }
    this.pending.delete(requestId);
    node.pending = false;
    if (error) {
      node.error = error;
      node.loaded = false;
      node.expanded = false;
    } else {
      node.children = children ?? [];
      node.loaded = true;
      node.expanded = true;
    }
    this.renderBody();
  }

  private renderHeader(): void {
    clear(this.header);
    const label = this.row?.label ?? this.strings.valuePane;
    this.header.appendChild(
      el('div', { class: 'value-pane-heading' }, [
        el('span', { class: 'value-pane-title', title: label }, [label]),
        this.row?.typeName
          ? el('span', { class: 'value-pane-type', title: this.row.typeName }, [this.row.typeName])
          : null,
        this.row ? el('span', { class: 'value-pane-count' }, [String(this.row.cells.length)]) : null
      ])
    );

    const actions = el('div', { class: 'value-pane-actions' });
    const expandToggle = actionButton(
      this.expandAll ? 'chevronDown' : 'chevronRight',
      this.expandAll ? this.strings.collapseAll : this.strings.expandAll,
      () => {
        this.expandAll = !this.expandAll;
        if (this.expandAll) {
          expandLocally(this.tree);
        } else {
          collapseAll(this.tree);
        }
        this.renderHeader();
        this.renderBody();
      }
    );
    actions.appendChild(expandToggle);

    if (this.row) {
      actions.appendChild(
        actionButton('copy', this.strings.copy, () => {
          const text = this.tree
            .map((node) => `${node.name} = ${node.value}`)
            .join('\n');
          this.callbacks.onCopy(text, this.row?.label ?? this.strings.valuePane);
        })
      );
    }
    if (this.onClose) {
      actions.appendChild(actionButton('close', this.strings.closePane, () => this.onClose?.()));
    }
    this.header.appendChild(actions);
  }

  private renderBody(): void {
    clear(this.body);
    if (!this.row || this.tree.length === 0) {
      this.body.appendChild(
        el('div', { class: 'value-empty' }, [
          icon('panel', 20),
          el('span', {}, [this.strings.empty])
        ])
      );
      return;
    }
    this.body.appendChild(this.renderNodes(this.tree, 0, []));
  }

  private renderNodes(nodes: readonly TreeNode[], depth: number, path: string[]): HTMLElement {
    const container = el('div', { class: `value-children depth-${Math.min(depth, 4)}` });
    for (const node of nodes) {
      container.appendChild(this.renderNode(node, depth, path));
    }
    return container;
  }

  private renderNode(node: TreeNode, depth: number, path: string[]): HTMLElement {
    const currentPath = [...path, node.name];
    const container = el('div', { class: 'value-node' });
    const isFocused =
      this.focusPath.length > 0 &&
      this.focusPath.length === currentPath.length &&
      this.focusPath.every((segment, index) => segment === currentPath[index]);

    const expandable = (node.children && node.children.length > 0) || node.variablesReference !== undefined;
    const line = el('div', { class: `value-line${isFocused ? ' is-focused' : ''}` });

    const toggle = el('button', {
      class: 'tree-toggle',
      type: 'button',
      ariaLabel: node.expanded ? 'collapse' : 'expand',
      hidden: !expandable
    });
    if (expandable) {
      toggle.appendChild(icon(node.expanded ? 'chevronDown' : 'chevronRight', 12));
    }
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggle(node);
    });
    line.appendChild(toggle);

    line.appendChild(el('span', { class: 'value-key', title: node.name }, [node.name]));
    line.appendChild(el('span', { class: 'value-kind' }, [node.typeName ?? shortKind(node.kind)]));

    const text = node.value.length > 0 ? node.value : node.kind === 'null' ? 'null' : '';
    line.appendChild(
      el('span', {
        class: `value-text kind-${node.kind}${node.kind === 'null' ? ' is-null' : ''}`,
        title: text
      }, [text])
    );

    const badges = el('span', { class: 'value-badges' });
    if (node.pending) {
      badges.appendChild(el('span', { class: 'value-pending' }, ['…']));
    }
    if (node.error) {
      badges.appendChild(el('span', { class: 'value-error', title: node.error }, [node.error]));
    }
    if (node.variablesReference !== undefined && !node.loaded && !node.pending) {
      const load = el('button', { class: 'value-load', type: 'button' }, [this.strings.loadFromDebugger]);
      load.addEventListener('click', (event) => {
        event.stopPropagation();
        this.load(node);
      });
      badges.appendChild(load);
    }
    line.appendChild(badges);

    const copy = el('button', {
      class: 'value-copy',
      type: 'button',
      title: this.strings.copy,
      ariaLabel: this.strings.copy
    });
    copy.appendChild(icon('copy', 12));
    copy.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onCopy(`${node.name} = ${node.value}`, node.name);
    });
    line.appendChild(copy);

    line.addEventListener('click', () => {
      if (expandable) {
        this.toggle(node);
      }
    });

    container.appendChild(line);
    if (node.expanded && node.children && node.children.length > 0) {
      container.appendChild(this.renderNodes(node.children, depth + 1, currentPath));
    }
    return container;
  }

  private toggle(node: TreeNode): void {
    if (node.children && node.children.length > 0) {
      node.expanded = !node.expanded;
      this.renderBody();
      return;
    }
    if (node.variablesReference !== undefined) {
      if (node.loaded) {
        node.expanded = !node.expanded;
        this.renderBody();
        return;
      }
      this.load(node);
      return;
    }
    node.expanded = !node.expanded;
    this.renderBody();
  }

  private load(node: TreeNode): void {
    if (node.variablesReference === undefined || node.pending) {
      return;
    }
    const requestId = this.requestSeq++;
    node.pending = true;
    this.pending.set(requestId, node);
    this.renderBody();
    this.callbacks.requestChildren(requestId, node.variablesReference);
  }
}

/** Icon button used by the pane header and the value rows. */
function actionButton(iconName: Parameters<typeof icon>[0], label: string, action: () => void): HTMLButtonElement {
  const button = el('button', {
    class: 'icon-button',
    type: 'button',
    title: label,
    ariaLabel: label
  });
  button.appendChild(icon(iconName, 14));
  button.addEventListener('click', action);
  return button;
}

/** Short type hint shown when the debugger did not report one. */
function shortKind(kind: NodeKind): string {
  return kind;
}

type NodeKind = ColumnKind;

function collapseAll(nodes: TreeNode[]): void {
  for (const node of nodes) {
    node.expanded = false;
    if (node.children) {
      collapseAll(node.children);
    }
  }
}

function expandLocally(nodes: TreeNode[]): void {
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      node.expanded = true;
      expandLocally(node.children);
    }
  }
}

/** Builds the object tree of a row from its flattened columns. */
export function buildRowTree(
  columns: readonly ColumnDescriptor[],
  row: RowDescriptor
): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  const ensureContainer = (path: string[], name: string): TreeNode => {
    const key = path.join('\u0000');
    const existing = byPath.get(key);
    if (existing) {
      return existing;
    }
    const node: TreeNode = {
      name,
      value: '',
      kind: 'object',
      children: [],
      expanded: true,
      loaded: true
    };
    byPath.set(key, node);
    if (path.length === 1) {
      roots.push(node);
    } else {
      const parent = ensureContainer(path.slice(0, -1), path[path.length - 2] as string);
      parent.children?.push(node);
    }
    return node;
  };

  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index] as ColumnDescriptor;
    if (column.key === '#' || column.path.length === 0) {
      continue;
    }
    const cell = row.cells[index];
    if (!cell) {
      continue;
    }
    const node: TreeNode = {
      name: column.path[column.path.length - 1] as string,
      value: cell.text,
      kind: cell.kind,
      typeName: cell.typeName ?? column.typeName,
      variablesReference: cell.variablesReference
    };
    const rawChildren = rawChildrenOf(cell);
    if (rawChildren && rawChildren.length > 0) {
      node.children = rawChildren;
      node.loaded = true;
      node.expanded = column.path.length === 1;
    }
    if (column.path.length === 1) {
      roots.push(node);
    } else {
      const parent = ensureContainer(column.path.slice(0, -1), column.path[column.path.length - 2] as string);
      parent.children?.push(node);
    }
  }

  return roots;
}

function rawChildrenOf(cell: CellValue): TreeNode[] | undefined {
  const raw = cell.raw;
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return undefined;
  }
  if (Array.isArray(raw)) {
    return raw.slice(0, 200).map((entry, index) => rawToNode(`[${index}]`, entry));
  }
  return Object.entries(raw as Record<string, unknown>)
    .slice(0, 200)
    .map(([key, entry]) => rawToNode(key, entry));
}

function rawToNode(name: string, value: unknown): TreeNode {
  if (value === null || value === undefined) {
    return { name, value: '', kind: 'null' };
  }
  if (Array.isArray(value)) {
    return {
      name,
      value: `[${value.length}]`,
      kind: 'array',
      children: value.slice(0, 200).map((entry, index) => rawToNode(`[${index}]`, entry)),
      loaded: true,
      expanded: false
    };
  }
  if (typeof value === 'object') {
    return {
      name,
      value: `{${Object.keys(value as object).length}}`,
      kind: 'object',
      children: Object.entries(value as Record<string, unknown>)
        .slice(0, 200)
        .map(([key, entry]) => rawToNode(key, entry)),
      loaded: true,
      expanded: false
    };
  }
  const kind: ColumnKind =
    typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
  return { name, value: String(value), kind };
}
