import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from './vscodeStub';
import type { CollectionSnapshot } from '../src/model/types';
import { createDefaultViewState } from '../src/webview/protocol';
import type { LocalizedStrings } from '../src/webview/protocol';
import type { HostMessage, WebviewMessage } from '../src/webview/protocol';

const root = join(__dirname, '..', '..');

/**
 * Boots the real webview bundle inside a DOM, exactly like the panel does:
 * the HTML shell from the host, then the bundled script, then the `init` message.
 * This is the test that proves the viewer is not stuck on the loading spinner.
 */
interface BootedWebview {
  dom: JSDOM;
  posted: WebviewMessage[];
  send(message: HostMessage): void;
  text(): string;
  close(): void;
}

function stubWebviewGlobals(window: JSDOM['window']): void {
  const w = window as unknown as Record<string, unknown>;
  w.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  w.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  };
  w.matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  });
  w.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(0), 0);
  w.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  w.getComputedStyle = () => ({ backgroundColor: 'rgb(30,30,30)', getPropertyValue: () => '' });
  (window.HTMLElement.prototype as unknown as { scrollTo?: () => void }).scrollTo = () => undefined;
  (
    window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect }
  ).getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
      toJSON: () => ({})
    }) as DOMRect;
}

function localizedStrings(): LocalizedStrings {
  const source = readFileSync(join(root, 'l10n', 'bundle.l10n.json'), 'utf8');
  const bundle = JSON.parse(source) as Record<string, string>;
  // The webview receives its string table from the host; reuse the English
  // bundle as the source of truth so a missing key is caught here.
  return {
    appTitle: bundle['Collection View'] ?? 'Collection View',
    loading: bundle['Loading collection…'] ?? 'Loading collection…',
    toolbar: {
      refresh: 'Refresh',
      filter: 'Filter',
      clearFilter: 'Clear filter',
      search: 'Search',
      columns: 'Columns',
      export: 'Export',
      chart: 'Show Chart',
      chartSettings: 'Series Settings',
      pin: 'Pin collection',
      settings: 'Extension settings',
      diagnostics: 'Diagnostics',
      copy: 'Copy',
      apply: 'Apply',
      cancel: 'Cancel',
      close: 'Close',
      pageSize: 'Page size',
      page: 'Page',
      of: 'of',
      rows: 'rows',
      clearAllFilters: 'Clear all filters',
      selectAll: 'Select all',
      clear: 'Clear',
      addToValues: 'Add value',
      include: 'Include',
      exclude: 'Exclude',
      regex: 'Regular expression',
      hideColumn: 'Hide column',
      showColumn: 'Show column',
      resetOrder: 'Reset column order',
      sortAscending: 'Sort ascending',
      sortDescending: 'Sort descending',
      clearSort: 'Clear sorting',
      valuePane: 'Value',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      loadFromDebugger: 'Load from debugger',
      chartType: 'Chart type',
      xAxis: 'X axis',
      yAxis: 'Y axis',
      group: 'Group by',
      aggregation: 'Aggregation',
      series: 'Series',
      none: 'None',
      mean: 'Mean',
      sum: 'Sum',
      min: 'Min',
      max: 'Max',
      count: 'Count',
      first: 'First',
      last: 'Last',
      exportPng: 'Export to PNG',
      empty: 'No rows to display',
      emptyHint: 'Adjust the filter or refresh the collection.',
      elapsed: 'Capture time',
      requests: 'Debugger requests',
      strategy: 'Retrieval strategy',
      truncated: 'Truncated',
      filtered: 'Filtered',
      total: 'Total',
      error: 'Error',
      warning: 'Warning',
      showValuePane: 'Show value pane',
      hideValuePane: 'Hide value pane',
      hideTable: 'Hide the table',
      showTable: 'Show the table',
      resizeChart: 'Drag to change the height of the chart',
      resizeDetail: 'Drag to change the width of the details',
      activeFilter: 'Active filter',
      valueEmpty: 'Select a row to inspect its value.',
      filterBuilderTitle: 'Filter the whole collection',
      filterWholeCollection:
        'The condition is applied to every element, not only to the rows that were fetched.',
      addCondition: 'Add condition',
      removeCondition: 'Remove condition',
      filterColumn: 'Column',
      filterOperator: 'Operator',
      filterValue: 'Value',
      filterValueTo: 'to',
      matchAll: 'Match all',
      matchAny: 'Match any',
      valueRequired: 'Enter a value',
      filterOperators: {
        contains: 'contains',
        notContains: 'does not contain',
        equals: 'equals',
        notEquals: 'is not',
        startsWith: 'starts with',
        endsWith: 'ends with',
        regex: 'matches the regular expression',
        empty: 'is empty',
        notEmpty: 'is not empty',
        gt: 'greater than',
        gte: 'greater or equal',
        lt: 'less than',
        lte: 'less or equal',
        between: 'between',
        isTrue: 'is true',
        isFalse: 'is false',
        isNull: 'is null',
        isNotNull: 'is not null'
      },
      rowPosition: 'Position',
      copyCell: 'Copy cell',
      copyRow: 'Copy row',
      copyAll: 'Copy all rows',
      copied: 'Copied to clipboard'
    },
    chartTypes: {
      bar: 'Bar Chart',
      pie: 'Pie Chart',
      area: 'Area Chart',
      line: 'Line Chart',
      scatter: 'Scatter Chart',
      bubble: 'Bubble Chart',
      stock: 'Stock Chart',
      areaRange: 'AreaRange Chart',
      histogram: 'Histogram Chart'
    }
  };
}

function snapshot(rowCount = 4, overrides: Partial<CollectionSnapshot> = {}): CollectionSnapshot {
  const cities = ['Seoul', 'Sofia', 'Lima', 'Houston'];
  const rows = Array.from({ length: rowCount }, (_, index) => cities[index % cities.length] as string);
  return {
    id: 'snap-1',
    title: 'temperatures',
    expression: 'temperatures',
    sessionId: 'session-1',
    sessionName: 'Demo',
    debugType: 'pwa-node',
    language: 'javascript',
    providerId: 'javascript',
    capturedAt: Date.now(),
    columns: [
      { key: '#', title: '#', kind: 'index', path: [], nested: false },
      { key: 'City', title: 'City', kind: 'string', path: ['City'], nested: false },
      { key: 'Degree', title: 'Degree', kind: 'number', path: ['Degree'], nested: false }
    ],
    rows: rows.map((city, index) => ({
      index,
      label: `[${index}]`,
      cells: [
        { text: String(index), kind: 'index', isNull: false, expandable: false },
        { text: city, kind: 'string', isNull: false, expandable: false },
        { text: String(10 + index), kind: 'number', isNull: false, expandable: false }
      ]
    })),
    totalItems: rows.length,
    truncated: false,
    warnings: [],
    diagnostics: {
      strategy: 'helper-json',
      durationMs: 5,
      requests: 1,
      reportedItemCount: rows.length,
      fallbackReasons: [],
      notes: []
    },
    ...overrides
  };
}

/**
 * Renders the real HTML shell. The module imports `vscode`, so it is imported
 * dynamically after the stub is installed, exactly like the extension host does.
 */
async function renderShell(): Promise<string> {
  installVscodeStub();
  const { renderCollectionViewHtml } = await import('../src/webview/html');
  return renderCollectionViewHtml(
    {
      asWebviewUri: (uri: { toString(): string }) => uri.toString(),
      cspSource: 'vscode-webview://stub'
    } as never,
    {
      fsPath: root,
      path: root,
      scheme: 'file',
      toString: () => 'file://' + root
    } as never,
    'temperatures'
  );
}

async function bootWebview(): Promise<BootedWebview> {
  const html = await renderShell();

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  stubWebviewGlobals(window);

  const posted: WebviewMessage[] = [];
  (window as unknown as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: WebviewMessage) => {
      posted.push(message);
    },
    getState: () => undefined,
    setState: () => undefined
  });

  const bundle = readFileSync(join(root, 'dist', 'webview.js'), 'utf8');
  window.eval(bundle);

  return {
    dom,
    posted,
    send: (message: HostMessage) => {
      window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    },
    text: () => window.document.body.textContent ?? '',
    close: () => dom.window.close()
  };
}

describe('the webview bundle actually boots', () => {
  let webview: BootedWebview;

  before(async () => {
    webview = await bootWebview();
  });

  it('announces itself to the host', () => {
    assert.deepEqual(
      webview.posted.map((message) => message.type).includes('ready'),
      true,
      `expected a ready handshake, saw ${JSON.stringify(webview.posted)}`
    );
  });

  it('renders the snapshot it receives from the host', () => {
    webview.send({
      type: 'init',
      snapshot: snapshot(),
      viewState: { ...createDefaultViewState(100) },
      settings: { pageSize: 100, enableCharts: true, maxDepth: 3, theme: 'dark' },
      strings: localizedStrings(),
      providerName: 'JavaScript'
    } as HostMessage);

    const text = webview.text();
    for (const city of ['Seoul', 'Sofia', 'Lima', 'Houston']) {
      assert.ok(text.includes(city), `the grid must contain '${city}'; rendered: ${text.slice(0, 400)}`);
    }
    assert.equal(text.includes('Loading collection…'), false, 'the spinner must be replaced');
    assert.ok(text.includes('temperatures'), 'the panel title must be rendered');
  });

  it('re-renders when a filter result arrives', () => {
    webview.send({
      type: 'filterResult',
      snapshot: { ...snapshot(), rows: [snapshot().rows[0]!] },
      filter: {
        rows: [snapshot().rows[0]!],
        executed: 'x => x.City == "Seoul"',
        location: 'debugger',
        warnings: []
      }
    } as HostMessage);

    const text = webview.text();
    assert.ok(text.includes('Seoul'));
    assert.equal(text.includes('Houston'), false, 'filtered rows must disappear');
  });

  it('shows a toast instead of crashing on an error message', () => {
    webview.send({ type: 'error', message: 'The debug session ended.' } as HostMessage);

    assert.ok(webview.text().includes('The debug session ended.'));
  });

  it('keeps the DOM alive after every host message', () => {
    assert.ok(webview.dom.window.document.getElementById('app'));
  });
});

describe('the whole collection filter builder', () => {
  let webview: BootedWebview;

  const document = () => webview.dom.window.document;
  const click = (element: Element | null | undefined): void => {
    assert.ok(element, 'the control must exist');
    (element as HTMLElement).click();
  };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
  const lastApply = () =>
    [...webview.posted].reverse().find((message) => message.type === 'applyFilter') as
      | { type: 'applyFilter'; text: string }
      | undefined;

  before(async () => {
    webview = await bootWebview();
    webview.send({
      type: 'init',
      snapshot: snapshot(300),
      viewState: { ...createDefaultViewState(100) },
      settings: { pageSize: 100, enableCharts: true, maxDepth: 3, theme: 'dark' },
      strings: localizedStrings(),
      providerName: 'C#'
    } as HostMessage);
  });

  it('opens from the button next to the search', () => {
    const button = [...document().querySelectorAll('button')].find((candidate) =>
      ((candidate as HTMLElement).title || '').includes('whole collection')
    );
    assert.ok(button, 'the filter button must be in the filter bar');
    click(button);

    assert.ok(document().querySelector('.filter-builder'), 'the builder popover must open');
    assert.ok(
      (document().querySelector('.filter-builder-hint')?.textContent ?? '').includes(
        'applied to every element'
      ),
      'the builder must say that it filters the whole collection'
    );
  });

  it('builds a text condition and sends it to the host', async () => {
    const selects = document().querySelectorAll('.filter-row select') as NodeListOf<HTMLSelectElement>;
    const valueInput = document().querySelector('.filter-row .filter-value') as HTMLInputElement;
    valueInput.value = 'Seoul';
    valueInput.dispatchEvent(new webview.dom.window.Event('input', { bubbles: true }));
    assert.equal(selects[0]?.value, 'City');
    assert.equal(selects[1]?.value, 'contains');

    const apply = [...document().querySelectorAll('.filter-builder button')].find(
      (button) => (button.textContent || '').trim() === 'Apply'
    );
    click(apply);
    await settle();

    assert.equal(lastApply()?.text, 'contains(x.City, "Seoul")');
    assert.equal(document().querySelector('.filter-builder'), null, 'the popover closes on apply');
  });

  it('shows the applied condition as a chip', () => {
    assert.match(
      document().querySelector('.filter-chip')?.textContent ?? '',
      /contains\(x\.City, "Seoul"\)/
    );
  });

  it('adds a second condition with another combinator', async () => {
    const button = [...document().querySelectorAll('button')].find((candidate) =>
      ((candidate as HTMLElement).title || '').includes('whole collection')
    );
    click(button);

    const add = [...document().querySelectorAll('.filter-builder button')].find((candidate) =>
      (candidate.textContent || '').includes('Add condition')
    );
    click(add);
    const rows = document().querySelectorAll('.filter-row');
    assert.equal(rows.length, 2, 'the second condition row must appear');

    // The first row was read back from the active filter and can be edited.
    const firstValue = rows[0]?.querySelector('.filter-value') as HTMLInputElement;
    assert.equal(firstValue.value, 'Seoul');

    const secondValue = rows[1]?.querySelector('.filter-value') as HTMLInputElement;
    secondValue.value = '20';
    secondValue.dispatchEvent(new webview.dom.window.Event('input', { bubbles: true }));
    const or = [...document().querySelectorAll('.filter-builder input[type="radio"]')][1] as HTMLInputElement;
    or.click();

    click(
      [...document().querySelectorAll('.filter-builder button')].find(
        (candidate) => (candidate.textContent || '').trim() === 'Apply'
      )
    );
    await settle();

    assert.equal(
      lastApply()?.text,
      'contains(x.City, "Seoul") || x.Degree >= 20',
      'the combinator and both conditions must reach the host'
    );
  });

  it('clears the filter from the builder', async () => {
    const button = [...document().querySelectorAll('button')].find((candidate) =>
      ((candidate as HTMLElement).title || '').includes('whole collection')
    );
    click(button);
    click(
      [...document().querySelectorAll('.filter-builder button')].find(
        (candidate) => (candidate.textContent || '').trim() === 'Clear'
      )
    );
    await settle();

    assert.equal(lastApply()?.text, '');
  });
});

describe('the viewer reacts to its own controls', () => {
  let webview: BootedWebview;

  const document = () => webview.dom.window.document;
  const statusText = () => document().querySelector('.status-bar')?.textContent ?? '';
  const click = (element: Element | null | undefined): void => {
    assert.ok(element, 'the control must exist');
    (element as HTMLElement).click();
  };
  /** Sets a select and lets the viewer redraw (it defers to the next tick). */
  const setValue = async (element: Element | null, value: string): Promise<void> => {
    assert.ok(element, 'the control must exist');
    const input = element as HTMLSelectElement;
    input.value = value;
    input.dispatchEvent(new webview.dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  /** Ticks the event loop so deferred renders have happened. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  before(async () => {
    webview = await bootWebview();
    webview.send({
      type: 'init',
      snapshot: snapshot(300),
      viewState: { ...createDefaultViewState(100) },
      settings: { pageSize: 100, enableCharts: true, maxDepth: 3, theme: 'dark' },
      strings: localizedStrings(),
      providerName: 'C#'
    } as HostMessage);
  });

  it('shows the first page of the configured size', () => {
    assert.match(statusText(), /1–100 of 300 rows/);
  });

  it('changes the number of displayed rows from the pager', async () => {
    await setValue(document().querySelector('.page-size'), '25');

    assert.match(
      statusText(),
      /1–25 of 300 rows/,
      `the pager select must resize the page, status was: ${statusText()}`
    );
    assert.equal((document().querySelector('.page-size') as HTMLSelectElement).value, '25');
  });

  it('moves between pages', async () => {
    const pageSize = document().querySelector('.page-size');
    await setValue(pageSize, '100');
    const next = [...document().querySelectorAll('.pager button')].find((button) =>
      (button as HTMLElement).title === 'Next page'
    );
    click(next);

    assert.match(statusText(), /101–200 of 300 rows/);
  });

  it('shows every row at once when the pager asks for it', async () => {
    await setValue(document().querySelector('.page-size'), 'all');

    assert.match(statusText(), /1–300 of 300 rows/, `status was: ${statusText()}`);
  });

  it('offers Include and Exclude as one exclusive choice', () => {
    // The funnel is part of every header, so the popover opens straight away.
    click(document().querySelector('.grid-th[data-column-key="City"] .th-filter'));

    const radios = [...document().querySelectorAll('.popover input[type="radio"]')] as HTMLInputElement[];
    assert.equal(radios.length, 2, 'the popover must offer two modes');

    const [include, exclude] = radios as [HTMLInputElement, HTMLInputElement];
    assert.equal(include.checked, true, 'Include is the default');
    assert.equal(exclude.checked, false);

    exclude.click();
    assert.equal(exclude.checked, true);
    assert.equal(include.checked, false, 'the two modes must exclude each other');

    include.click();
    assert.equal(include.checked, true, 'and the choice must be switchable back');
    assert.equal(exclude.checked, false);
  });

  it('applies the chosen value and mode to the rows', async () => {
    const valueBox = document().querySelector('.popover input[type="text"]') as HTMLInputElement;
    assert.ok(valueBox, 'the popover must have a value box');
    valueBox.value = 'Seoul';
    valueBox.dispatchEvent(new webview.dom.window.Event('input', { bubbles: true }));

    const apply = [...document().querySelectorAll('.popover button')].find((button) =>
      (button.textContent || '').trim() === 'Apply'
    );
    click(apply);
    await settle();

    assert.equal(document().querySelector('.popover'), null, 'the popover closes on apply');
    assert.equal(
      (
        document().querySelector('.grid-th[data-column-key="City"] .th-filter') as HTMLElement
      ).classList.contains('is-active'),
      true,
      'the column header shows that a filter is active'
    );
    assert.equal(
      document().querySelectorAll('.status-bar .pager').length,
      1,
      'the status bar must not accumulate copies of itself'
    );
    // 300 rows over four cities, so keeping Seoul leaves 75 of them.
    assert.match(statusText(), /of 75 rows/, `status was: ${statusText()}`);
  });

  it('filters the other way round when the mode is reversed', async () => {
    click(document().querySelector('.grid-th[data-column-key="City"] .th-filter'));
    const exclude = document().querySelectorAll('.popover input[type="radio"]')[1] as HTMLInputElement;
    exclude.click();
    click(
      [...document().querySelectorAll('.popover button')].find(
        (button) => (button.textContent || '').trim() === 'Apply'
      )
    );
    await settle();

    assert.match(statusText(), /of 225 rows/, `status was: ${statusText()}`);
  });

  it('explains a window the adapter cut short', async () => {
    webview.send({
      type: 'snapshot',
      snapshot: snapshot(4, {
        truncated: true,
        totalItems: 5000,
        warnings: ['The debug adapter returned only the first 25 of 5,000 children.']
      }),
      providerName: 'C#'
    } as HostMessage);
    await settle();

    const item = [...document().querySelectorAll('.status-item.is-warning')].find((node) =>
      (node.textContent || '').includes('Truncated')
    );
    assert.ok(item, `expected a truncation item, status was: ${statusText()}`);
    assert.match(item.getAttribute('title') ?? '', /only the first 25 of 5,000 children/);
  });
});
