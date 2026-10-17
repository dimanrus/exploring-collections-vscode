import * as vscode from 'vscode';
import type { CollectionSnapshot } from '../model/types';
import { createDefaultViewState, type ViewState } from '../webview/protocol';

const VIEW_STATE_KEY = 'exploringCollections.viewStates';
const MAX_RECENT = 12;

/** A lightweight description of a captured collection, used by the tree view. */
export interface SnapshotRecord {
  snapshot: CollectionSnapshot;
  pinned: boolean;
}

/**
 * Keeps the current, recent and pinned snapshots plus the per collection view
 * state (sorting, filters, column layout) that the webview restores.
 */
export class SnapshotStore implements vscode.Disposable {
  private readonly pinnedRecords: SnapshotRecord[] = [];
  private readonly recentRecords: SnapshotRecord[] = [];
  private readonly viewStates: Record<string, ViewState>;
  private readonly emitter = new vscode.EventEmitter<void>();
  private current: CollectionSnapshot | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly workspaceState: vscode.Memento) {
    const stored = workspaceState.get<Record<string, ViewState>>(VIEW_STATE_KEY, {});
    this.viewStates = stored && typeof stored === 'object' ? stored : {};
  }

  dispose(): void {
    this.emitter.dispose();
  }

  get currentSnapshot(): CollectionSnapshot | undefined {
    return this.current;
  }

  get pinned(): readonly SnapshotRecord[] {
    return this.pinnedRecords;
  }

  get recent(): readonly SnapshotRecord[] {
    return this.recentRecords;
  }

  /** Makes a snapshot the active one and records it in the recent list. */
  setCurrent(snapshot: CollectionSnapshot): void {
    this.current = snapshot;
    this.pushRecent(snapshot);
    this.emitter.fire();
  }

  /** Replaces one row-bearing snapshot without touching the recent list. */
  replaceCurrent(snapshot: CollectionSnapshot): void {
    this.current = snapshot;
    const index = this.recentRecords.findIndex(
      (record) => record.snapshot.id === snapshot.id && !record.pinned
    );
    if (index >= 0) {
      this.recentRecords[index] = { snapshot, pinned: false };
    }
    this.emitter.fire();
  }

  private pushRecent(snapshot: CollectionSnapshot): void {
    const filtered = this.recentRecords.filter(
      (record) => record.snapshot.id !== snapshot.id || record.pinned
    );
    filtered.unshift({ snapshot, pinned: false });
    this.recentRecords.length = 0;
    this.recentRecords.push(...filtered.slice(0, MAX_RECENT));
  }

  /** Pins a snapshot so it survives until the window closes. */
  pin(snapshot: CollectionSnapshot): void {
    if (this.pinnedRecords.some((record) => record.snapshot.id === snapshot.id)) {
      return;
    }
    this.pinnedRecords.unshift({ snapshot, pinned: true });
    this.emitter.fire();
  }

  remove(id: string): void {
    const pinnedIndex = this.pinnedRecords.findIndex((record) => record.snapshot.id === id);
    if (pinnedIndex >= 0) {
      this.pinnedRecords.splice(pinnedIndex, 1);
    }
    const recentIndex = this.recentRecords.findIndex((record) => record.snapshot.id === id);
    if (recentIndex >= 0) {
      this.recentRecords.splice(recentIndex, 1);
    }
    this.emitter.fire();
  }

  clearRecent(): void {
    this.recentRecords.length = 0;
    this.emitter.fire();
  }

  /** Stable key used to persist the view state of a collection. */
  viewStateKey(snapshot: CollectionSnapshot): string {
    return `${snapshot.providerId}:${snapshot.title}:${snapshot.expression}`;
  }

  viewStateFor(snapshot: CollectionSnapshot, defaultPageSize: number): ViewState {
    const key = this.viewStateKey(snapshot);
    const stored = this.viewStates[key];
    if (!stored) {
      return createDefaultViewState(defaultPageSize);
    }
    return {
      ...createDefaultViewState(defaultPageSize),
      ...stored,
      columnFilters: stored.columnFilters ?? {},
      hiddenColumns: Array.isArray(stored.hiddenColumns) ? stored.hiddenColumns : []
    };
  }

  async saveViewState(snapshot: CollectionSnapshot, viewState: ViewState): Promise<void> {
    this.viewStates[this.viewStateKey(snapshot)] = viewState;
    const keys = Object.keys(this.viewStates);
    if (keys.length > 200) {
      for (const key of keys.slice(0, keys.length - 200)) {
        delete this.viewStates[key];
      }
    }
    await this.workspaceState.update(VIEW_STATE_KEY, this.viewStates);
  }
}
