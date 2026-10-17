import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * Renders the collection view into PNG files with a headless browser.
 *
 * The webview bundle ships with a preview bridge (`__EXPLORING_COLLECTIONS_PREVIEW__`)
 * exactly for this: it feeds the panel the same messages the extension host would
 * send and lets the real CSS and the real rendering code run outside VS Code.
 * The result can be used as the screenshots in the README.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = ['chromium-gost', 'chromium', 'google-chrome', 'chromium-browser'].find((name) =>
  ['/usr/bin', '/usr/local/bin', '/snap/bin'].some((dir) => existsSync(join(dir, name)))
);

if (!browser) {
  console.error('no Chromium based browser found; skipping the preview');
  process.exit(0);
}

const weather = () => {
  const cities = ['Seoul', 'Sofia', 'Mexico City', 'Cape Town', 'Brisbane', 'Houston', 'Lima'];
  const feels = (degree) => (degree < 10 ? 'cold' : degree > 20 ? 'warm' : 'normal');
  return Array.from({ length: 14 }, (_, index) => {
    const degree = 5 + ((index * 7) % 26);
    const date = new Date(Date.UTC(2026, 0, 12 - index));
    return {
      City: cities[index % cities.length],
      DegreeCelsius: degree,
      Date: date.toISOString().slice(0, 10),
      Feels: feels(degree)
    };
  });
};

const snapshot = (() => {
  const rows = weather();
  const columns = [
    { key: '#', title: '#', kind: 'index', path: [], nested: false },
    { key: 'City', title: 'City', kind: 'string', path: ['City'], nested: false },
    { key: 'DegreeCelsius', title: 'DegreeCelsius', kind: 'number', path: ['DegreeCelsius'], nested: false },
    { key: 'Date', title: 'Date', kind: 'date', path: ['Date'], nested: false },
    { key: 'Feels', title: 'Feels', kind: 'string', path: ['Feels'], nested: false }
  ];
  return {
    id: 'snap-preview',
    title: 'temperatures',
    expression: 'temperatures',
    sessionId: 'preview',
    sessionName: 'Preview',
    debugType: 'coreclr',
    language: 'csharp',
    providerId: 'csharp',
    capturedAt: Date.now(),
    columns,
    rows: rows.map((row, index) => ({
      index,
      label: `[${index}]`,
      cells: [
        { text: String(index), kind: 'index', isNull: false, expandable: false },
        { text: row.City, kind: 'string', isNull: false, expandable: false },
        { text: String(row.DegreeCelsius), kind: 'number', isNull: false, expandable: false },
        { text: row.Date, kind: 'date', isNull: false, expandable: false },
        { text: row.Feels, kind: 'string', isNull: false, expandable: false }
      ]
    })),
    totalItems: rows.length,
    truncated: false,
    warnings: [],
    diagnostics: {
      strategy: 'helper-native',
      durationMs: 12,
      requests: 3,
      reportedItemCount: rows.length,
      fallbackReasons: [],
      notes: ['Preview render, no debug session was started.']
    }
  };
})();

const viewState = {
  sort: { columnKey: 'DegreeCelsius', direction: 'desc' },
  search: '',
  filter: 'x => x.DegreeCelsius > 10',
  page: 0,
  pageSize: 100,
  hiddenColumns: [],
  columnOrder: null,
  columnFilters: {}
};

/** Clicks a toolbar button by its title, then the first column filter funnel. */
/** Selects the first row so the detail pane has something to show. */
const SELECT_ROW = `
          setTimeout(() => document.querySelector('.grid-td')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true })
          ), 300);
`;

/** Hides the table so the chart fills the view, which is the layout switch. */
const COLLAPSE_TABLE = `
          setTimeout(() => {
            const button = [...document.querySelectorAll('button')].find((candidate) =>
              (candidate.title || '').includes('table')
            );
            button?.click();
          }, 300);
`;

const OPEN_FILTER = `
          const clickByTitle = (title) => {
            const button = [...document.querySelectorAll('button')].find(
              (candidate) => (candidate.title || '').startsWith(title)
            );
            button?.click();
            return button;
          };
          clickByTitle('Local filter');
          setTimeout(() => document.querySelector('.th-filter')?.click(), 300);
`;

function page(command, script = '') {
  const css = readFileSync(join(root, 'media', 'collections.css'), 'utf8');
  const bundle = readFileSync(join(root, 'dist', 'webview.js'), 'utf8');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>${css}</style>
    <style>
      html, body { margin: 0; height: 100%; }
      .boot-script { display: none; }
    </style>
  </head>
  <body class="vscode-dark">
    <div id="app" class="app"></div>
    <script>
      const posted = [];
      const listeners = [];
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => posted.push(message),
        getState: () => undefined,
        setState: () => undefined
      });
      window.__EXPLORING_COLLECTIONS_PREVIEW__ = {
        postMessage: (message) => posted.push(message),
        onMessage: (listener) => listeners.push(listener)
      };
      window.addEventListener('load', () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener({
              type: 'init',
              snapshot: ${JSON.stringify(snapshot)},
              viewState: ${JSON.stringify(viewState)},
              settings: { pageSize: 100, enableCharts: true, maxDepth: 3, theme: 'dark' },
              providerName: 'C#'
            });
            ${command ? `listener({ type: 'command', command: ${JSON.stringify(command)} });` : ''}
          }
${script}
        }, 50);
      });
    </script>
    <script>${bundle}</script>
  </body>
</html>`;
}

function render(name, command, script = '') {
  const htmlPath = join(tmpdir(), `exploring-collections-${name}.html`);
  const imagePath = join(root, 'media', `screenshot-${name}.png`);
  writeFileSync(htmlPath, page(command, script), 'utf8');
  mkdirSync(dirname(imagePath), { recursive: true });

  execFileSync(
    browser,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--user-data-dir=${join(tmpdir(), 'exploring-collections-preview-profile')}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1360,860',
      '--virtual-time-budget=5000',
      `--screenshot=${imagePath}`,
      `file://${htmlPath}`
    ],
    { stdio: 'ignore' }
  );
  rmSync(htmlPath, { force: true });

  if (!existsSync(imagePath)) {
    throw new Error(`the browser did not produce ${imagePath}`);
  }
  console.log(`rendered ${imagePath}`);
}

render('table');
render('chart', 'chart');
render('filter', undefined, OPEN_FILTER);
render('details', undefined, SELECT_ROW);
render('collapsed', 'chart', COLLAPSE_TABLE);
