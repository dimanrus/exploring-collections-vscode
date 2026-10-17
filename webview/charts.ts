import type { CellValue, ColumnDescriptor, ColumnKind, RowDescriptor } from '../src/model/types';
import { clear, el, icon, svg } from './dom';

export type ChartType =
  | 'bar'
  | 'pie'
  | 'area'
  | 'line'
  | 'scatter'
  | 'bubble'
  | 'stock'
  | 'areaRange'
  | 'histogram';

export type Aggregation = 'none' | 'mean' | 'sum' | 'min' | 'max' | 'count' | 'first' | 'last';

export const CHART_TYPES: readonly ChartType[] = [
  'bar',
  'pie',
  'area',
  'line',
  'scatter',
  'bubble',
  'stock',
  'areaRange',
  'histogram'
];

export const AGGREGATIONS: readonly Aggregation[] = [
  'none',
  'mean',
  'sum',
  'min',
  'max',
  'count',
  'first',
  'last'
];

export interface ChartState {
  type: ChartType;
  xKey: string;
  yKeys: string[];
  groupKey: string;
  sizeKey: string;
  aggregation: Aggregation;
  showLegend: boolean;
  bins: number;
}

export function createDefaultChartState(columns: readonly ColumnDescriptor[]): ChartState {
  const usable = columns.filter((column) => column.key !== '#');
  const numeric = usable.filter((column) => column.kind === 'number');
  const categorical = usable.filter((column) => column.kind === 'string' || column.kind === 'boolean');
  const x = categorical[0] ?? usable[0];
  const y = numeric[0] ?? usable[1] ?? usable[0];
  return {
    type: 'bar',
    xKey: x?.key ?? '',
    yKeys: y && y.key !== x?.key ? [y.key] : [],
    groupKey: '',
    sizeKey: '',
    aggregation: 'count',
    showLegend: true,
    bins: 12
  };
}

export interface ChartLabels {
  settings: string;
  chartType: string;
  xAxis: string;
  yAxis: string;
  group: string;
  series: string;
  aggregation: string;
  exportPng: string;
  none: string;
  mean: string;
  sum: string;
  min: string;
  max: string;
  count: string;
  first: string;
  last: string;
  types: Record<ChartType, string>;
}

export interface ChartCallbacks {
  onStateChange(state: ChartState): void;
  onExportPng(svgMarkup: string, name: string): void;
}

export interface ChartOptions {
  state: ChartState;
  columns: readonly ColumnDescriptor[];
  rows: readonly RowDescriptor[];
  labels: ChartLabels;
  /** Title used for the exported image file name. */
  title: string;
  /** When false the settings panel is hidden. */
  interactive: boolean;
}

const PALETTE = [
  '#4f9df7',
  '#f7914f',
  '#4fd1a5',
  '#f75f7d',
  '#b28df7',
  '#f7d64f',
  '#4fd7f7',
  '#8dd14f',
  '#f74f9d',
  '#9da7b8'
];

const MARGIN = { top: 24, right: 24, bottom: 52, left: 64 };
const LEGEND_HEIGHT = 24;

interface ChartPoint {
  x: number;
  y: number;
  size: number;
  label: string;
  values: number[];
  rowIndex: number;
}

interface ChartSeries {
  name: string;
  points: ChartPoint[];
  color: string;
}

interface ChartModel {
  series: ChartSeries[];
  xKind: ColumnKind;
  categories: string[];
  yLabel: string;
  xLabel: string;
  /** Aggregated candle data for stock and areaRange charts. */
  candles: { x: number; label: string; open: number; high: number; low: number; close: number }[];
}

/** Renders the chart canvas plus its series settings. */
export class ChartView {
  private readonly settingsPanel: HTMLDivElement;
  private readonly surface: HTMLDivElement;
  private readonly root: HTMLDivElement;
  private lastModel: ChartModel | undefined;

  constructor(private readonly host: HTMLElement, private readonly callbacks: ChartCallbacks) {
    this.settingsPanel = el('div', { class: 'chart-settings' });
    this.surface = el('div', { class: 'chart-surface' });
    this.root = el('div', { class: 'chart-view' }, [this.settingsPanel, this.surface]);
    clear(host);
    host.appendChild(this.root);
  }

  /** Renders (or re-renders) the chart. */
  render(options: ChartOptions): void {
    const model = buildChartModel(options);
    this.lastModel = model;
    if (options.interactive) {
      this.renderSettings(options);
    } else {
      clear(this.settingsPanel);
    }
    this.renderSurface(options, model);
  }

  private renderSettings(options: ChartOptions): void {
    clear(this.settingsPanel);
    const { state, labels, columns } = options;
    const usable = columns.filter((column) => column.key !== '#');

    const typeSelect = buildSelect(
      labels.chartType,
      CHART_TYPES.map((type) => ({ value: type, label: labels.types[type] })),
      state.type
    );
    typeSelect.addEventListener('change', () => {
      this.callbacks.onStateChange({ ...state, type: typeSelect.value as ChartType });
    });
    this.settingsPanel.appendChild(typeSelect);

    const xSelect = buildSelect(
      labels.xAxis,
      usable.map((column) => ({
        value: column.key,
        label: `${column.title} (${column.kind})`
      })),
      state.xKey
    );
    xSelect.addEventListener('change', () => {
      this.callbacks.onStateChange({ ...state, xKey: xSelect.value });
    });
    this.settingsPanel.appendChild(xSelect);

    // A single Y column keeps the row of dropdowns readable; several series are
    // produced by choosing a group column instead of a list of Y columns.
    const ySelect = buildSelect(
      labels.yAxis,
      usable.map((column) => ({ value: column.key, label: `${column.title} (${column.kind})` })),
      state.yKeys[0] ?? ''
    );
    ySelect.addEventListener('change', () => {
      this.callbacks.onStateChange({ ...state, yKeys: ySelect.value ? [ySelect.value] : [] });
    });
    this.settingsPanel.appendChild(ySelect);

    const groupSelect = buildSelect(
      labels.group,
      [{ value: '', label: labels.none }, ...usable.map((column) => ({ value: column.key, label: column.title }))],
      state.groupKey
    );
    groupSelect.addEventListener('change', () => {
      this.callbacks.onStateChange({ ...state, groupKey: groupSelect.value });
    });
    this.settingsPanel.appendChild(groupSelect);

    const sizeSelect = buildSelect(
      labels.series,
      [
        { value: '', label: labels.none },
        ...usable
          .filter((column) => column.kind === 'number')
          .map((column) => ({ value: column.key, label: column.title }))
      ],
      state.sizeKey
    );
    sizeSelect.addEventListener('change', () => {
      this.callbacks.onStateChange({ ...state, sizeKey: sizeSelect.value });
    });
    this.settingsPanel.appendChild(sizeSelect);

    const aggregationSelect = buildSelect(
      labels.aggregation,
      AGGREGATIONS.map((aggregation) => ({ value: aggregation, label: aggregationLabel(aggregation, labels) })),
      state.aggregation
    );
    aggregationSelect.addEventListener('change', () => {
      this.callbacks.onStateChange({ ...state, aggregation: aggregationSelect.value as Aggregation });
    });
    this.settingsPanel.appendChild(aggregationSelect);

    const exportButton = el('button', { class: 'toolbar-button', type: 'button', title: labels.exportPng }, [
      icon('export', 14),
      el('span', {}, [labels.exportPng])
    ]);
    exportButton.addEventListener('click', () => {
      const markup = this.buildSvgMarkup();
      if (markup.length > 0) {
        this.callbacks.onExportPng(markup, `${sanitizeName(options.title)}-${options.state.type}`);
      }
    });
    this.settingsPanel.appendChild(exportButton);
  }

  private renderSurface(options: ChartOptions, model: ChartModel): void {
    clear(this.surface);
    if (model.series.length === 0 || model.series.every((series) => series.points.length === 0)) {
      this.surface.appendChild(el('div', { class: 'empty-hint' }, [options.labels.none]));
      return;
    }

    const width = Math.max(420, this.host.clientWidth - 8 || 720);
    const height = Math.max(260, Math.min(520, Math.round(width * 0.5)));
    const root = svg('svg', {
      class: 'chart-svg',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      xmlns: 'http://www.w3.org/2000/svg'
    });
    root.appendChild(svg('rect', { x: 0, y: 0, width, height, fill: 'transparent' }));

    const legendSpace = options.state.showLegend ? LEGEND_HEIGHT * Math.ceil(model.series.length / 4) : 0;
    const plot = {
      x: MARGIN.left,
      y: MARGIN.top,
      width: width - MARGIN.left - MARGIN.right,
      height: height - MARGIN.top - MARGIN.bottom - legendSpace
    };

    if (options.state.type === 'pie') {
      drawPie(root, model, { x: plot.x, y: plot.y, width: plot.width, height: plot.height });
    } else if (options.state.type === 'histogram') {
      drawHistogram(root, model, plot);
    } else if (options.state.type === 'stock') {
      drawStock(root, model, plot);
    } else if (options.state.type === 'areaRange') {
      drawAreaRange(root, model, plot);
    } else {
      drawCartesian(root, model, plot, options.state.type);
    }

    if (options.state.showLegend && model.series.length > 1) {
      root.appendChild(drawLegend(model, width, height - legendSpace + 4));
    }

    this.surface.appendChild(root);
    if (options.interactive) {
      this.surface.appendChild(this.buildTooltip());
    }
  }

  private buildTooltip(): HTMLElement {
    const tooltip = el('div', { class: 'chart-tooltip', hidden: true });
    const surface = this.surface;
    surface.addEventListener('mousemove', (event) => {
      const model = this.lastModel;
      if (!model) {
        return;
      }
      const target = event.target as SVGElement;
      const pointIndex = target.getAttribute?.('data-point');
      if (pointIndex === null || pointIndex === undefined) {
        tooltip.hidden = true;
        return;
      }
      const [seriesIndex, pointPosition] = pointIndex.split(':').map(Number);
      const series = model.series[seriesIndex as number];
      const point = series?.points[pointPosition as number];
      if (!series || !point) {
        tooltip.hidden = true;
        return;
      }
      clear(tooltip);
      tooltip.appendChild(el('div', { class: 'chart-tooltip-title' }, [point.label]));
      tooltip.appendChild(
        el('div', { class: 'chart-tooltip-row' }, [
          el('span', { class: 'chart-swatch', style: `background:${series.color}` }),
          el('span', {}, [`${series.name}: ${formatNumber(point.y)}`])
        ])
      );
      tooltip.hidden = false;
      const bounds = surface.getBoundingClientRect();
      tooltip.style.left = `${Math.min(event.clientX - bounds.left + 12, bounds.width - 180)}px`;
      tooltip.style.top = `${event.clientY - bounds.top + 12}px`;
    });
    surface.addEventListener('mouseleave', () => {
      tooltip.hidden = true;
    });
    return tooltip;
  }

  private buildSvgMarkup(): string {
    const node = this.surface.querySelector('svg');
    if (!node) {
      return '';
    }
    const clone = node.cloneNode(true) as SVGElement;
    clone.setAttribute('style', 'background:#ffffff');
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  }
}

function sanitizeName(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'chart';
}

function aggregationLabel(aggregation: Aggregation, labels: ChartLabels): string {
  switch (aggregation) {
    case 'none':
      return labels.none;
    case 'mean':
      return labels.mean;
    case 'sum':
      return labels.sum;
    case 'min':
      return labels.min;
    case 'max':
      return labels.max;
    case 'count':
      return labels.count;
    case 'first':
      return labels.first;
    default:
      return labels.last;
  }
}

function buildSelect(
  label: string,
  options: readonly { value: string; label: string }[],
  selected: string
): HTMLSelectElement {
  const select = el('select', { class: 'chart-select', title: label, ariaLabel: label });
  for (const option of options) {
    select.appendChild(
      el('option', { value: option.value, selected: option.value === selected }, [option.label])
    );
  }
  return select;
}

function numericValue(cell: CellValue | undefined): number | undefined {
  if (!cell) {
    return undefined;
  }
  if (typeof cell.raw === 'number') {
    return cell.raw;
  }
  if (cell.kind === 'date') {
    const parsed = Date.parse(cell.text.replace(' ', 'T'));
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const cleaned = cell.text.replace(/,/g, '').replace(/[fFdDmMlLuU]+$/, '');
  if (cleaned.length === 0) {
    return undefined;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

function aggregate(values: readonly number[], aggregation: Aggregation): number {
  if (values.length === 0) {
    return 0;
  }
  switch (aggregation) {
    case 'mean':
      return values.reduce((total, value) => total + value, 0) / values.length;
    case 'sum':
      return values.reduce((total, value) => total + value, 0);
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'count':
      return values.length;
    case 'first':
      return values[0] as number;
    case 'last':
      return values[values.length - 1] as number;
    default:
      return values[values.length - 1] as number;
  }
}

/** Builds the series model consumed by the drawing routines. */
export function buildChartModel(options: ChartOptions): ChartModel {
  const { state, columns, rows } = options;
  const indexOf = (key: string): number => columns.findIndex((column) => column.key === key);
  const xIndex = indexOf(state.xKey);
  const xColumn = xIndex >= 0 ? (columns[xIndex] as ColumnDescriptor) : undefined;
  const yIndexes = state.yKeys.map(indexOf).filter((index) => index >= 0);
  const groupIndex = state.groupKey ? indexOf(state.groupKey) : -1;
  const sizeIndex = state.sizeKey ? indexOf(state.sizeKey) : -1;

  const model: ChartModel = {
    series: [],
    xKind: xColumn?.kind ?? 'string',
    categories: [],
    yLabel: yIndexes.map((index) => (columns[index] as ColumnDescriptor).title).join(', '),
    xLabel: xColumn?.title ?? '',
    candles: []
  };
  if (xIndex < 0) {
    return model;
  }

  const categoryLabels = new Map<string, string>();
  const numericX = xColumn?.kind === 'number' || xColumn?.kind === 'date' || xColumn?.kind === 'index';

  // Histogram: bin the numeric X values.
  if (state.type === 'histogram') {
    const values: number[] = [];
    for (const row of rows) {
      const value = numericValue(row.cells[xIndex]);
      if (value !== undefined) {
        values.push(value);
      }
    }
    if (values.length > 0) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const bins = Math.max(2, Math.min(60, state.bins));
      const width = max === min ? 1 : (max - min) / bins;
      const counts = new Array<number>(bins).fill(0);
      for (const value of values) {
        const position = Math.min(bins - 1, Math.floor((value - min) / width));
        counts[position] = (counts[position] ?? 0) + 1;
      }
      const points: ChartPoint[] = counts.map((count, index) => {
        const from = min + index * width;
        const to = from + width;
        const label = `${formatNumber(from)}–${formatNumber(to)}`;
        return { x: index, y: count, size: count, label, values: [count], rowIndex: index };
      });
      model.categories = points.map((point) => point.label);
      model.series = [{ name: 'count', points, color: PALETTE[0] as string }];
    }
    return model;
  }

  // Group rows by series, then by X.
  const groups = new Map<string, Map<string, { label: string; values: number[]; size: number }>>();
  const groupOrder: string[] = [];
  const yKeys = yIndexes.length > 0 ? yIndexes : [xIndex];

  for (const row of rows) {
    const xCell = row.cells[xIndex];
    if (!xCell) {
      continue;
    }
    const xValue = numericX ? numericValue(xCell) : undefined;
    const xKey = numericX ? String(xValue ?? row.index) : xCell.text;
    const xDisplay = xCell.text;
    categoryLabels.set(xKey, xDisplay);

    let seriesNames: string[];
    if (groupIndex >= 0) {
      const groupCell = row.cells[groupIndex];
      seriesNames = [groupCell?.text ?? '(empty)'];
    } else if (yKeys.length === 1 && groupIndex < 0 && yKeys[0] === xIndex) {
      seriesNames = [xColumn?.title ?? 'value'];
    } else {
      seriesNames = yKeys.map((index) => (columns[index] as ColumnDescriptor).title);
    }

    for (const seriesName of seriesNames) {
      if (!groups.has(seriesName)) {
        groups.set(seriesName, new Map());
        groupOrder.push(seriesName);
      }
      const bucket = groups.get(seriesName) as Map<string, { label: string; values: number[]; size: number }>;
      const entry = bucket.get(xKey) ?? { label: xDisplay, values: [], size: 0 };
      if (groupIndex >= 0) {
        const yValue = numericValue(row.cells[yKeys[0] as number]);
        if (yValue !== undefined) {
          entry.values.push(yValue);
        }
      } else {
        const yValue = numericValue(row.cells[yKeys[seriesNames.indexOf(seriesName)] as number]);
        if (yValue !== undefined) {
          entry.values.push(yValue);
        }
      }
      if (sizeIndex >= 0) {
        const size = numericValue(row.cells[sizeIndex]);
        if (size !== undefined) {
          entry.size = Math.max(entry.size, size);
        }
      }
      bucket.set(xKey, entry);
    }
  }

  const xPositions = new Map<string, number>();
  const sortedKeys = [...categoryLabels.keys()];
  if (numericX) {
    sortedKeys.sort((left, right) => Number(left) - Number(right));
  }
  sortedKeys.forEach((key, position) => xPositions.set(key, position));
  model.categories = sortedKeys.map((key) => categoryLabels.get(key) ?? key);

  const aggregation = state.type === 'scatter' || state.type === 'bubble' ? 'none' : state.aggregation;

  groupOrder.forEach((seriesName, seriesPosition) => {
    const bucket = groups.get(seriesName);
    if (!bucket) {
      return;
    }
    const points: ChartPoint[] = [];
    for (const [xKey, entry] of bucket) {
      if (entry.values.length === 0 && aggregation !== 'count') {
        continue;
      }
      const x = xPositions.get(xKey) ?? 0;
      points.push({
        x: numericX ? Number(xKey) : x,
        y: aggregate(entry.values, aggregation),
        size: entry.size > 0 ? entry.size : 1,
        label: entry.label,
        values: [...entry.values],
        rowIndex: x
      });
    }
    points.sort((left, right) => left.x - right.x);
    model.series.push({
      name: seriesName,
      points,
      color: PALETTE[seriesPosition % PALETTE.length] as string
    });
  });

  if (state.type === 'stock' || state.type === 'areaRange') {
    const primary = model.series[0];
    if (primary) {
      model.candles = primary.points.map((point) => {
        const values = point.values.length > 0 ? point.values : [point.y];
        const sorted = [...values].sort((left, right) => left - right);
        return {
          x: point.x,
          label: point.label,
          open: values[0] as number,
          high: sorted[sorted.length - 1] as number,
          low: sorted[0] as number,
          close: values[values.length - 1] as number
        };
      });
    }
  }

  return model;
}

interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function niceTicks(min: number, max: number, target = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0];
  }
  if (min === max) {
    return [min];
  }
  const span = max - min;
  const rawStep = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks.length > 0 ? ticks : [min, max];
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2);
  }
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3).replace(/\.?0+$/, '');
}

function textNode(x: number, y: number, content: string, anchor = 'middle'): SVGTextElement {
  return svg(
    'text',
    {
      x,
      y,
      'text-anchor': anchor,
      'font-size': 11,
      fill: 'var(--vscode-descriptionForeground, #9aa4b2)'
    },
    [content]
  );
}

function drawAxes(
  root: SVGElement,
  plot: PlotArea,
  xLabels: readonly string[],
  yTicks: readonly number[],
  yMin: number,
  yMax: number,
  yTitle: string
): { toY: (value: number) => number; toX: (position: number) => number } {
  const span = yMax - yMin || 1;
  const toY = (value: number): number => plot.y + plot.height - ((value - yMin) / span) * plot.height;
  const count = Math.max(1, xLabels.length);
  const slot = plot.width / count;
  const toX = (position: number): number => plot.x + slot * (position + 0.5);

  for (const tick of yTicks) {
    const y = toY(tick);
    root.appendChild(
      svg('line', {
        x1: plot.x,
        y1: y,
        x2: plot.x + plot.width,
        y2: y,
        stroke: 'var(--vscode-panel-border, #333)',
        'stroke-dasharray': '3 3',
        'stroke-width': 1
      })
    );
    root.appendChild(textNode(plot.x - 8, y + 4, formatNumber(tick), 'end'));
  }

  root.appendChild(
    svg('line', {
      x1: plot.x,
      y1: plot.y + plot.height,
      x2: plot.x + plot.width,
      y2: plot.y + plot.height,
      stroke: 'var(--vscode-descriptionForeground, #777)'
    })
  );

  const maxLabels = Math.max(2, Math.floor(plot.width / 70));
  const step = Math.max(1, Math.ceil(count / maxLabels));
  for (let position = 0; position < count; position += step) {
    const label = xLabels[position] ?? '';
    const truncated = label.length > 12 ? `${label.slice(0, 11)}…` : label;
    root.appendChild(textNode(toX(position), plot.y + plot.height + 18, truncated));
  }

  if (yTitle.length > 0) {
    root.appendChild(
      svg('text', {
        x: 14,
        y: plot.y + plot.height / 2,
        'font-size': 11,
        fill: 'var(--vscode-descriptionForeground, #9aa4b2)',
        transform: `rotate(-90 14 ${plot.y + plot.height / 2})`,
        'text-anchor': 'middle'
      }, [yTitle.length > 24 ? `${yTitle.slice(0, 23)}…` : yTitle])
    );
  }

  return { toY, toX };
}

function drawCartesian(
  root: SVGElement,
  model: ChartModel,
  plot: PlotArea,
  type: 'bar' | 'area' | 'line' | 'scatter' | 'bubble'
): void {
  const numericX = model.xKind === 'number' || model.xKind === 'date';
  const allY = model.series.flatMap((series) => series.points.map((point) => point.y));
  const yMin = Math.min(0, ...allY);
  const yMax = Math.max(...allY, 1);
  const yTicks = niceTicks(yMin, yMax, 6);

  let xLabels: string[] = model.categories;
  let toX: (position: number) => number;

  if (numericX) {
    const xs = model.series.flatMap((series) => series.points.map((point) => point.x));
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs, xMin + 1);
    const span = xMax - xMin || 1;
    toX = (value: number) => plot.x + ((value - xMin) / span) * plot.width;
    const ticks = niceTicks(xMin, xMax, Math.max(2, Math.floor(plot.width / 90)));
    xLabels = ticks.map((tick) => formatNumber(tick));
  } else {
    const labels = model.categories;
    const slot = plot.width / Math.max(1, labels.length);
    toX = (position: number) => plot.x + slot * (position + 0.5);
    xLabels = labels;
  }

  const ctx = drawAxes(root, plot, xLabels, yTicks, yMin, yMax, model.yLabel);
  const toY = ctx.toY;

  if (numericX) {
    // For numeric axes the tick labels are not ordinal, so redraw the axis using values.
    const xs = model.series.flatMap((series) => series.points.map((point) => point.x));
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs, xMin + 1);
    const ticks = niceTicks(xMin, xMax, Math.max(2, Math.floor(plot.width / 90)));
    const span = xMax - xMin || 1;
    const valueToX = (value: number): number => plot.x + ((value - xMin) / span) * plot.width;
    toX = valueToX;
    for (const tick of ticks) {
      root.appendChild(textNode(valueToX(tick), plot.y + plot.height + 18, formatNumber(tick)));
    }
  }

  const groupCount = Math.max(1, model.series.length);
  const slot = numericX ? 0 : plot.width / Math.max(1, model.categories.length);

  model.series.forEach((series, seriesIndex) => {
    const barWidth = numericX ? 12 : Math.max(2, (slot * 0.7) / groupCount);
    const barOffset = numericX ? 0 : slot * 0.15 + barWidth * seriesIndex;

    if (type === 'bar') {
      for (let position = 0; position < series.points.length; position += 1) {
        const point = series.points[position] as ChartPoint;
        const x = numericX ? toX(point.x) - barWidth / 2 : plot.x + position * slot + barOffset;
        const y = toY(Math.max(0, point.y));
        const height = Math.abs(toY(0) - toY(point.y));
        root.appendChild(
          svg('rect', {
            x,
            y: Math.min(y, toY(0)),
            width: barWidth,
            height: Math.max(1, height),
            fill: series.color,
            'fill-opacity': 0.85,
            'data-point': `${seriesIndex}:${position}`,
            rx: 2
          })
        );
      }
      return;
    }

    if (type === 'area') {
      const bottom = toY(Math.max(0, yMin));
      const path = series.points
        .map((point, position) => `${position === 0 ? 'M' : 'L'} ${toX(point.x)} ${toY(point.y)}`)
        .join(' ');
      const first = series.points[0];
      const last = series.points[series.points.length - 1];
      if (first && last) {
        root.appendChild(
          svg('path', {
            d: `${path} L ${toX(last.x)} ${bottom} L ${toX(first.x)} ${bottom} Z`,
            fill: series.color,
            'fill-opacity': 0.25,
            stroke: 'none'
          })
        );
      }
      appendLine(root, series, toX, toY, seriesIndex);
      return;
    }

    if (type === 'line') {
      appendLine(root, series, toX, toY, seriesIndex);
      return;
    }

    // scatter and bubble
    const maxSize = Math.max(...series.points.map((point) => point.size), 1);
    series.points.forEach((point, position) => {
      const radius =
        type === 'bubble' ? 4 + Math.sqrt(point.size / maxSize) * 16 : 4;
      root.appendChild(
        svg('circle', {
          cx: toX(point.x),
          cy: toY(point.y),
          r: radius,
          fill: series.color,
          'fill-opacity': type === 'bubble' ? 0.45 : 0.85,
          stroke: series.color,
          'data-point': `${seriesIndex}:${position}`
        })
      );
    });
  });
}

function appendLine(
  root: SVGElement,
  series: ChartSeries,
  toX: (value: number) => number,
  toY: (value: number) => number,
  seriesIndex: number
): void {
  const path = series.points
    .map((point, position) => `${position === 0 ? 'M' : 'L'} ${toX(point.x)} ${toY(point.y)}`)
    .join(' ');
  root.appendChild(
    svg('path', {
      d: path,
      fill: 'none',
      stroke: series.color,
      'stroke-width': 2,
      'stroke-linejoin': 'round'
    })
  );
  series.points.forEach((point, position) => {
    root.appendChild(
      svg('circle', {
        cx: toX(point.x),
        cy: toY(point.y),
        r: 3,
        fill: series.color,
        'data-point': `${seriesIndex}:${position}`
      })
    );
  });
}

function drawPie(root: SVGElement, model: ChartModel, plot: PlotArea): void {
  const primary = model.series[0];
  if (!primary) {
    return;
  }
  const total = primary.points.reduce((sum, point) => sum + Math.abs(point.y), 0) || 1;
  const cx = plot.x + plot.width / 2;
  const cy = plot.y + plot.height / 2;
  const radius = Math.max(40, Math.min(plot.width, plot.height) / 2 - 24);

  let angle = -Math.PI / 2;
  primary.points.forEach((point, position) => {
    const slice = (Math.abs(point.y) / total) * Math.PI * 2;
    const end = angle + slice;
    const large = slice > Math.PI ? 1 : 0;
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(end);
    const y2 = cy + radius * Math.sin(end);
    root.appendChild(
      svg('path', {
        d: `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`,
        fill: PALETTE[position % PALETTE.length] as string,
        'fill-opacity': 0.9,
        stroke: 'var(--vscode-editor-background, #1e1e1e)',
        'stroke-width': 1,
        'data-point': `0:${position}`
      })
    );
    const mid = angle + slice / 2;
    if (slice > 0.25) {
      root.appendChild(
        textNode(
          cx + (radius * 0.66) * Math.cos(mid),
          cy + (radius * 0.66) * Math.sin(mid) + 4,
          `${point.label}`
        )
      );
    }
    angle = end;
  });
}

function drawHistogram(root: SVGElement, model: ChartModel, plot: PlotArea): void {
  const primary = model.series[0];
  if (!primary) {
    return;
  }
  const maxY = Math.max(...primary.points.map((point) => point.y), 1);
  const yTicks = niceTicks(0, maxY, 5);
  drawAxes(root, plot, [], yTicks, 0, maxY, 'count');

  const slot = plot.width / Math.max(1, primary.points.length);
  primary.points.forEach((point, position) => {
    const height = (point.y / maxY) * plot.height;
    root.appendChild(
      svg('rect', {
        x: plot.x + position * slot + 1,
        y: plot.y + plot.height - height,
        width: Math.max(1, slot - 2),
        height: Math.max(1, height),
        fill: primary.color,
        'fill-opacity': 0.85,
        'data-point': `0:${position}`
      })
    );
    if (position % Math.max(1, Math.ceil(primary.points.length / 8)) === 0) {
      root.appendChild(textNode(plot.x + position * slot + slot / 2, plot.y + plot.height + 18, point.label));
    }
  });
}

function drawStock(root: SVGElement, model: ChartModel, plot: PlotArea): void {
  if (model.candles.length === 0) {
    return;
  }
  const lows = model.candles.map((candle) => candle.low);
  const highs = model.candles.map((candle) => candle.high);
  const yMin = Math.min(...lows);
  const yMax = Math.max(...highs, yMin + 1);
  const yTicks = niceTicks(yMin, yMax, 5);
  const ctx = drawAxes(root, plot, model.categories, yTicks, yMin, yMax, model.yLabel);
  const toX = ctx.toX;
  const toY = ctx.toY;
  const candleWidth = Math.max(3, Math.min(18, plot.width / Math.max(1, model.candles.length) * 0.6));

  model.candles.forEach((candle, position) => {
    const x = toX(position);
    const rising = candle.close >= candle.open;
    const color = rising ? '#4fd1a5' : '#f75f7d';
    root.appendChild(
      svg('line', {
        x1: x,
        y1: toY(candle.high),
        x2: x,
        y2: toY(candle.low),
        stroke: color,
        'stroke-width': 1.5
      })
    );
    const top = toY(Math.max(candle.open, candle.close));
    const height = Math.max(1.5, Math.abs(toY(candle.open) - toY(candle.close)));
    root.appendChild(
      svg('rect', {
        x: x - candleWidth / 2,
        y: top,
        width: candleWidth,
        height,
        fill: color,
        'fill-opacity': 0.85,
        'data-point': `0:${position}`
      })
    );
  });
}

function drawAreaRange(root: SVGElement, model: ChartModel, plot: PlotArea): void {
  if (model.candles.length === 0) {
    return;
  }
  const yMin = Math.min(...model.candles.map((candle) => candle.low));
  const yMax = Math.max(...model.candles.map((candle) => candle.high), yMin + 1);
  const yTicks = niceTicks(yMin, yMax, 5);
  const ctx = drawAxes(root, plot, model.categories, yTicks, yMin, yMax, model.yLabel);
  const toX = ctx.toX;
  const toY = ctx.toY;

  const upper = model.candles.map((candle, position) => `${position === 0 ? 'M' : 'L'} ${toX(position)} ${toY(candle.high)}`).join(' ');
  const lower = [...model.candles]
    .reverse()
    .map((candle, position) => `L ${toX(model.candles.length - 1 - position)} ${toY(candle.low)}`)
    .join(' ');

  root.appendChild(
    svg('path', {
      d: `${upper} ${lower} Z`,
      fill: PALETTE[0] as string,
      'fill-opacity': 0.3,
      stroke: PALETTE[0] as string,
      'stroke-width': 1.5
    })
  );
  model.candles.forEach((candle, position) => {
    root.appendChild(
      svg('circle', {
        cx: toX(position),
        cy: toY(candle.high),
        r: 3,
        fill: PALETTE[0] as string,
        'data-point': `0:${position}`
      })
    );
    root.appendChild(
      svg('circle', {
        cx: toX(position),
        cy: toY(candle.low),
        r: 3,
        fill: PALETTE[0] as string,
        'data-point': `0:${position}`
      })
    );
  });
}

function drawLegend(model: ChartModel, width: number, y: number): SVGElement {
  const group = svg('g', {});
  let x = width / 2 - Math.min(model.series.length, 4) * 62;
  model.series.slice(0, 12).forEach((series, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const offsetX = width / 2 - 240 + column * 120;
    const offsetY = y + row * 16;
    group.appendChild(
      svg('rect', {
        x: offsetX,
        y: offsetY,
        width: 10,
        height: 10,
        fill: series.color,
        rx: 2
      })
    );
    group.appendChild(
      svg(
        'text',
        {
          x: offsetX + 16,
          y: offsetY + 9,
          'font-size': 11,
          fill: 'var(--vscode-descriptionForeground, #9aa4b2)'
        },
        [series.name.length > 14 ? `${series.name.slice(0, 13)}…` : series.name]
      )
    );
    x += 1;
  });
  void x;
  return group;
}
