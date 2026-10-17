/**
 * A small collection of disposables that can be disposed together.
 * Kept dependency free so that it can be reused by unit tests.
 */
export interface IDisposable {
  dispose(): void;
}

export class DisposableStore implements IDisposable {
  private readonly items = new Set<IDisposable>();
  private isDisposed = false;

  get disposed(): boolean {
    return this.isDisposed;
  }

  get size(): number {
    return this.items.size;
  }

  add<T extends IDisposable>(item: T): T {
    if (this.isDisposed) {
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  delete(item: IDisposable): void {
    if (this.items.delete(item)) {
      item.dispose();
    }
  }

  clear(): void {
    const items = [...this.items];
    this.items.clear();
    for (const item of items) {
      try {
        item.dispose();
      } catch {
        // Disposal must never break the shutdown path.
      }
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.clear();
  }
}

/** Wraps a callback so it can be registered as a disposable. */
export function toDisposable(callback: () => void): IDisposable {
  return { dispose: callback };
}
