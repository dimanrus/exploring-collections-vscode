import type { CellValue, ColumnDescriptor, RowDescriptor } from '../src/model/types';
import type { ColumnFilterState, ViewState } from '../src/webview/protocol';
import { clear, el, icon } from './dom';
import { isColumnFilterActive } from './state';

/** Labels injected by the host so the grid stays localizable. */
export interface TableStrings {
  filter: string;
  copyCell: string;
  copyRow: string;
  copyAll: string;
}

export interface TableColumn {
  column: ColumnDescriptor;
  /** Position of the column inside the snapshot. */
  index: number;
  width: number;
}

export interface TableModel {
  columns: TableColumn[];
  /** Rows of the current page (already filtered and sorted by the pipeline). */
  rows: readonly RowDescriptor[];
  sort: ViewState['sort'];
  columnFilters: Record<string, ColumnFilterState>;
  /** Absolute position of the first row of the page inside the snapshot. */
  pageOffset: number;
  selectedRow: number | null;
  selectedColumnKey: string | null;
}

export interface TableCallbacks {
  onSelect(columnKey: string, rowIndex: number): void;
  onSortChange(columnKey: string, direction: 'asc' | 'desc' | null): void;
  openColumnFilter(column: TableColumn, anchor: HTMLElement): void;
  onReorder(order: string[]): void;
  onCopy(text: string, label: string): void;
}

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 32;
const OVERSCAN = 6;

/** Virtualized grid with a sticky, reorderable and sortable header. */
export class CollectionTable {
  private readonly root: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly canvas: HTMLDivElement;
  private model: TableModel | undefined;
  private dragKey: string | null = null;
  private contextMenu: HTMLElement | undefined;

  /** Labels injected by the host. */
  strings: TableStrings = {
    filter: 'Filter',
    copyCell: 'Copy cell',
    copyRow: 'Copy row',
    copyAll: 'Copy all rows'
  };

  constructor(host: HTMLElement, private readonly callbacks: TableCallbacks) {
    this.header = el('div', { class: 'grid-header', role: 'row' });
    this.canvas = el('div', { class: 'grid-canvas' });
    this.scroller = el('div', { class: 'grid-scroller', tabIndex: 0 }, [this.canvas]);
    this.root = el('div', { class: 'grid' }, [this.header, this.scroller]);
    clear(host);
    host.appendChild(this.root);

    this.scroller.addEventListener('scroll', () => this.renderWindow());
    this.scroller.addEventListener('keydown', (event) => this.handleKeyDown(event));
    window.addEventListener('resize', () => this.renderWindow());
    document.addEventListener('click', (event) => {
      if (this.contextMenu && !this.contextMenu.contains(event.target as Node)) {
        this.closeContextMenu();
      }
    });
  }

  /** Renders the table with a new model. */
  render(model: TableModel): void {
    this.model = model;
    this.renderHeader();
    this.syncCanvas();
    this.scroller.scrollTop = 0;
    this.renderWindow();
  }

  /** Scrolls the selected row into view. */
  revealRow(rowIndex: number): void {
    const target = rowIndex * ROW_HEIGHT;
    const viewTop = this.scroller.scrollTop;
    const viewBottom = viewTop + this.scroller.clientHeight;
    if (target < viewTop) {
      this.scroller.scrollTop = target;
    } else if (target + ROW_HEIGHT > viewBottom) {
      this.scroller.scrollTop = target + ROW_HEIGHT - this.scroller.clientHeight;
    }
  }

  private get totalWidth(): number {
    const columns = this.model?.columns ?? [];
    return columns.reduce((total, entry) => total + entry.width, 0);
  }

  private syncCanvas(): void {
    const rows = this.model?.rows.length ?? 0;
    this.canvas.style.height = `${rows * ROW_HEIGHT}px`;
    this.canvas.style.width = `${this.totalWidth}px`;
    const headerWidth = this.totalWidth;
    this.header.style.width = `${Math.max(headerWidth, this.scroller.clientWidth)}px`;
  }

  private renderHeader(): void {
    clear(this.header);
    const model = this.model;
    if (!model) {
      return;
    }
    this.header.style.height = `${HEADER_HEIGHT}px`;

    for (const entry of model.columns) {
      const isSorted = model.sort?.columnKey === entry.column.key;
      const filter = model.columnFilters[entry.column.key];
      const active = isColumnFilterActive(filter);

      const label = el('span', { class: 'th-label', title: entry.column.key }, [entry.column.title]);
      const indicators = el('span', { class: 'th-indicators' });
      if (isSorted) {
        indicators.appendChild(icon(model.sort?.direction === 'asc' ? 'sortAsc' : 'sortDesc', 12));
      }

      const headerCell = el(
        'div',
        {
          class: `grid-th${isSorted ? ' is-sorted' : ''}${active ? ' is-filtered' : ''}`,
          role: 'columnheader',
          draggable: true,
          style: `width:${entry.width}px`,
          dataset: { columnKey: entry.column.key }
        },
        [label, indicators]
      );

      headerCell.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('.th-filter')) {
          return;
        }
        const next = nextSortDirection(model.sort, entry.column.key);
        this.callbacks.onSortChange(entry.column.key, next);
      });

      const funnel = el('button', {
        class: `th-filter${active ? ' is-active' : ''}`,
        type: 'button',
        title: this.strings.filter,
        ariaLabel: this.strings.filter
      });
      funnel.appendChild(icon('funnel', 12));
      funnel.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.openColumnFilter(entry, funnel);
      });
      headerCell.appendChild(funnel);

      headerCell.addEventListener('dragstart', (event) => {
        this.dragKey = entry.column.key;
        event.dataTransfer?.setData('text/plain', entry.column.key);
        headerCell.classList.add('is-dragging');
      });
      headerCell.addEventListener('dragend', () => {
        headerCell.classList.remove('is-dragging');
        this.dragKey = null;
      });
      headerCell.addEventListener('dragover', (event) => {
        if (this.dragKey && this.dragKey !== entry.column.key) {
          event.preventDefault();
          headerCell.classList.add('is-drop-target');
        }
      });
      headerCell.addEventListener('dragleave', () => headerCell.classList.remove('is-drop-target'));
      headerCell.addEventListener('drop', (event) => {
        event.preventDefault();
        headerCell.classList.remove('is-drop-target');
        const source = this.dragKey ?? event.dataTransfer?.getData('text/plain') ?? null;
        this.dragKey = null;
        if (!source || source === entry.column.key || !this.model) {
          return;
        }
        const order = this.model.columns.map((candidate) => candidate.column.key);
        const from = order.indexOf(source);
        const to = order.indexOf(entry.column.key);
        if (from < 0 || to < 0) {
          return;
        }
        order.splice(to, 0, ...order.splice(from, 1));
        this.callbacks.onReorder(order);
      });

      this.header.appendChild(headerCell);
    }
  }

  private renderWindow(): void {
    const model = this.model;
    if (!model) {
      return;
    }
    const viewHeight = this.scroller.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(viewHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(model.rows.length, first + visible);

    clear(this.canvas);
    const fragment = document.createDocumentFragment();
    for (let position = first; position < last; position += 1) {
      const row = model.rows[position];
      if (!row) {
        continue;
      }
      fragment.appendChild(this.renderRow(row, position));
    }
    this.canvas.appendChild(fragment);
  }

  private renderRow(row: RowDescriptor, position: number): HTMLElement {
    const model = this.model as TableModel;
    const isSelected = model.selectedRow === position;
    const rowNode = el('div', {
      class: `grid-tr${isSelected ? ' is-selected' : ''}${row.error ? ' is-error' : ''}`,
      role: 'row',
      style: `top:${position * ROW_HEIGHT}px;height:${ROW_HEIGHT}px;width:${this.totalWidth}px`
    });

    for (const entry of model.columns) {
      const cell = row.cells[entry.index];
      const isIndex = entry.column.key === '#';
      const cellNode = el(
        'div',
        {
          class: `grid-td${isIndex ? ' is-index' : ''}${
            model.selectedColumnKey === entry.column.key && isSelected ? ' is-selected-cell' : ''
          }${cell?.isNull ? ' is-null' : ''} kind-${cell?.kind ?? 'unknown'}`,
          role: 'gridcell',
          title: buildCellTitle(entry.column, cell, row),
          style: `width:${entry.width}px`
        },
        [el('span', { class: 'cell-text' }, [cell?.text ?? ''])]
      );

      cellNode.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.onSelect(entry.column.key, position);
      });
      cellNode.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.callbacks.onSelect(entry.column.key, position);
        this.openContextMenu(event.clientX, event.clientY, entry, row);
      });
      rowNode.appendChild(cellNode);
    }

    rowNode.addEventListener('dblclick', () => this.callbacks.onSelect('#', position));
    return rowNode;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const model = this.model;
    if (!model) {
      return;
    }
    const current = model.selectedRow ?? 0;
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(model.rows.length - 1, current + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, current - 1);
        break;
      case 'PageDown':
        next = Math.min(model.rows.length - 1, current + 20);
        break;
      case 'PageUp':
        next = Math.max(0, current - 20);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = Math.max(0, model.rows.length - 1);
        break;
      case 'c':
        if (event.ctrlKey || event.metaKey) {
          const row = model.rows[current];
          if (row) {
            this.callbacks.onCopy(this.copyRowText(row, model), 'Row');
            event.preventDefault();
          }
        }
        return;
      default:
        return;
    }
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    this.callbacks.onSelect(model.selectedColumnKey ?? '#', next);
    this.revealRow(next);
  }

  private copyRowText(row: RowDescriptor, model: TableModel): string {
    return model.columns.map((entry) => row.cells[entry.index]?.text ?? '').join('\t');
  }

  private openContextMenu(
    x: number,
    y: number,
    entry: TableColumn,
    row: RowDescriptor
  ): void {
    this.closeContextMenu();
    const model = this.model;
    if (!model) {
      return;
    }
    const menu = el('div', { class: 'context-menu', role: 'menu' });
    const add = (label: string, action: () => void): void => {
      const item = el('button', { class: 'context-menu-item', type: 'button' }, [label]);
      item.addEventListener('click', () => {
        action();
        this.closeContextMenu();
      });
      menu.appendChild(item);
    };

    add(this.strings.copyCell, () => {
      const cell = row.cells[entry.index];
      this.callbacks.onCopy(cell?.text ?? '', entry.column.title);
    });
    add(this.strings.copyRow, () => this.callbacks.onCopy(this.copyRowText(row, model), 'Row'));
    add(this.strings.copyAll, () => {
      this.callbacks.onCopy(this.copyAllText(model), 'Collection');
    });

    menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
    document.body.appendChild(menu);
    this.contextMenu = menu;
  }

  private copyAllText(model: TableModel): string {
    const header = model.columns.map((entry) => entry.column.title).join('\t');
    const lines = [header];
    for (const row of model.rows) {
      lines.push(this.copyRowText(row, model));
    }
    return lines.join('\n');
  }

  private closeContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = undefined;
    }
  }
}

function buildCellTitle(
  column: ColumnDescriptor,
  cell: CellValue | undefined,
  row: RowDescriptor
): string {
  if (!cell) {
    return '';
  }
  const parts = [`${column.key}${cell.typeName ? ` (${cell.typeName})` : ''}`];
  parts.push(cell.isNull ? 'null' : cell.text);
  if (column.key === '#') {
    parts.push(`row ${row.index}`);
  }
  return parts.join(' = ');
}

function nextSortDirection(
  sort: ViewState['sort'],
  columnKey: string
): 'asc' | 'desc' | null {
  if (!sort || sort.columnKey !== columnKey) {
    return 'asc';
  }
  return sort.direction === 'asc' ? 'desc' : null;
}

/** Computes a stable width per column from the header and a data sample. */
export function computeColumnWidths(
  columns: readonly { column: ColumnDescriptor; index: number }[],
  rows: readonly RowDescriptor[],
  sampleSize = 200
): TableColumn[] {
  const sample = rows.slice(0, sampleSize);
  return columns.map((entry) => {
    let longest = entry.column.title.length;
    for (const row of sample) {
      const cell = row.cells[entry.index];
      if (!cell) {
        continue;
      }
      const length = Math.min(cell.text.length, 80);
      if (length > longest) {
        longest = length;
      }
    }
    const base = entry.column.key === '#' ? Math.max(3, longest) : longest;
    const width = Math.round(Math.min(460, Math.max(72, base * 7.3 + 30)));
    return { column: entry.column, index: entry.index, width };
  });
}

export { ROW_HEIGHT, HEADER_HEIGHT };
